// bridge-voice.test.js — the call where the server holds the turn.
//
// Both sockets are faked and so is the speech endpoint, so what this covers is the
// control loop: who may produce an answer, when the microphone is open, and whether
// the line the server wrote is the line that goes on the wire. The audio conversion
// has its own checks at the bottom, against numbers a telephone fixes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { handleCall, earSession } = require('../src/bridge-voice');
const voice = require('../src/voice');
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
  ofType(type) {
    return this.sent.filter((m) => m.type === type);
  }
  ofEvent(event) {
    return this.sent.filter((m) => m.event === event);
  }
}

function startCall({ callsDir, quietNudgeMs, quietEndMs, goodbyeMs } = {}) {
  const twilio = new FakeSocket();
  const openai = new FakeSocket();
  const emails = [];
  // Every line the server asks for, and one frame of pretend audio per line so the
  // mark accounting is exercised without a network call.
  const spoken = [];

  handleCall(twilio, {
    openaiApiKey: 'test',
    openWebSocket: () => openai,
    deliver: async (msg) => {
      emails.push(msg);
      return { sent: true, via: 'test', id: 'x' };
    },
    callsDir: callsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'callbot-voice-')),
    speak: (text) => {
      spoken.push(text);
      // Enough frames that the microphone gate has something to close on: it opens
      // on the last 150 ms of a line, so a one-frame line would never shut it.
      return (async function* () {
        for (let i = 0; i < 20; i++) yield Buffer.alloc(160, 0xff).toString('base64');
      })();
    },
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
      start: { streamSid: 'MZtest', callSid: 'CAtest', customParameters: { from: '+16508629110' } },
      streamSid: 'MZtest',
    }),
  );

  // The caller says something. Only this can produce an answer — there is no tool.
  const say = (transcript) =>
    openai.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: String(transcript),
      }),
    );

  // The carrier reports the frames it has played, which is what reopens the mic.
  const linePlayed = () => {
    for (const m of twilio.ofEvent('mark')) {
      twilio.emit('message', JSON.stringify({ event: 'mark', streamSid: 'MZtest', mark: m.mark }));
    }
  };

  const hangUp = () =>
    twilio.emit('message', JSON.stringify({ event: 'stop', streamSid: 'MZtest', stop: {} }));

  const heardAudio = () => openai.ofType('input_audio_buffer.append').length;
  const sendCallerAudio = () =>
    twilio.emit(
      'message',
      JSON.stringify({ event: 'media', streamSid: 'MZtest', media: { payload: 'AAAA' } }),
    );

  return { twilio, openai, emails, spoken, say, linePlayed, hangUp, heardAudio, sendCallerAudio };
}

// ---------- the ear is only an ear ----------

t('the model is given no tools and is told not to answer', () => {
  const s = earSession('gpt-realtime');
  assert.deepStrictEqual(s.session.tools, []);
  assert.strictEqual(s.session.tool_choice, 'none');
  // The line that stops the model taking a turn of its own. Left at its default, the
  // API creates a response every time the caller stops talking and the model fills
  // it, which is where every invented sentence and invented answer came from.
  assert.strictEqual(s.session.audio.input.turn_detection.create_response, false);
  assert.strictEqual(s.session.audio.input.turn_detection.interrupt_response, false);
});

t('nothing the model could send can put a value on the form', () => {
  const call = startCall();
  // A tool call, which is how an answer used to arrive. There is no handler for it.
  call.openai.emit(
    'message',
    JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'save_answer',
      arguments: JSON.stringify({ answer: 'Joe' }),
    }),
  );
  // And a response the model generated on its own.
  call.openai.emit(
    'message',
    JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'Yes, that is right.' }),
  );
  assert.strictEqual(
    call.openai.sent.filter((m) => m.item && m.item.type === 'function_call_output').length,
    0,
    'a tool call was answered',
  );
  assert.deepStrictEqual(call.spoken.slice(1), [], 'the model made the server say something');
});

// ---------- the turn ----------

t('the greeting and the first question are spoken by the server', async () => {
  const call = startCall();
  await sleep(10);
  assert.match(call.spoken[0], /Thanks for calling Finosu/);
  assert.match(call.spoken[0], /first name/i);
});

t('one transcript in, one line out', async () => {
  const call = startCall();
  await sleep(10);
  call.say('Joe');
  await sleep(10);
  assert.match(call.spoken[1], /last name/i, `said: ${call.spoken[1]}`);
});

t('the read-back is spoken whole, question and all', async () => {
  const call = startCall();
  await sleep(10);
  call.say('Joe');
  await sleep(10);
  call.say('Mama');
  await sleep(10);
  const line = call.spoken[call.spoken.length - 1];
  assert.match(line, /j o e m a m a/i, `no spelling: ${line}`);
  assert.match(line, /is that right\?$/i, `no question on the end: ${line}`);
});

t('the read-back waits for an answer and only the caller can give one', async () => {
  const call = startCall();
  await sleep(10);
  call.say('Joe');
  await sleep(10);
  call.say('Mama');
  await sleep(10);
  const atReadBack = call.spoken.length;
  // Everything the model can emit, none of which is a caller turn.
  call.openai.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'r1' } }));
  call.openai.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  call.openai.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
  await sleep(10);
  assert.strictEqual(call.spoken.length, atReadBack, 'the call moved on without an answer');
  // The caller answers, and now it moves.
  call.say('yes');
  await sleep(10);
  assert.match(call.spoken[call.spoken.length - 1], /email/i);
});

t('line noise is not an answer', async () => {
  const call = startCall();
  await sleep(10);
  const before = call.spoken.length;
  call.say('Thank you.');
  call.say('Bye.');
  await sleep(10);
  assert.strictEqual(call.spoken.length, before, 'Whisper filler was taken as a name');
});

