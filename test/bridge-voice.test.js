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
  assert.match(line, /j[^A-Za-z0-9]+o[^A-Za-z0-9]+e[^A-Za-z0-9]+m[^A-Za-z0-9]+a[^A-Za-z0-9]+m[^A-Za-z0-9]+a/i, `no spelling: ${line}`);
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
  assert.doesNotMatch(call.spoken.join(' '), /that's[^A-Za-z0-9]+t[^A-Za-z0-9]+h[^A-Za-z0-9]+a[^A-Za-z0-9]+n[^A-Za-z0-9]+k/i, 'filler was taken as a name');
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

// Four letters that happen to spell a word get read as the word, however clearly the
// engine is told to spell. "y e s s" came back off a live call as "yes s" and the
// caller could not tell what had been written down. A comma is what separates them,
// and it has to be punctuation the engine interprets rather than punctuation it might
// say: measured through the spelling engine, spaces 4.50s, commas 5.45s, and the extra
// second is the gaps.
t('spelled-out characters are separated by something the reader pauses on', () => {
  const V = require('../src/validate');
  assert.strictEqual(V.spellWords('Joe'), 'j, o, e');
  assert.strictEqual(V.spellDigits('021'), '0, 2, 1');
  assert.strictEqual(V.spellEmail('yess@gmail.com'), 'y, e, s, s, at gmail dot com');
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

// A note is said out loud, so it has to read as something a person says. The phone
// number's was "read back as (240) 278-6143", which is a direction to whoever is
// speaking, and with nothing speaking but the server the caller heard the direction.
t('a spoken note is a sentence, not an instruction to whoever is reading it', () => {
  const V = require('../src/validate');
  const phone = V.validatePhone('240 278 6143');
  assert.ok(phone.ok);
  assert.doesNotMatch(phone.note, /^read back/i, `the caller hears: ${phone.note}`);
  assert.match(phone.note, /^Got it, \(240\) 278-6143/);
  const income = V.validateMonthlyIncome('two thousand a month', 'Monthly');
  assert.ok(income.ok);
  assert.match(income.note, /^Got it,/, `the caller hears: ${income.note}`);
});

// Which mark stands between the characters has changed three times, and twice it
// silently stopped every read-back being recognised as one, so they all went out at
// the pace of an ordinary question. What makes a line a read-back is single characters
// standing alone, whatever is between them.
t('a read-back is recognised whatever separates the characters', () => {
  for (const sep of [' ', ', ', '... ', ' - ', '. ']) {
    const line = `Okay, ${'021000021'.split('').join(sep)}. Is that right?`;
    assert.strictEqual(voice.modelFor(line), 'gpt-4o-mini-tts', `missed with "${sep}"`);
  }
  // And an ordinary line is not one, whatever it contains.
  for (const line of [
    'Got it, 473. And the city?',
    'Is that a yes?',
    'Got it, Vienna. And the state?',
    'Got it, (240) 278-6143. What is your work situation right now?',
    'Got it, about 2,000 dollars a month. Are you active duty military right now?',
  ]) {
    assert.strictEqual(voice.modelFor(line), 'tts-1', `wrongly read back: ${line}`);
  }
});

// "J-O-E Mama" went onto a form. Asked to spell a name — which the bot does itself,
// on the path a caller reaches by saying the first read-back was wrong — the caller
// says the letters and the transcriber writes them the way English writes a spelled
// word. The run logic pulled apart "j a e w o o" but never saw "J-O-E", because that
// is one token.
t('a name spelled with hyphens is the name, not the hyphens', () => {
  const P = require('../src/parse');
  assert.strictEqual(P.parseName('J-O-E.'), 'Joe');
  assert.strictEqual(P.parseName('J-O-E'), 'Joe');
  assert.strictEqual(P.parseName('j.o.e.'), 'Joe');
  assert.strictEqual(P.parseName('C-H-U-N-G'), 'Chung');
  assert.strictEqual(P.parseName('j a e w o o'), 'Jaewoo');
  // Real hyphens have a word on at least one side and stay. Two single letters are a
  // pair of initials, not a spelling, or "J R" joins to "Jr" and reads as Junior.
  assert.strictEqual(P.parseName('Mary-Jane'), 'Mary-Jane');
  assert.strictEqual(P.parseName('Jean-Luc Picard'), 'Jean-Luc Picard');
  assert.strictEqual(P.parseName('J-R'), 'J-R');
  assert.strictEqual(P.parseName('J R Smith'), 'J R Smith');
  assert.strictEqual(P.parseName('Malcolm X.'), 'Malcolm X');
  // Whatever the transcriber puts between the letters.
  assert.strictEqual(P.parseName('J - O - E'), 'Joe');
  assert.strictEqual(P.parseName('J. O. E.'), 'Joe');
  // Two names spelled in one breath need the pause the caller made between them.
  // Without it there is nothing in the text to say where one ends.
  assert.strictEqual(P.parseName('J-O-E, M-A-M-A'), 'Joe Mama');
});

// The same shape reaches five other fields, and each has its own reader. This is the
// check that the fix is not just about the one field it was found on.
t('a spelled answer works on every field that takes one', () => {
  const P = require('../src/parse');
  assert.strictEqual(P.parseEmail('j-o-e at gmail dot com'), 'joe@gmail.com');
  assert.strictEqual(P.parseEmail('J-O-E-Y at gmail.com'), 'joey@gmail.com');
  // A dot between letters is ordinary in an address and is left alone.
  assert.strictEqual(P.parseEmail('first.last at gmail dot com'), 'first.last@gmail.com');
  assert.strictEqual(P.spokenDigits('0-2-1-0-0-0-0-2-1'), '021000021');
  assert.strictEqual(P.spokenDigits('4-8-2-1'), '4821');
  assert.strictEqual(P.parseState('V-A'), 'VA');
});

// The read-back regression of 13 Aug, and the shape that prevents it coming back.
//
// Sending the whole read-back to gpt-4o-mini-tts put the closing question inside a
// generated take, and a generated take sometimes stops early: the same line run twice
// came back at 7.6 seconds with "Is that right?" on the end and at 6.8 seconds
// without it. The caller heard their name spelled and was never asked anything, and
// the call sat waiting for an answer to a question nobody had been asked. Measured
// over twenty short lines the same engine lost the value five times; tts-1 lost it
// none. So the letters are the only thing it is given.
t('the question at the end of a read-back is not left to the spelling engine', () => {
  const parts = voice.segments("Okay, Joe Mama. That's j, o, e, m, a, m, a. Is that right?");
  assert.strictEqual(parts.length, 3, 'the read-back was not split into three');
  assert.strictEqual(parts[0].spelled, false);
  assert.strictEqual(parts[1].spelled, true, 'the letters did not reach the spelling engine');
  assert.strictEqual(parts[2].text, 'Is that right?');
  assert.strictEqual(parts[2].spelled, false, 'the closing question went to the spelling engine');
  // The digit read-backs have the same shape.
  const digits = voice.segments('Okay, 0, 2, 1, 0, 0, 0, 0, 2, 1. Is that right?');
  assert.strictEqual(digits.length, 2);
  assert.strictEqual(digits[0].spelled, true);
  assert.strictEqual(digits[1].text, 'Is that right?');
});

// A line that wants one engine is still one request. Splitting an ordinary sentence
// in two buys nothing and puts a seam in the middle of it.
t('an ordinary line is not split up', () => {
  const parts = voice.segments('Got it, 473. And the city?');
  assert.strictEqual(parts.length, 1);
  assert.strictEqual(parts[0].text, 'Got it, 473. And the city?');
  assert.strictEqual(voice.segments('And the city?').length, 1);
  assert.deepStrictEqual(voice.segments(''), []);
});

// Every question is the same string on every call, so its audio is made once. What
// this checks is that the text a warmed line is stored under is the text the splitter
// asks for at call time — the two are computed in different places and a line stored
// under one and looked up under another is a cache that never hits.
t('a warmed question is played from the cache and the rest of the line is not', () => {
  const held = voice.warmed;
  const before = held.size;
  try {
    held.set('And the city?', ['AAAA']);
    const parts = voice.piecesOf('Got it, 473. And the city?');
    assert.strictEqual(parts.length, 2, 'the warmed question was not split off');
    assert.strictEqual(parts[0].text, 'Got it, 473.');
    assert.strictEqual(parts[0].ready, null, 'a line with the caller in it was served from the cache');
    assert.deepStrictEqual(parts[1].ready, ['AAAA'], 'the warmed question was made again');
    // And on its own it is the whole line.
    const alone = voice.piecesOf('And the city?');
    assert.strictEqual(alone.length, 1);
    assert.deepStrictEqual(alone[0].ready, ['AAAA']);
  } finally {
    held.delete('And the city?');
    assert.strictEqual(held.size, before);
  }
});

// Two sentences that were warmed as one line are looked up as one line. The greeting
// is the case: it is two sentences, it is stored whole, and sentence-by-sentence
// neither half is in the cache.
t('a warmed line of two sentences is found', () => {
  const held = voice.warmed;
  const two = 'One thing. Then another.';
  try {
    held.set(two, ['BBBB']);
    const parts = voice.piecesOf(two);
    assert.strictEqual(parts.length, 1);
    assert.deepStrictEqual(parts[0].ready, ['BBBB']);
  } finally {
    held.delete(two);
  }
});

// Nothing a caller said is written to disk. A cached read-back would be somebody's
// account number sitting in a file, and it would be one generated take frozen in
// place — including a short one.
// The line is a spelled piece between two plain ones, and warm() is asked to make all
// three. It must reach the endpoint for neither of the plain ones — they are already
// held — and never for the spelled one. If it tried, the fake key below would make it
// throw rather than pass quietly.
t('the spelling engine is never cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttscache-'));
  const was = process.env.TTS_CACHE_DIR;
  process.env.TTS_CACHE_DIR = dir;
  const held = voice.warmed;
  const plain = ['Okay, Joe Mama.', 'Is that right?'];
  for (const line of plain) held.set(line, ['CCCC']);
  try {
    const report = await voice.warm(
      ["Okay, Joe Mama. That's j, o, e, m, a, m, a. Is that right?"],
      { apiKey: 'not-a-key' },
    );
    assert.strictEqual(report.made, 0, 'warm() went to the endpoint for a spelled line');
    assert.strictEqual(report.skipped, 3, 'warm() did not see all three pieces');
    assert.ok(!held.has("That's j, o, e, m, a, m, a."), 'a spelled line was cached');
  } finally {
    for (const line of plain) held.delete(line);
    if (was === undefined) delete process.env.TTS_CACHE_DIR;
    else process.env.TTS_CACHE_DIR = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The form's own text, so a question added to FIELDS is warmed without anyone
// remembering to add it to a list.
t('every question the form asks is on the list of fixed lines', () => {
  const intake = require('../src/intake');
  const { FIELDS } = require('../src/fields');
  const lines = intake.fixedLines();
  assert.ok(lines.includes(intake.GREETING), 'the greeting is not warmed');
  assert.ok(lines.includes('Is that right?'), 'the read-back question is not warmed');
  for (const field of FIELDS) {
    if (field.ask) assert.ok(lines.includes(field.ask), `${field.key} is not warmed`);
    if (field.reask) assert.ok(lines.includes(field.reask), `${field.key} reask is not warmed`);
  }
});
