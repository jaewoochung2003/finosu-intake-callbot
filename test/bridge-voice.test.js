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
      // Enough frames that the microphone gate has something to close on, and a tick
      // of delay before the first one, because the speech endpoint takes about a
      // second to answer and several guards depend on a caller turn being able to
      // arrive before the bot's audio starts. A generator that yields instantly is
      // not a stand-in for that; it is the one ordering a real call never has.
      return (async function* () {
        await new Promise((r) => setTimeout(r, 1));
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
  assert.match(line, /j[\s.]+o[\s.]+e[\s.]+m[\s.]+a[\s.]+m[\s.]+a/i, `no spelling: ${line}`);
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

t('line noise is not an answer, but is not met with silence either', async () => {
  const call = startCall();
  await sleep(10);
  call.say('Thank you.');
  await sleep(20);
  // Not written into the form...
  assert.doesNotMatch(call.spoken.join(' '), /that's[\s.]+t[\s.]+h[\s.]+a[\s.]+n[\s.]+k/i, 'filler was taken as a name');
  // ...and not answered with nothing. On a live call the caller spoke, heard nothing
  // back, and sat there saying "Hello?" into a bot they could not tell from a dead
  // line.
  assert.strictEqual(call.spoken.length, 2, `spoke: ${JSON.stringify(call.spoken)}`);
  assert.match(call.spoken[1], /did not catch that/i);
  assert.match(call.spoken[1], /first name/i, 'the open question was not asked again');
});

// Twice, then quiet. A line producing noise on its own must not be argued with
// forever; the quiet watch already ends a call nobody is talking on.
t('a line that only produces noise is not answered forever', async () => {
  const call = startCall();
  await sleep(10);
  for (let i = 0; i < 5; i++) {
    call.say('Thank you.');
    await sleep(15);
  }
  assert.ok(call.spoken.length <= 3, `said ${call.spoken.length} lines at a noisy line`);
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

// The delivery note goes only to the models that accept it. tts-1 rejects the field
// outright, so sending it to every model would fail every line on the call.
t('a spelled-out line asks for a different delivery than a plain one', () => {
  assert.notStrictEqual(
    voice.styleFor("Okay, 0 2 1 0 0 0 0 2 1. Is that right?"),
    voice.styleFor('And the city?'),
  );
  assert.strictEqual(voice.styleFor('And the city?'), voice.TTS_STYLE_PLAIN);
  assert.strictEqual(voice.styleFor("Okay, Joe Mama. That's j o e m a m a."), voice.TTS_STYLE_SPELLED);
  // A stray single letter in ordinary text is not a spelled-out run.
  assert.strictEqual(voice.styleFor('Is that a yes?'), voice.TTS_STYLE_PLAIN);
  assert.strictEqual(voice.styleFor('Got it, 473. And the city?'), voice.TTS_STYLE_PLAIN);
});

// The two kinds of line want opposite pacing. An ordinary question is a sentence and
// wants to be over with; a read-back is single characters the caller is checking one
// at a time against something in their hand, and at conversational pace it is a blur.
t('a spelled-out line is spoken slower than a plain one', () => {
  assert.ok(
    voice.speedFor("Okay, Joe Mama. That's j o e m a m a. Is that right?") < voice.speedFor('And the city?'),
    'the read-back is not slowed down',
  );
  assert.strictEqual(voice.speedFor('Okay, 0 2 1 0 0 0 0 2 1. Is that right?'), voice.TTS_SPEED_SPELLED);
  assert.strictEqual(voice.speedFor('Got it, 473. And the city?'), voice.TTS_SPEED_PLAIN);
});

// One utterance, two transcripts. The voice detector can call a turn over inside a
// word and open another, and the second half lands against the NEXT question because
// the form has moved by then. On a live call an apartment number given once went in
// as the apartment number and then as the city.
t('a second transcript before the bot has spoken is not a second answer', async () => {
  const call = startCall();
  await sleep(10);
  call.say('Joe');
  // The tail of the same word, arriving while the reply is still being fetched. No
  // wait between the two: that is the whole of the case.
  call.say('Joe');
  await sleep(20);
  assert.strictEqual(call.spoken.length, 2, `spoke: ${JSON.stringify(call.spoken)}`);
  assert.match(call.spoken[1], /last name/i);
});

// The other direction, which a word-matching guard got wrong: "no" answers two
// knockout questions in a row and both are real answers.
t('the same word twice is two answers when the bot asked twice', async () => {
  const call = startCall();
  await sleep(10);
  for (const line of SCRIPTS.APPROVED) {
    call.say(line);
    await sleep(4);
  }
  await sleep(60);
  assert.strictEqual(call.emails.length, 1);
  const html = call.emails[0].html;
  assert.match(html, /Approved/, 'a repeated "no" was swallowed and the call declined');
});

// English is stated, not detected. Handed a third of a second of audio the
// transcriber decides badly: a caller saying his own surname got it back in Cyrillic,
// and a one word "yes" to a read-back came back as the Turkish "o yuzden".
t('the transcriber is told the call is in English', () => {
  const s = earSession('gpt-realtime');
  assert.strictEqual(s.session.audio.input.transcription.language, 'en');
});

// "z-o-e-y@gmail.com" is somebody spelling zoey, not an address with three hyphens.
// Asked to spell it one letter at a time, the caller said "zed oh ee why" and the
// transcriber wrote it back hyphenated, which is how English writes a spelled word.
// It went on the form as z-o-e-y@gmail.com and was read back as "z dash o dash e dash
// y", so the caller said no and spelled it again and got the same thing.
t('an address spelled one letter at a time does not keep the hyphens', () => {
  const P = require('../src/parse');
  assert.strictEqual(P.parseEmail('z-o-e-y at gmail dot com'), 'zoey@gmail.com');
  assert.strictEqual(P.parseEmail('J-O-E at gmail.com'), 'joe@gmail.com');
  // A real hyphen has a word on at least one side of it and stays.
  assert.strictEqual(P.parseEmail('mary-jane at gmail dot com'), 'mary-jane@gmail.com');
  assert.strictEqual(P.parseEmail('j-p-morgan at chase dot com'), 'j-p-morgan@chase.com');
});

// "What's your work situation?" — "Students." Said three times, transcribed correctly
// all three times, refused all three, and the field gave up with nothing on it.
t('an option named in the plural is that option', () => {
  const P = require('../src/parse');
  const JOBS = ['Employed', 'Self-employed', 'Unemployed', 'Retired', 'Student'];
  assert.strictEqual(P.parseEnum('Students.', JOBS, {}), 'Student');
  assert.strictEqual(P.parseEnum('student', JOBS, {}), 'Student');
  // The thing this must not break: naming both options is still ambiguous, and a
  // negative is still not an answer.
  assert.strictEqual(P.parseEnum('checking or savings? checking', ['Checking', 'Savings'], {}), null);
  assert.strictEqual(P.parseEnum('not a student', JOBS, {}), null);
});

// The two kinds of line go to different speech engines, and this is the reason the
// spelling was a blur for so long.
//
// tts-1 is a reader: it says the text, quickly, and takes no instruction about how.
// Right for a question, wrong for a read-back, and turning its speed down does not
// help — speed stretches a letter, it does not push letters apart, so what came out
// was a drawl with the characters still run together. gpt-4o-mini-tts takes an
// instruction and can be told what the line is for. Told to spell, the same line
// takes 9.15 seconds against tts-1's 4.96, and the extra four seconds are the pauses.
//
// Putting the pauses in the text as ellipses was tried in between and is worse than
// either: punctuation an engine does not interpret is punctuation it may read out.
t('a read-back goes to the engine that can be told it is a read-back', () => {
  const V = require('../src/validate');
  assert.strictEqual(voice.modelFor(`Okay, ${V.spellDigits('021000021')}. Is that right?`), 'gpt-4o-mini-tts');
  assert.strictEqual(voice.modelFor(`That's ${V.spellWords('Joe Mama')}.`), 'gpt-4o-mini-tts');
  assert.strictEqual(voice.modelFor('And the city?'), 'tts-1');
  assert.strictEqual(voice.modelFor('Got it, Vienna. And the state?'), 'tts-1');
  // And that engine is told what to do with it.
  assert.match(voice.styleFor(`That's ${V.spellWords('Joe')}.`), /each single letter or digit/i);
});

// Nothing in a spoken line may be punctuation the caller could hear as a word.
t('spelled-out characters are separated by a space and nothing else', () => {
  const V = require('../src/validate');
  assert.strictEqual(V.spellWords('Joe'), 'j o e');
  assert.strictEqual(V.spellDigits('021'), '0 2 1');
  assert.strictEqual(V.spellEmail('zoey@gmail.com'), 'z o e y, at gmail dot com');
});

// And the line still has to be recognised as a read-back afterwards. It was not: the
// test looked for single characters separated by whitespace, the separator became
// three dots and a space, and every read-back went out at the pace of an ordinary
// question — the one pace they exist to avoid.
t('a read-back is still recognised as one after the separator changed', () => {
  const V = require('../src/validate');
  assert.strictEqual(voice.speedFor(`Okay, ${V.spellDigits('021000021')}. Is that right?`), voice.TTS_SPEED_SPELLED);
  assert.strictEqual(voice.speedFor(`That's ${V.spellWords('Joe Mama')}.`), voice.TTS_SPEED_SPELLED);
  assert.strictEqual(voice.speedFor('Got it, Vienna. And the state?'), voice.TTS_SPEED_PLAIN);
});

// ---------- "are you still there?" ----------
//
// A caller who goes quiet is asked whether they are there. The question they went
// quiet on is still the open one, so their "yes" was fed to it: on a street address
// it failed validation and burned an attempt, and on a yes-or-no knockout it would
// have declined somebody who only meant they had not hung up.
t('the nudge asks the question again, not just whether anyone is there', async () => {
  const call = startCall({ quietNudgeMs: 60, quietEndMs: 5000 });
  await sleep(10);
  call.linePlayed();
  await sleep(140);
  const nudge = call.spoken[call.spoken.length - 1];
  assert.match(nudge, /still there/i, `no nudge: ${JSON.stringify(call.spoken)}`);
  assert.match(nudge, /first name/i, 'the caller was left with nothing to answer');
});

t('a yes to the nudge is presence, not an answer to the open question', async () => {
  const call = startCall({ quietNudgeMs: 60, quietEndMs: 5000 });
  await sleep(10);
  call.linePlayed();
  await sleep(140);
  const before = call.spoken.length;
  call.say('yes');
  await sleep(20);
  // Not filed: the name question is still open.
  assert.strictEqual(call.spoken.length, before + 1, `spoke: ${JSON.stringify(call.spoken.slice(before))}`);
  assert.match(call.spoken[before], /first name/i, 'the yes was filed as the answer');
  assert.doesNotMatch(call.spoken[before], /last name/i, 'the yes was accepted as a first name');
});

// And the other direction: outside a nudge, a bare yes is an ordinary answer and has
// to reach the question that asked for one.
t('a yes with no nudge open is an ordinary answer', async () => {
  const call = startCall();
  await sleep(10);
  call.say('Joe');
  await sleep(20);
  call.say('Mama');
  await sleep(20);
  call.say('yes');
  await sleep(20);
  assert.match(call.spoken[call.spoken.length - 1], /email/i, 'the read-back never took its yes');
});
