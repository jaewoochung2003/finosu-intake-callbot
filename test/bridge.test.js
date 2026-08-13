// bridge.test.js — the parts that only run on a real phone call.
//
// There is no Twilio account and no OpenAI account here, so both sockets are faked
// and driven with the exact JSON message shapes each side sends. That is not a
// substitute for one real call, and the README says so, but it does cover the state
// machine, which is where the failures that cost money live: digits landing in the
// wrong field, a tool call handled twice, an email sent twice or not at all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { handleCall } = require('../src/bridge');
const SCRIPTS = require('../tools/scripts');

const OPEN = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeSocket {
  constructor() {
    this.readyState = OPEN;
    this.sent = [];
    this.handlers = {};
  }
  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
    return this;
  }
  emit(event, ...args) {
    for (const fn of this.handlers[event] || []) fn(...args);
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  // What was sent, filtered by the field the two protocols use to name a message.
  ofType(type) {
    return this.sent.filter((m) => m.type === type);
  }
  ofEvent(event) {
    return this.sent.filter((m) => m.event === event);
  }
}

// Stands up one call with both sockets faked and returns everything a test needs
// to drive it.
function startCall({ callsDir, quietNudgeMs, quietEndMs, goodbyeMs, dtmfDeafMs = 0, dtmfSuppressMs = 0 } = {}) {
  const twilio = new FakeSocket();
  const openai = new FakeSocket();
  const emails = [];

  handleCall(twilio, {
    openaiApiKey: 'test',
    openWebSocket: () => openai,
    deliver: async (msg) => {
      emails.push(msg);
      return { sent: true, via: 'test', id: 'x' };
    },
    callsDir: callsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'callbot-')),
    // The window after a commit exists to swallow a stray extra press. These tests
    // type entries back to back with no wall clock between them, which is not what it
    // guards against, so it is off here and covered by its own test.
    dtmfDeafMs,
    dtmfSuppressMs,
    ...(quietNudgeMs ? { quietNudgeMs } : {}),
    ...(quietEndMs ? { quietEndMs } : {}),
    ...(goodbyeMs ? { goodbyeMs } : {}),
  });

  openai.emit('open');
  twilio.emit('message', JSON.stringify({ event: 'connected' }));
  twilio.emit(
    'message',
    JSON.stringify({
      event: 'start',
      start: {
        streamSid: 'MZtest',
        callSid: 'CAtest',
        customParameters: { from: '+16508629110' },
      },
      streamSid: 'MZtest',
    }),
  );

  let callId = 0;
  // A real turn is two events: the caller's audio comes back transcribed, and THEN
  // the model files it with save_answer. The helper used to send only the tool call,
  // which meant every test drove a path no phone call can produce, and the server had
  // no way to tell a filed answer from an invented one. It sends both now.
  const say = (answer) => {
    callId += 1;
    openai.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: String(answer),
      }),
    );
    openai.emit(
      'message',
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: `call_${callId}`,
        name: 'save_answer',
        arguments: JSON.stringify({ answer }),
      }),
    );
    return `call_${callId}`;
  };
  // The model filing an answer with no caller turn behind it, which is what
  // fabrication looks like on the wire.
  const saysNothingButModelSaves = (answer) => {
    callId += 1;
    openai.emit(
      'message',
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: `call_${callId}`,
        name: 'save_answer',
        arguments: JSON.stringify({ answer }),
      }),
    );
    return `call_${callId}`;
  };
  const press = (digits) => {
    for (const d of String(digits)) {
      twilio.emit(
        'message',
        JSON.stringify({ event: 'dtmf', streamSid: 'MZtest', dtmf: { digit: d } }),
      );
    }
  };
  const hangUp = () =>
    twilio.emit(
      'message',
      JSON.stringify({ event: 'stop', streamSid: 'MZtest', stop: { callSid: 'CAtest' } }),
    );

  // The last function_call_output the bridge sent back, parsed.
  const lastToolResult = () => {
    const outs = openai.sent.filter((m) => m.item && m.item.type === 'function_call_output');
    return outs.length ? JSON.parse(outs[outs.length - 1].item.output) : null;
  };

  return { twilio, openai, emails, say, saysNothingButModelSaves, press, hangUp, lastToolResult };
}

// ---------- opening ----------

t('the session is configured and the greeting is asked for', () => {
  const { openai } = startCall();
  const update = openai.ofType('session.update')[0];
  assert.ok(update, 'no session.update sent');
  assert.strictEqual(update.session.audio.input.format.type, 'audio/pcmu');
  assert.strictEqual(update.session.audio.output.format.type, 'audio/pcmu');
  assert.deepStrictEqual(
    update.session.tools.map((x) => x.name).sort(),
    ['end_call', 'redo_previous', 'save_answer'],
  );
  const greet = openai.ofType('response.create')[0];
  assert.match(greet.response.instructions, /Thanks for calling Finosu/);
  assert.match(greet.response.instructions, /first name/);
});

// ---------- audio ----------

t('caller audio is forwarded to the model untouched', () => {
  const { twilio, openai } = startCall();
  twilio.emit(
    'message',
    JSON.stringify({ event: 'media', streamSid: 'MZtest', media: { payload: 'AAAA' } }),
  );
  const appended = openai.ofType('input_audio_buffer.append');
  assert.strictEqual(appended.length, 1);
  assert.strictEqual(appended[0].audio, 'AAAA');
});

