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
function startCall({ callsDir, quietNudgeMs, quietEndMs, goodbyeMs } = {}) {
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
  assert.match(lastToolResult().say_next, /Okay, Gabriel Kim\. That's g a b r i e l k i m\. Is that right\?/);
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
  assert.match(lastToolResult().say_next, /g a b r i e l, at finosu dot com\. Is that right\?$/);
  // a no sends it back to the same question, spelled this time
  say('no');
  assert.match(lastToolResult().say_next, /Spell out the whole address/);
});

t('the tones of a half-typed number are never filed as the answer', () => {
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
function walkTo(call, index) {
  for (const line of SCRIPTS.APPROVED.slice(0, index)) call.say(line);
}

t('typed digits fill a digit field and skip speech entirely', () => {
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

t('the hash key submits a short entry early', () => {
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

t('the star key clears the buffer instead of submitting it', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.ssn);
  call.press('48*');
  const said = call.openai
    .ofType('response.create')
    .map((m) => m.response?.instructions || '')
    .join(' ');
  assert.match(said, /Cleared/);
});

t('the first keypress stops the bot talking', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.ssn);
  call.openai.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'B' }));
  const before = call.twilio.ofEvent('clear').length;
  call.press('4');
  assert.strictEqual(call.twilio.ofEvent('clear').length, before + 1);
});

t('an extra digit on a full field does not start a buffer on the next one', async () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.ssn);
  call.press('48215'); // one too many for a four digit field
  await sleep(900); // past the keypad deaf window, which is shorter than a question
  // The routing number question is next and must not be holding a stray "5".
  call.press('021000021');
  const said = call.openai
    .ofType('response.create')
    .map((m) => m.response?.instructions || '')
    .join(' ');
  assert.match(said, /JPMORGAN CHASE/i, 'the routing number did not land cleanly');
});

t('a spoken answer that moves the form on discards a stale keypad buffer', () => {
  const call = startCall();
  walkTo(call, SCRIPTS.INDEX.routing);
  call.press('0210'); // starts typing the routing number, does not finish
  call.say('zero two one zero zero zero zero two one'); // then says it instead
  // The idle timer would otherwise commit "0210" against the account number.
  const r = call.lastToolResult();
  assert.strictEqual(r.accepted, true);
  assert.match(r.say_next, /Is that right\?$/);
  call.say('yes');
  assert.match(call.lastToolResult().say_next, /account number/i);
});

// ---------- end of call ----------

t('hanging up writes the record and sends exactly one email', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callbot-'));
  const call = startCall({ callsDir: dir });
  for (const line of SCRIPTS.APPROVED) call.say(line);
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

t('typing counts as being there', async () => {
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