// ---------- the microphone ----------

t('the caller is not listened to while the bot is speaking', async () => {
  const call = startCall();
  await sleep(10);
  const before = call.heardAudio();
  call.sendCallerAudio();
  assert.strictEqual(call.heardAudio(), before, 'the bot listened to its own line');
  // The carrier reports the line played, and the mic opens.
  call.linePlayed();
  call.sendCallerAudio();
  assert.strictEqual(call.heardAudio(), before + 1, 'the mic never opened');
});

// ---------- the whole form ----------

t('a clean call reaches a decision and sends one email', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callbot-voice-run-'));
  const call = startCall({ callsDir: dir });
  await sleep(10);
  for (const line of SCRIPTS.APPROVED) {
    call.say(line);
    await sleep(4);
  }
  await sleep(60);
  assert.strictEqual(call.emails.length, 1, `expected one email, got ${call.emails.length}`);
  const written = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.strictEqual(written.length, 1, 'no call record written');
  const record = JSON.parse(fs.readFileSync(path.join(dir, written[0]), 'utf8'));
  assert.strictEqual(record.decision.outcome, 'Approved', JSON.stringify(record.decision));
  assert.strictEqual(record.application.applicant.name, 'Gabriel Kim');
  assert.strictEqual(record.application.bank_account.routing_number, '021000021');
});

t('hanging up mid-form still writes the record and emails it once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callbot-voice-hang-'));
  const call = startCall({ callsDir: dir });
  await sleep(10);
  call.say('Joe');
  await sleep(10);
  call.hangUp();
  await sleep(40);
  assert.strictEqual(call.emails.length, 1);
  const record = JSON.parse(
    fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'),
  );
  assert.strictEqual(record.decision.outcome, 'Incomplete');
});

// ---------- the audio a telephone wants ----------

t('24 kHz samples become 8 kHz u-law at exactly a third the count', () => {
  const seconds = 1;
  const pcm = Buffer.alloc(24000 * seconds * 2);
  for (let i = 0; i < 24000 * seconds; i++) {
    pcm.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2);
  }
  const mulaw = voice.pcm24kToMulaw8k(pcm);
  assert.strictEqual(mulaw.length, 8000, 'a second of audio is 8000 bytes on a phone line');
});

t('u-law encodes silence and the rails the way the standard says', () => {
  // G.711 inverts every bit on the way out, the sign bit included, so a positive
  // sample carries the high bit and a negative one does not — the opposite of what
  // the arithmetic looks like it should give. These are the three values a wrong
  // encoder gets wrong first, and a wrong encoder sounds like static, not like a
  // slightly worse voice.
  assert.strictEqual(voice.linearToMulaw(0), 0xff, 'silence');
  assert.strictEqual(voice.linearToMulaw(32767), 0x80, 'positive rail');
  assert.strictEqual(voice.linearToMulaw(-32768), 0x00, 'negative rail');
});

// Frames are batched before they go to the carrier. One 20 ms frame per message,
// each with a mark behind it, is a hundred messages a second and six hundred for a
// read-back; the carrier spends its time on message bookkeeping instead of on playing
// the sound, and the gaps are audible as a stutter.
t('audio goes to the carrier in batches, not one frame per message', async () => {
  const call = startCall();
  await sleep(20);
  const media = call.twilio.ofEvent('media');
  assert.ok(media.length > 0, 'no audio sent');
  // The greeting is 20 frames in the fake, so it is one message, not twenty.
  assert.ok(media.length <= 2, `${media.length} messages for a 20 frame line`);
  const bytes = Buffer.from(media[0].media.payload, 'base64').length;
  assert.strictEqual(bytes % 160, 0, 'a batch is not a whole number of frames');
  assert.ok(bytes > 160, 'frames were not batched');
});

// Two base64 strings only concatenate cleanly when each decodes from a whole number
// of three-byte groups. A 160 byte frame does not, so gluing the text together
// produced audio that was almost right, which is harder to spot than audio that is
// obviously wrong.
t('batched frames decode back to exactly the frames that went in', () => {
  const a = Buffer.alloc(160, 0x11);
  const b = Buffer.alloc(160, 0x22);
  const joined = Buffer.concat([a, b].map((x) => x)).toString('base64');
  const back = Buffer.from(joined, 'base64');
  assert.strictEqual(back.length, 320);
  assert.ok(back.subarray(0, 160).equals(a));
  assert.ok(back.subarray(160).equals(b));
});

// A stream arrives in pieces of whatever size the network hands over, and a filter
// needs the samples either side of the one it is producing. Feeding it in ragged
// pieces has to give byte-for-byte what feeding it the whole buffer gives, or there
// is a click at every seam.
t('resampling a stream in ragged pieces matches doing it all at once', () => {
  const pcm = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++) {
    pcm.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2);
  }
  const whole = voice.pcm24kToMulaw8k(pcm);
  const feed = voice.makeResampler();
  const parts = [];
  const sizes = [1000, 3, 7777, 2, 15000, 99999]; // odd sizes split samples in half
  let carry = Buffer.alloc(0);
  let at = 0;
  let i = 0;
  while (at < pcm.length) {
    const n = Math.min(sizes[i++ % sizes.length], pcm.length - at);
    const buf = Buffer.concat([carry, pcm.subarray(at, at + n)]);
    at += n;
    const usable = buf.length - (buf.length % 2);
    carry = buf.subarray(usable);
    if (usable) parts.push(feed(buf.subarray(0, usable)));
  }
  const streamed = Buffer.concat(parts);
  assert.strictEqual(streamed.length, whole.length, 'the streamed line came out a different length');
  assert.ok(streamed.equals(whole), 'a chunk boundary changed the audio');
});