t('model audio is forwarded to Twilio with a mark behind it', () => {
  const { twilio, openai } = startCall();
  openai.emit(
    'message',
    JSON.stringify({ type: 'response.output_audio.delta', delta: 'BBBB' }),
  );
  const media = twilio.ofEvent('media');
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0].media.payload, 'BBBB');
  assert.strictEqual(media[0].streamSid, 'MZtest');
  assert.strictEqual(twilio.ofEvent('mark').length, 1);
});

// The bot is deaf until its line finishes. On a speakerphone it hears its own voice,
// and honoring that as a barge-in cleared the queued audio and dropped "Is that
// right?" off the end of a read-back. While the line is still generating, a
// speech_started is ignored — no clear, no cancel.
t('the bot is not interrupted while it is still speaking its line', async () => {
  const { twilio, openai } = startCall();
  openai.emit('message', JSON.stringify({ type: 'response.created' }));
  openai.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'BBBB' }));
  await sleep(750); // well past the old grace window; still no interruption
  openai.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  assert.strictEqual(twilio.ofEvent('clear').length, 0);
  assert.strictEqual(openai.ofType('response.cancel').length, 0);
});

// Line hiss at the moment the bot opens its mouth was reading as an interruption,
// and each one dropped the audio already queued at the carrier, so every sentence
// stopped halfway through.
t('noise in the first moment of a line is not an interruption', () => {
  const { twilio, openai } = startCall();
  openai.emit('message', JSON.stringify({ type: 'response.created' }));
  openai.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'BBBB' }));
  openai.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  assert.strictEqual(twilio.ofEvent('clear').length, 0);
});

// Audio the carrier is still playing after the model finished generating is the tail
// of the current line — the read-back's "Is that right?" lives right here. A caller
// noise while it plays must not clear it, and since nothing is generating no cancel is
// sent either (a cancel with nothing active is an API error that used to spam the log).
t('the tail still playing after the line is generated is not cut', async () => {
  const { twilio, openai } = startCall();
  openai.emit('message', JSON.stringify({ type: 'response.created' }));
  openai.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'BBBB' }));
  openai.emit('message', JSON.stringify({ type: 'response.done', response: { output: [] } }));
  await sleep(750);
  openai.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  assert.strictEqual(twilio.ofEvent('clear').length, 0, 'the queued tail must keep playing');
  assert.strictEqual(openai.ofType('response.cancel').length, 0);
});

t('nothing is sent to Twilio before the stream has started', () => {
  const twilio = new FakeSocket();
  const openai = new FakeSocket();
  handleCall(twilio, { openaiApiKey: 'test', openWebSocket: () => openai, deliver: async () => ({}) });
  openai.emit('open');
  openai.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'BBBB' }));
  assert.strictEqual(twilio.sent.length, 0);
});

// ---------- tool calls ----------

t('an answer comes back as a tool output and the next line to say', () => {
  const { openai, say, lastToolResult } = startCall();
  say('Gabriel');
  const out = openai.sent.filter((m) => m.item && m.item.type === 'function_call_output');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].item.call_id, 'call_1');
  const r = lastToolResult();
  assert.strictEqual(r.accepted, true);
  assert.match(r.say_next, /last name/);
  // the whole name is read back once the second half lands
  say('Kim');
  assert.match(lastToolResult().say_next, /Okay, Gabriel Kim\. That's[\s.]+g[\s.]+a[\s.]+b[\s.]+r[\s.]+i[\s.]+e[\s.]+l[\s.]+k[\s.]+i[\s.]+m\. Is that right\?/);
  say('yes');
  assert.match(lastToolResult().say_next, /email address/);
  // and the model is told to speak again
  assert.ok(openai.ofType('response.create').length >= 2);
});

t('the same call_id arriving twice is answered once', () => {
  const { openai } = startCall();
  const dup = {
    type: 'response.function_call_arguments.done',
    call_id: 'call_dup',
    name: 'save_answer',
    arguments: JSON.stringify({ answer: 'Gabriel Kim' }),
  };
  openai.emit('message', JSON.stringify(dup));
  // response.done carries the same call again, which is what the API actually does
  openai.emit(
    'message',
    JSON.stringify({
      type: 'response.done',
      response: {
        output: [
          { type: 'function_call', call_id: 'call_dup', name: 'save_answer', arguments: dup.arguments },
        ],
      },
    }),
  );
  const outs = openai.sent.filter((m) => m.item && m.item.item_dup !== true && m.item.type === 'function_call_output');
  assert.strictEqual(outs.length, 1, 'the duplicate produced a second tool output');
});

t('a bad answer comes back with the reason, not a blank re-ask', () => {
  const { say, lastToolResult } = startCall();
  say('mmm'); // nothing a name could be built from
  const r = lastToolResult();
  assert.strictEqual(r.accepted, false);
  assert.match(r.problem, /did not catch a first name/);
});

