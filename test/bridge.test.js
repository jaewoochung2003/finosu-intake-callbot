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
function startCall({ callsDir } = {}) {
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
  const say = (answer) => {
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

  return { twilio, openai, emails, say, press, hangUp, lastToolResult };
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
  assert.match(greet.response.instructions, /full name/);
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

t('the caller talking over the bot clears the queued audio', () => {
  const { twilio, openai } = startCall();
  openai.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'BBBB' }));
  openai.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  assert.strictEqual(twilio.ofEvent('clear').length, 1);
  assert.strictEqual(openai.ofType('response.cancel').length, 1);
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

t('an answer comes back as a tool output and the next question', () => {
  const { openai, say, lastToolResult } = startCall();
  say('my name is Gabriel Kim');
  const out = openai.sent.filter((m) => m.item && m.item.type === 'function_call_output');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].item.call_id, 'call_1');
  const r = lastToolResult();
  assert.strictEqual(r.accepted, true);
  assert.match(r.say_next, /email address/);
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
  say('Gabriel'); // one name only
  const r = lastToolResult();
  assert.strictEqual(r.accepted, false);
  assert.match(r.problem, /first and a last name/);
});

t('read_back is set on the fields the caller has to be able to check', () => {
  const { say, lastToolResult } = startCall();
  say('Gabriel Kim');
  assert.strictEqual(lastToolResult().read_back, false);
  say('gabriel at finosu dot com');
  assert.strictEqual(lastToolResult().read_back, true, 'email should be read back');
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
  assert.match(r.say_next, /account number/i);
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
  call.say('Gabriel Kim');
  call.say('gabriel at finosu dot com');
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