// The four values nothing else can check are read back and waited on: a name and an
// email have no checksum, an account number has no check digit, and a routing number
// can pass every check and still belong to the wrong bank.
t('the fields nothing can check are read back and wait for a yes', () => {
  const { say, lastToolResult } = startCall();
  say('Gabriel');
  say('Kim');
  assert.match(lastToolResult().say_next, /Is that right\?$/);
  say('yes');
  say('gabriel at finosu dot com');
  assert.match(lastToolResult().say_next, /g[\s.]+a[\s.]+b[\s.]+r[\s.]+i[\s.]+e[\s.]+l, at finosu dot com\. Is that right\?$/);
  // a no sends it back to the same question, spelled this time
  say('no');
  assert.match(lastToolResult().say_next, /Spell out the whole address/);
});

tKeypad('the tones of a half-typed number are never filed as the answer', () => {
  // The model hears touch tones as audio and writes them down as words. Only the
  // moment after a committed entry was covered, so a caller typing while the question
  // was still playing had the tones transcribed mid-entry and saved: on a live call
  // "473" went in as the apartment number and then as the city, while the digits it
  // was made of were still being typed.
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.routing);
  call.press('0210');                  // mid-entry, nothing committed yet
  call.say('zero two one zero');       // the model writing down the tones it heard
  const r = call.lastToolResult();
  assert.strictEqual(r.accepted, false);
  assert.match(r.problem, /keypad/i, 'tones were filed as the answer');
  // The rest of the number still lands and the entry is whole. A keypad commit speaks
  // directly rather than answering a tool call, so the read-back is in what the server
  // asked the model to say, not in a tool result.
  call.press('00021');
  const spoken = call.openai.ofType('response.create').map((m) => m.response.instructions).join(' ');
  assert.match(spoken, /Is that right/i, 'the completed keypad entry was not read back');
});

tKeypad('finishing a keypad entry mid-line never cancels the model', () => {
  // A caller typing the routing number while the question was still playing hit the
  // ninth digit and the read-back went out with cancelFirst, cutting the model off.
  // The model treats that as something to recover from and writes itself extra lines,
  // which land on top of the digits. The obsolete line is silenced instead, and the
  // read-back waits for it to finish rather than racing it.
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.routing);
  call.openai.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'r_question' } }));
  const before = call.openai.ofType('response.create').length;

  call.press('021000021'); // the whole number, typed while that line is still running

  assert.strictEqual(call.openai.ofType('response.cancel').length, 0, 'the model was cancelled');
  assert.strictEqual(
    call.openai.ofType('response.create').length,
    before,
    'a second response was created while one was running',
  );
  // The obsolete audio is dropped so the caller stops hearing the old question.
  assert.ok(call.twilio.ofEvent('clear').length > 0, 'the stale line kept playing');

  // Once that line finishes, the read-back goes out.
  call.openai.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'r_question', output: [] } }));
  const spoken = call.openai.ofType('response.create').map((m) => m.response.instructions).join(' ');
  assert.match(spoken, /Is that right/i, 'the read-back never went out');
});

t('the mic opens on the tail of the line, not after its last byte', () => {
  // People answer on the last syllable. A mic that waited for the final mark clipped
  // the front of the reply or lost it, and the caller repeated themselves into a bot
  // that had already moved on. About 100ms of audio may still be playing when they
  // are let in.
  const { twilio, openai } = startCall();
  const frame = (bytes) => 'A'.repeat(Math.ceil((bytes * 4) / 3));
  openai.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'r1' } }));
  // Two chunks queued: 4000 bytes (half a second) and then 400 bytes (50ms).
  openai.emit('message', JSON.stringify({ type: 'response.output_audio.delta', response_id: 'r1', delta: frame(4000) }));
  openai.emit('message', JSON.stringify({ type: 'response.output_audio.delta', response_id: 'r1', delta: frame(400) }));
  openai.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'r1', output: [] } }));

  // Half a second still to play: the caller is not heard yet.
  twilio.emit('message', JSON.stringify({ event: 'media', streamSid: 'MZtest', media: { payload: 'CCCC' } }));
  assert.strictEqual(openai.ofType('input_audio_buffer.append').length, 0, 'mic opened too early');

  // The big chunk finishes; only the 50ms tail is left, which is inside the lead.
  twilio.emit('message', JSON.stringify({ event: 'mark', streamSid: 'MZtest', mark: { name: 'chunk' } }));
  twilio.emit('message', JSON.stringify({ event: 'media', streamSid: 'MZtest', media: { payload: 'DDDD' } }));
  assert.strictEqual(
    openai.ofType('input_audio_buffer.append').length,
    1,
    'mic stayed shut through the tail of the line',
  );
});

t('only the line the server asked for is played to the caller', () => {
  // Server VAD creates a response of its own every time the caller stops talking, and
  // the model both calls save_answer in it and says whatever it likes, since nobody
  // has handed it a line yet. Playing that alongside the server's line put two bot
  // turns back to back and out of order, and is where the invented bank lookup and
  // the line about seeing a document came from.
  const { twilio, openai } = startCall();
  // The greeting: speak() asked for it, so this response is ours.
  openai.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp_ours' } }));
  openai.emit(
    'message',
    JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_ours', delta: 'AAAA' }),
  );
  assert.strictEqual(twilio.ofEvent('media').length, 1, 'the server line was not played');

  // The model talking on its own initiative, in a response nobody asked for.
  openai.emit(
    'message',
    JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_theirs', delta: 'BBBB' }),
  );
  assert.strictEqual(twilio.ofEvent('media').length, 1, 'unprompted model audio reached the caller');

  // And once our line has finished, so its id is no longer being tracked. This is the
  // gap the model's own response used to arrive in, and where the caller heard "I'm
  // ready for the next step" out of nowhere.
  openai.emit(
    'message',
    JSON.stringify({ type: 'response.done', response: { id: 'resp_ours', output: [] } }),
  );
  openai.emit(
    'message',
    JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_later', delta: 'CCCC' }),
  );
  assert.strictEqual(
    twilio.ofEvent('media').length,
    1,
    'unprompted audio played in the gap between two server lines',
  );
});

t('an unknown tool name does not throw', () => {
  const { openai } = startCall();
  assert.doesNotThrow(() =>
    openai.emit(
      'message',
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call_x',
        name: 'nonsense',
        arguments: '{}',
      }),
    ),
  );
});

// ---------- keypad ----------

// Walks the call to a named field by answering everything before it.
// Plays the canned answers up to `index`. The canned script carries the read-back
// confirmations as turns of their own, so this walks the same path a caller does.
// Four questions take digits and nothing else, so a caller reaches them by typing.
// The canned script holds those answers as spoken words, which is right for the
// offline harness driving intake directly, and wrong on a live call where the bridge
// refuses speech on those fields.
const TYPED = {
  [SCRIPTS.INDEX.ssn]: '4821',
  [SCRIPTS.INDEX.routing]: '021000021',
  [SCRIPTS.INDEX.account]: '5512340987#',
  [SCRIPTS.INDEX.zip]: '94404',
};

// With the keypad off those same four questions are answered out loud, so the walk
// says the digits instead of typing them. Both modes are real; this is what lets one
// suite drive either.
const KEYPAD_ON = process.env.KEYPAD !== 'off';

function playTurn(call, i) {
  if (!TYPED[i]) return call.say(SCRIPTS.APPROVED[i]);
  if (KEYPAD_ON) return call.press(TYPED[i]);
  call.say(TYPED[i].replace('#', ''));
}

function walkTo(call, index) {
  for (let i = 0; i < index; i++) playTurn(call, i);
}

function playAll(call) {
  for (let i = 0; i < SCRIPTS.APPROVED.length; i++) playTurn(call, i);
}

tKeypad('typed digits fill a digit field and skip speech entirely', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.ssn);
  call.press('4821');
  const spoken = call.openai.ofType('response.create');
  assert.ok(spoken.some((m) => /routing number/i.test(m.response?.instructions || '')));
});

t('keypad presses on a question that is not a number are ignored', () => {
  const call = startCall(); // sitting on the name question
  call.press('1234');
  assert.strictEqual(call.twilio.ofEvent('clear').length, 0);
});

tKeypad('the hash key submits a short entry early', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.account);
  call.press('5512340987#');
  call.say('yes'); // the account number is read back
  const said = call.openai
    .ofType('response.create')
    .map((m) => m.response?.instructions || '')
    .join(' ');
  assert.match(said, /street address/i);
});

tKeypad('the star key clears the buffer instead of submitting it', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.ssn);
  call.press('48*');
  const said = call.openai
    .ofType('response.create')
    .map((m) => m.response?.instructions || '')
    .join(' ');
  assert.match(said, /Cleared/);
});

tKeypad('the first keypress stops the bot talking', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.ssn);
  call.openai.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'B' }));
  const before = call.twilio.ofEvent('clear').length;
  call.press('4');
  assert.strictEqual(call.twilio.ofEvent('clear').length, before + 1);
});

tKeypad('an extra digit on a full field does not start a buffer on the next one', async () => {
  // This is the one test that exercises the deaf window, so it runs with it on.
  const call = startCall({ dtmfDeafMs: 300 });
  walkTo(call, SCRIPTS.INDEX.ssn);
  call.press('48215'); // one too many for a four digit field
  await sleep(400); // past the keypad deaf window, which is shorter than a question
  call.say('yes'); // the social has its own read-back now
  // The routing number question is next and must not be holding a stray "5".
  call.press('021000021');
  const said = call.openai
    .ofType('response.create')
    .map((m) => m.response?.instructions || '')
    .join(' ');
  assert.match(said, /JPMORGAN CHASE/i, 'the routing number did not land cleanly');
});

tKeypad('while digits are being typed the keypad owns the question', () => {
  // Nothing the model reports may be saved against a question with a live entry on
  // it. This was once a comparison — refuse the save only if its digits match the
  // buffer — and transcription lags the tones, so the model reported four digits while
  // three were buffered, the comparison missed, and the answer was filed. The form
  // advanced under a live entry and the caller's four typed digits went nowhere.
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.ssn);
  call.press('48');                       // mid-entry
  call.say('four eight two one');         // the model reporting the tones, running ahead
  const r = call.lastToolResult();
  assert.strictEqual(r.accepted, false);
  assert.match(r.problem, /keypad/i, 'a save landed on a question with a live entry');
  assert.match(r.say_next, /social security/i, 'the form advanced under the entry');

  // The rest of the digits complete the entry against the question they started on.
  call.press('21');
  const spoken = call.openai.ofType('response.create').map((m) => m.response.instructions).join(' ');
  assert.match(spoken, /routing number/i, 'the completed entry did not move the form on');
});

tKeypad('star clears a half-typed entry and the caller types it again', () => {
  // The way out for somebody who fumbles a digit. Speaking is not the way out on
  // these four questions, because they take the keypad and nothing else, so star
  // wipes the entry and the next press starts a fresh one.
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.routing);
  call.press('0219');   // a wrong digit
  call.press('*');
  call.press('021000021');
  const said = call.openai.ofType('response.create').map((m) => m.response.instructions).join(' ');
  assert.match(said, /Is that right/i, 'the retyped number did not land');
  assert.doesNotMatch(said, /0[\s.]+2[\s.]+1[\s.]+9/, 'the cleared digits survived');
});

// ---------- end of call ----------

t('hanging up writes the record and sends exactly one email', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callbot-'));
  const call = startCall({ callsDir: dir });
  playAll(call);
  call.hangUp();
  call.twilio.close(); // a real hangup fires both
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(call.emails.length, 1, `sent ${call.emails.length} emails`);
  assert.match(call.emails[0].subject, /Gabriel Kim/);
  assert.match(call.emails[0].subject, /Approved/);

  const files = fs.readdirSync(dir);
  assert.deepStrictEqual(files, ['CAtest.json']);
  const written = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.strictEqual(written.decision.outcome, 'Approved');
  assert.strictEqual(written.call.from, '+16508629110');
  assert.ok(written.capture_metrics.per_field.length > 20);
});

t('hanging up mid-call still reports, as Incomplete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callbot-'));
  const call = startCall({ callsDir: dir });
  call.say('Gabriel');
  call.say('Kim');
  call.say('yes');
  call.say('gabriel at finosu dot com');
  call.say('yes');
  call.hangUp();
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(call.emails.length, 1);
  assert.match(call.emails[0].subject, /Incomplete/);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'CAtest.json'), 'utf8'));
  assert.strictEqual(written.application.applicant.name, 'Gabriel Kim');
  assert.strictEqual(written.decision.outcome, 'Incomplete');
});

t('a declined call closes itself without waiting for a hangup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callbot-'));
  const call = startCall({ callsDir: dir });
  for (const line of SCRIPTS.savings.turns) call.say(line);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(call.emails.length, 1);
  assert.match(call.emails[0].subject, /Declined/);
});

t('the socket closing twice does not send a second email', async () => {
  const call = startCall();
  call.say('Gabriel Kim');
  call.hangUp();
  call.twilio.close();
  call.hangUp();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(call.emails.length, 1);
});

// ---------- what reaches the log ----------

t('the caller transcript is redacted against the open question', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.ssn);
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    call.openai.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'four eight two one',
      }),
    );
  } finally {
    console.log = realLog;
  }
  const printed = lines.join('\n');
  assert.ok(printed.includes('caller:'), printed);
  assert.ok(!/\b(four|eight|two|one)\b/i.test(printed), `digits reached the log: ${printed}`);
});

t('an ordinary answer is still readable in the log', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.email);
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    call.openai.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'gabriel at finosu dot com',
      }),
    );
  } finally {
    console.log = realLog;
  }
  assert.ok(lines.join('\n').includes('gabriel at finosu dot com'));
});

// ---------- hanging up is the server's call, not the model's ----------
// On the first end-to-end call with real audio the model called end_call, reason
// "caller refused to continue with providing the email address", after the caller
// had said one word: "no", answering the deployed-military question. The call ended
// eight fields in and the report went out empty. The caller's own words now decide.

function hears(call, transcript) {
  call.openai.emit(
    'message',
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript,
    }),
  );
}

function endCall(call, reason) {
  call.openai.emit(
    'message',
    JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: `end_${Math.random().toString(36).slice(2)}`,
      name: 'end_call',
      arguments: JSON.stringify({ reason }),
    }),
  );
}

t('end_call is refused when the caller only answered no', () => {
  const call = startCall();
  call.say('Gabriel');
  call.say('Kim');
  call.say('yes'); // the name read-back
  hears(call, 'No.');
  endCall(call, 'caller refused to continue');
  const r = call.lastToolResult();
  assert.strictEqual(r.accepted, false);
  // The call is still going, on the question it was already on. The refusal used to
  // stop there and throw the turn away; the caller's word now goes through the normal
  // turn instead, so "No." is treated as a failed answer to the open question rather
  // than vanishing. Either way the call must not end and no report may go out.
  assert.match(r.say_next, /email/i);
  assert.strictEqual(call.emails.length, 0, 'a refused end_call must not send the report');
});

t('a refused end_call records the turn instead of losing it', () => {
  // Reaching for end_call instead of save_answer used to cost the caller their turn:
  // the hang-up was refused and the words were dropped, so the bot asked the same
  // question again with nothing recorded.
  const call = startCall();
  call.say('Gabriel');
  call.say('Kim');
  call.say('yes');
  hears(call, 'gabriel at finosu dot com');
  endCall(call, 'caller sounded finished');
  assert.strictEqual(call.emails.length, 0, 'a refused end_call must not send the report');
  const r = call.lastToolResult();
  assert.ok(/is that right/i.test(r.say_next), `the address was not captured: ${r.say_next}`);
});

t('end_call goes through when the caller asks to stop', () => {
  const call = startCall();
  call.say('Gabriel');
  call.say('Kim');
  call.say('yes');
  hears(call, 'Actually can you call me back later');
  endCall(call, 'caller asked to be called back');
  const r = call.lastToolResult();
  assert.strictEqual(r.done, true);
});

// ---------- the words the bot says are the server's words ----------
// A caller talking over the bot cancels the response that the save_answer call was
// riding in, so the answer never reaches the server while the model goes on as if it
// had. The model then asks the next question, the server files the reply under the
// last one, and the two never meet again. Every line after a tool call is dictated.

t('the next question is handed to the model, not left to it', () => {
  const { openai, say } = startCall();
  say('Gabriel');
  say('Kim');
  say('yes');
  const spoken = openai.ofType('response.create').pop();
  assert.ok(spoken.response && spoken.response.instructions, 'the model was left to improvise');
  assert.match(spoken.response.instructions, /email address/);
});

t('a rejected answer is re-asked in the server\'s words, with the problem', () => {
  const { openai, say } = startCall();
  say('Gabriel');
  say('Kim');
  say('yes'); // the name read-back
  say('that is not an email');
  const spoken = openai.ofType('response.create').pop();
  assert.match(spoken.response.instructions, /did not come through as an email/);
  assert.match(spoken.response.instructions, /email address/);
});


// ---------- silence is not an answer ----------
// Speech recognition writes "Thank you." when it is handed line noise, and the model
// passed that on as the applicant's name. Nothing was said, so nothing is recorded
// and the question is asked again.

t('a save that came from silence is ignored, and the question stands', () => {
  const call = startCall();
  for (const phantom of ['Thank you.', 'Bye.', 'Thanks for watching!', 'you']) {
    call.say(phantom);
    const r = call.lastToolResult();
    assert.strictEqual(r.accepted, false, phantom);
    assert.match(r.say_next, /first name/, phantom);
  }
  // and a real answer to the same question still lands
  call.say('Gabriel');
  call.say('Kim');
  const ok = call.lastToolResult();
  assert.strictEqual(ok.accepted, true);
  assert.match(ok.say_next, /Is that right\?$/);
  call.say('yes');
  assert.match(call.lastToolResult().say_next, /email address/);
});

// ---------- a caller who stops talking ----------
// Nothing ended a silent call. A caller who put the phone down held an open line and
// a paid model session until the process was killed, and one who simply went quiet
// heard nothing back, on a live call, for two minutes.

t('a quiet line gets asked once, then let go', async () => {
  const call = startCall({ quietNudgeMs: 60, quietEndMs: 200, goodbyeMs: 20 });
  const spoken = () =>
    call.openai
      .ofType('response.create')
      .map((m) => m.response?.instructions || '')
      .join(' ');

  await sleep(200);
  assert.match(spoken(), /Are you still there\?/);
  await sleep(400);
  assert.match(spoken(), /let you go/);
  await sleep(120);
  assert.strictEqual(call.emails.length, 1, 'the form so far still goes out');
});

t('a caller who is talking is never nudged', async () => {
  const call = startCall({ quietNudgeMs: 120, quietEndMs: 400 });
  for (let i = 0; i < 6; i++) {
    call.openai.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await sleep(40);
  }
  const spoken = call.openai
    .ofType('response.create')
    .map((m) => m.response?.instructions || '')
    .join(' ');
  assert.ok(!/still there/.test(spoken), spoken);
});

tKeypad('typing counts as being there', async () => {
  const call = startCall({ quietNudgeMs: 120, quietEndMs: 400, goodbyeMs: 20 });
  walkTo(call, SCRIPTS.INDEX.ssn);
  for (const d of '4821') {
    call.press(d);
    await sleep(50);
  }
  const spoken = call.openai
    .ofType('response.create')
    .map((m) => m.response?.instructions || '')
    .join(' ');
  assert.ok(!/still there/.test(spoken), 'nudged a caller who was typing');
});

// ---------- the read-back, and the four ways it was being destroyed ----------
//
// Every one of these passed a full suite while a clean call — no mistakes, no
// corrections, every answer valid — could not be finished. The suite drove the
// keypad and the model in tidy alternation, and the failures all live in the
// overlap: the moment a keypad entry commits, the model is still talking, and its
// own write-down of the touch tones is on its way in.

// The model hears the tones and can transcribe them. That transcript used to reach
// intake as the caller's reply to "is that right?", because the guard that refuses
// saves inside the keypad window stood down whenever a read-back was open. Nine
// digits of tone noise then answered a yes-or-no question: the read-back was spent,
// the caller never got to confirm, and the same nine digits were asked for again.
tKeypad('the tones the model writes down do not answer the read-back they caused', async () => {
  const call = startCall({ dtmfSuppressMs: 2500 });
  walkTo(call, SCRIPTS.INDEX.routing);
  call.press('021000021');
  // The model's transcription of what it just heard, arriving right behind the commit.
  call.say('zero two one zero zero zero zero two one');
  const result = call.lastToolResult();
  assert.ok(!result.accepted, 'the tones were taken as an answer');
  // The read-back is still the question on the table, so the caller's yes still lands.
  call.say('yes');
  const spoken = call.openai
    .ofType('response.create')
    .map((m) => m.response?.instructions || '')
    .join(' ');
  assert.ok(/account number/i.test(spoken), 'the call never reached the account number');
});

// The same, one step further on: the account number is the field the caller was
// being sent back to type a routing number into.
tKeypad('a clean keypad run reaches the end of the bank block', () => {
  const call = startCall({ dtmfSuppressMs: 2500 });
  // The line the server last asked for, played through to the end. This is what
  // separates the model's write-down of the tones from the caller's answer: the
  // caller cannot have replied to a line that has not been spoken yet.
  // A read-back goes out as two lines now — the value, then the question — so this
  // drains until nothing more is waiting behind them.
  let n = 0;
  const lineIsSpoken = () => {
    for (let guard = 0; guard < 6; guard++) {
      const asked = call.openai.ofType('response.create');
      const before = asked.length;
      const meta = asked[before - 1]?.response?.metadata;
      const id = `r_${n++}`;
      call.openai.emit('message', JSON.stringify({ type: 'response.created', response: { id, metadata: meta } }));
      call.openai.emit('message', JSON.stringify({ type: 'response.done', response: { id } }));
      if (call.openai.ofType('response.create').length === before) return;
    }
  };

  walkTo(call, SCRIPTS.INDEX.ssn);
  call.press('4821');
  call.say('four eight two one');           // the model writing down the tones
  lineIsSpoken();                           // the social's read-back reaches the caller
  call.say('yes');
  lineIsSpoken();                           // "type the routing number" reaches the caller
  call.press('021000021');
  call.say('zero two one zero zero zero zero two one');
  lineIsSpoken();                           // the read-back reaches the caller
  call.say('yes');                          // and only now can they be answering it
  lineIsSpoken();
  call.press('5512340987#');
  call.say('five five one two three four zero nine eight seven');
  lineIsSpoken();
  call.say('yes');
  const spoken = call.openai
    .ofType('response.create')
    .map((m) => m.response?.instructions || '')
    .join(' ');
  assert.ok(/street address/i.test(spoken), `stuck in the bank block: ${spoken.slice(-160)}`);
});

// A line written while another is playing used to go into a single slot, and the
// next line to be written overwrote it. On a keypad commit two lines are always
// written on the same turn — the read-back, and whatever the model's own save for
// the same digits produces — so the read-back was the one that got dropped. The
// caller heard the second line, the server went on holding the read-back open, and
// every digit typed after that went back into the field that was already answered.
tKeypad('a read-back queued behind a live response is not overwritten', async () => {
  const call = startCall({ dtmfSuppressMs: 0 });
  walkTo(call, SCRIPTS.INDEX.routing);
  // A response is running: server VAD opened one the moment the caller stopped talking.
  call.openai.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'r_vad' } }));
  call.press('021000021');
  call.say('anything at all');
  call.openai.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'r_vad' } }));
  await sleep(20);
  const spoken = call.openai
    .ofType('response.create')
    .map((m) => m.response?.instructions || '')
    .join(' ');
  assert.ok(/is that right/i.test(spoken), 'the read-back was dropped on the floor');
});

// Which response is the server's was decided by "the next one created", and server
// VAD creates its own the moment the caller stops talking. When that landed in
// between, it took the label: the model's freeform sentence was played to the caller
// and the server's line was muted. That is where the sentences nobody wrote came
// from — "I'm ready for the next step", "we're almost done".
t('only the response the server asked for is played', () => {
  const call = startCall();
  // The model opens one on its own. No tag on it.
  call.openai.emit(
    'message',
    JSON.stringify({ type: 'response.created', response: { id: 'r_model', metadata: null } }),
  );
  call.openai.emit(
    'message',
    JSON.stringify({ type: 'response.output_audio.delta', response_id: 'r_model', delta: 'BBBB' }),
  );
  assert.strictEqual(call.twilio.ofEvent('media').length, 0, 'the model was heard talking to itself');
});

t('the response the server asked for carries a tag and is played', () => {
  const call = startCall();
  const asked = call.openai.ofType('response.create')[0];
  assert.ok(asked.response.metadata && asked.response.metadata.server_line, 'no tag on the line');
  call.openai.emit(
    'message',
    JSON.stringify({
      type: 'response.created',
      response: { id: 'r_server', metadata: asked.response.metadata },
    }),
  );
  call.openai.emit(
    'message',
    JSON.stringify({ type: 'response.output_audio.delta', response_id: 'r_server', delta: 'BBBB' }),
  );
  assert.strictEqual(call.twilio.ofEvent('media').length, 1, 'the server line was muted');
});

// Tones are not speech and have no business reaching a transcriber. Holding the mic
// shut from the first press is what stops the write-down being generated at all,
// rather than catching it downstream.
tKeypad('caller audio stops reaching the model while digits are being typed', () => {
  const call = startCall({ dtmfSuppressMs: 0 });
  walkTo(call, SCRIPTS.INDEX.routing);
  call.press('0210');
  const before = call.openai.ofType('input_audio_buffer.append').length;
  call.twilio.emit(
    'message',
    JSON.stringify({ event: 'media', streamSid: 'MZtest', media: { payload: 'AAAA' } }),
  );
  assert.strictEqual(
    call.openai.ofType('input_audio_buffer.append').length,
    before,
    'the tones were forwarded to the transcriber',
  );
});

// "Say this line word for word" is a request to a model, not a guarantee, and the
// word it drops is the last one. On a live call the read-back came back as "Okay,
// Joe Mama. That's j o e m a m a." and stopped: the caller heard their name spelled
// and then nothing, said nothing back because nothing had been asked, and the server
// sat holding a yes-or-no question open behind the silence.
t('a read-back that comes back without its question gets the question asked', () => {
  const call = startCall();
  call.say('Joe');
  call.say('Mama');
  // The server asked for the read-back. The model says the first half and stops.
  const asked = call.openai.ofType('response.create').slice(-1)[0];
  assert.match(asked.response.instructions, /Is that right\?/i, 'no read-back was asked for');
  const meta = asked.response.metadata;
  call.openai.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'r_short', metadata: meta } }));
  call.openai.emit(
    'message',
    JSON.stringify({
      type: 'response.output_audio_transcript.done',
      response_id: 'r_short',
      transcript: "Okay, Joe Mama. That's j o e m a m a.",
    }),
  );
  const after = call.openai.ofType('response.create').slice(-1)[0];
  assert.match(after.response.instructions, /Is that right\?/i, 'the missing question was never asked');
});

t('a read-back that was said in full is not asked twice', () => {
  const call = startCall();
  call.say('Joe');
  call.say('Mama');
  const asked = call.openai.ofType('response.create');
  const meta = asked[asked.length - 1].response.metadata;
  const before = asked.length;
  call.openai.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'r_full', metadata: meta } }));
  call.openai.emit(
    'message',
    JSON.stringify({
      type: 'response.output_audio_transcript.done',
      response_id: 'r_full',
      transcript: "Okay, Joe Mama. That's j o e m a m a. Is that right?",
    }),
  );
  assert.strictEqual(call.openai.ofType('response.create').length, before, 'asked the question a second time');
});

// The read-back's question is sent as a line of its own. A model asked to say a long
// line word for word drops the last words, and here the last words are the entire
// point: "Okay, Joe Mama. That's j o e m a m a." with no question after it leaves the
// caller with nothing to answer and the server waiting for an answer.
t('the read-back question goes out as its own line', () => {
  const call = startCall();
  call.say('Joe');
  call.say('Mama');
  const asked = call.openai.ofType('response.create').map((m) => m.response.instructions);
  const question = asked[asked.length - 1];
  const body = asked[asked.length - 2];
  assert.match(question, /LINE: Is that right\?$/m, `last line was: ${question.slice(-80)}`);
  assert.match(body, /j[\s.]+o[\s.]+e[\s.]+m[\s.]+a[\s.]+m[\s.]+a/i, 'the spelling was not sent');
  assert.doesNotMatch(body, /is that right/i, 'the question is still riding on the long line');
});

// The same words filed twice as the form moves under them. On a live call "four seven
// three" was accepted as the apartment number and then written into the city, and the
// application went out with a city called 473.
t('an answer filed twice does not land in the next field too', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.street_2 !== undefined ? SCRIPTS.INDEX.street_2 : SCRIPTS.INDEX.city);
  call.say('473');
  const before = call.lastToolResult();
  assert.ok(before.accepted, 'the apartment number was refused');
  call.say('473');
  const after = call.lastToolResult();
  assert.strictEqual(after.accepted, false, 'the repeat was written into the next field');
});

// Repeating yourself is normal. Two knockout questions in a row are both answered
// "no" and both of those are real answers.
t('the same word twice is still two answers when it carries no digits', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.deployed_military);
  call.say('no');
  const first = call.lastToolResult();
  call.say('no');
  const second = call.lastToolResult();
  assert.ok(first.accepted && second.accepted, 'an honest repeat was refused');
});

// ---------- the model answering its own question ----------
//
// On a live call the bot asked "Okay, Joe Mama. That's j o e m a m a. Is that right?"
// and then filed save_answer("Yes, that's right.") and moved on to the email address.
// The caller had not made a sound; there was no transcript in the log because there
// was nothing to transcribe. A model handed a turn produces a plausible continuation,
// and after a yes-or-no question the plausible continuation is a yes.
const spoke = (call) =>
  call.openai.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));

t('an answer with no caller turn behind it is refused', () => {
  const call = startCall();
  spoke(call);
  call.say('Joe');
  assert.ok(call.lastToolResult().accepted, 'a real answer was refused');
  // Nothing said, and the model files one anyway.
  call.saysNothingButModelSaves('Smith');
  const r = call.lastToolResult();
  assert.strictEqual(r.accepted, false, 'the model answered for the caller');
  assert.ok(r.silent, 'the refusal talked over the question already asked');
});

t('one caller turn does not pay for two answers', () => {
  const call = startCall();
  spoke(call);
  call.say('Joe');
  // Same turn, second save. The caller said one thing.
  call.saysNothingButModelSaves('Smith');
  assert.strictEqual(call.lastToolResult().accepted, false);
  // They speak again, and it goes through.
  spoke(call);
  call.say('Smith');
  assert.ok(call.lastToolResult().accepted, 'a fresh turn was refused');
});

t('a call that never reports speech detection still works', () => {
  // The fake sockets in most tests drive tool calls with no audio events at all, and
  // so does the carrier before the first word. With nothing ever detected the check
  // stands down rather than refusing every answer on the call.
  const call = startCall();
  call.say('Joe');
  assert.ok(call.lastToolResult().accepted);
});
