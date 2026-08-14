// voice.js — the server's own mouth.
//
// Every line the bot says is turned into audio here and handed to the carrier as
// finished frames. The language model is not involved in speaking at all.
//
// It used to be. The model was given the line and asked to say it word for word, and
// that is a request, not a guarantee. Across one evening of live calls it reworded
// lines, dropped the question off the end of a read-back, said sentences the server
// never wrote ("I'm ready for the next step", "we're almost done"), skipped a whole
// question so the caller sat in silence, and answered its own yes-or-no question
// before the caller had made a sound. Each one was fenced off and the next one opened,
// because none of them was a compliance problem: a model handed a turn produces a
// plausible continuation of the conversation, and a plausible continuation is not the
// same thing as the line it was given.
//
// So the model no longer has a turn. It listens, and that is all. What the caller
// hears is bytes this file produced from a string, which cannot be reworded, cannot
// be cut short, and cannot arrive in the wrong order.
//
// The format is fixed by the telephone. A call is G.711 u-law, 8 kHz, mono, and the
// carrier wants it in 20 millisecond frames, which is 160 bytes. The speech endpoint
// will not produce that, so it hands back 24 kHz signed 16-bit samples and the two
// conversions happen here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
// Two engines, because the two kinds of line need different things from one.
//
// tts-1 is a reader. Hand it text and it says the text, quickly and obediently, and
// it takes no instruction about how. That is right for a question.
//
// It is wrong for a read-back, and this is the thing that took longest to see. The
// version before this one had the conversational model doing the speaking, and it
// spelled beautifully — because it understood that it was spelling. tts-1 does not
// understand anything. Given "j... o... e" it reads three characters as fast as it
// reads any others, and no amount of turning the speed down separates them: speed
// stretches a letter, it does not push letters apart. What came out was a drawl with
// the letters still run together.
//
// gpt-4o-mini-tts takes an instruction, so it can be told what the line is for. Told
// to spell, the same line takes 9.15 seconds against tts-1's 4.96, and the extra four
// seconds are pauses between the characters rather than longer characters. Its
// drawback is that it is slow at everything, which is why it is not used for the
// questions.
const TTS_MODEL_PLAIN = process.env.TTS_MODEL || 'tts-1';
const TTS_MODEL_SPELLED = process.env.TTS_MODEL_SPELLED || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'alloy';
// Pace, for the engine that takes a number rather than an instruction.
//
// Measure a change on a long line, not a short one. Short samples are dominated by
// how much generation varies between requests: 0.9, 1.0 and 1.05 all came back within
// 40 ms of each other on a three word question, which reads as "speed does nothing",
// while the same three values on the greeting came back 12.1, 10.7 and 9.6 seconds.
const TTS_SPEED_PLAIN = Number(process.env.TTS_SPEED_PLAIN || process.env.TTS_SPEED || 0.9);
const TTS_SPEED_SPELLED = Number(process.env.TTS_SPEED_SPELLED || 0.7);
const speedFor = (text) => (SPELLED_OUT.test(text) ? TTS_SPEED_SPELLED : TTS_SPEED_PLAIN);
const modelFor = (text) => (SPELLED_OUT.test(text) ? TTS_MODEL_SPELLED : TTS_MODEL_PLAIN);
// Which models take a free-text delivery note. The older ones reject the field.
const takesInstructions = (model) => /^gpt-/.test(model);

// How the line should sound. The speech endpoint takes this as a separate field, so
// it shapes delivery without being able to change a word — which is the entire point
// of moving the voice here.
//
// There are two, and which one is used depends on the line.
//
// There was one to begin with, and it asked for gaps between spelled-out letters and
// for the end of a sentence not to be rushed. Both are right for a read-back and both
// were being applied to every line on the call, so "And the city?" took 1.7 seconds to
// say when a person says it in well under one. On the phone that reads as the bot
// being slow and halting rather than careful.
const TTS_STYLE_PLAIN =
  process.env.TTS_STYLE ||
  'Calm and clear, at a normal speaking pace, like a person taking down a form over ' +
    'the phone. Do not slow down and do not leave gaps between words.';

// For a line that spells something out. This is the instruction the whole two-engine
// split exists to be able to send.
const TTS_STYLE_SPELLED =
  process.env.TTS_STYLE_SPELLED ||
  'You are spelling something out to somebody writing it down. Say each single ' +
    'letter or digit on its own, slowly, with a clear pause after each one. Do not ' +
    'run them together and do not read them as a word. Speak the rest of the ' +
    'sentence at a normal pace.';

// A read-back spells its value out as single characters with something between each,
// a shape no ordinary sentence has. Three in a row is enough to recognise it and not
// enough for "a b" in ordinary text to trip it.
//
// Any run of non-alphanumeric characters counts as the separator, deliberately. This
// test has been broken twice by the separator changing under it — once to three dots,
// once to a comma — and each time every read-back quietly went out at the pace of an
// ordinary question, which is the one pace they exist to avoid. What makes a line a
// read-back is single characters standing alone, not which mark stands between them.
const SPELLED_OUT = /(?:(?:^|[^A-Za-z0-9]+)[A-Za-z0-9](?=[^A-Za-z0-9])){3,}/;
const styleFor = (text) => (SPELLED_OUT.test(text) ? TTS_STYLE_SPELLED : TTS_STYLE_PLAIN);

// ---------- one line, two engines ----------

// The spelling engine is told what the line is for, which is the whole reason it is
// here, and being told is not the same as being made to. gpt-4o-mini-tts generates
// speech rather than reading it, and on a long line it sometimes stops early: the
// same read-back run twice came back at 7.6 seconds with "Is that right?" on the end
// and at 6.8 seconds without it, ending after the last letter of the name. A caller
// heard their name spelled and was never asked anything, so the call sat waiting for
// a yes to a question nobody had been asked.
//
// That is the failure the conversational model was taken off the voice for, one layer
// down, and it has the same answer: do not give a model that generates the part of
// the line that has to be exact. A read-back is two kinds of sentence, not one. The
// letters need an engine that can be told to space them out; "Is that right?" needs
// an engine that says what it is handed. So the line is cut at its sentence
// boundaries and each piece goes to the engine it needs. The spelling engine gets the
// letters and nothing else, and the question at the end goes to tts-1, which reads.
//
// Adjacent sentences that want the same engine are joined back up, so an ordinary
// line is still one request and still sounds like one sentence.
function sentencesOf(text) {
  return String(text || '').match(/[^.!?]+(?:[.!?]+|$)/g) || [];
}

function segments(text) {
  const parts = [];
  for (const raw of sentencesOf(text)) {
    const piece = raw.trim();
    if (!piece) continue;
    const spelled = SPELLED_OUT.test(piece);
    const last = parts[parts.length - 1];
    if (last && last.spelled === spelled) last.text += ` ${piece}`;
    else parts.push({ text: piece, spelled });
  }
  if (parts.length) return parts;
  const whole = String(text || '').trim();
  return whole ? [{ text: whole, spelled: SPELLED_OUT.test(whole) }] : [];
}

// The first word or two of a line, when it is a word the form uses over and over.
//
// "Got it, 473. And the city?" cannot be made in advance, because of the 473. Its
// first two words can, and split off they play while the endpoint is still working on
// the rest, so the caller hears the bot start within a millisecond of the answer
// landing instead of a second and a half later.
//
// Off by default, because measured it does not buy what it looks like it buys. The
// opener is half a second of sound and the piece behind it needs a second to start
// arriving, so the silence does not go away — it moves from in front of the line to
// the middle of it, 400 to 1100 ms after "Got it,". Silence before the bot speaks
// reads as thinking. The same silence one word in reads as a dropped line.
//
// Kept because it is the right shape if the front piece ever gets long enough to
// cover the gap, and because it costs one environment variable to hear it:
// TTS_SPLIT_OPENERS=on.
const OPENERS = [/^Got it,(?=\s)/, /^Okay,(?=\s)/, /^Okay\.(?=\s)/, /^No problem\.(?=\s)/, /^Sorry,(?=\s)/];
const OPENER_TEXT = ['Got it,', 'Okay,', 'Okay.', 'No problem.', 'Sorry,'];
const SPLIT_OPENERS = /^(1|on|true|yes)$/i.test(String(process.env.TTS_SPLIT_OPENERS || 'off'));

function splitOpener(part) {
  if (!SPLIT_OPENERS) return [part];
  for (const re of OPENERS) {
    const m = part.text.match(re);
    if (!m) continue;
    const rest = part.text.slice(m[0].length).trim();
    if (!rest) break;
    return [
      { text: m[0], spelled: false },
      { text: rest, spelled: SPELLED_OUT.test(rest) },
    ];
  }
  return [part];
}

// ---------- lines that never change ----------
//
// Every question the form asks is the same string on every call, and paying the
// speech endpoint a second of first-byte latency to hear "And the city?" again is a
// second of silence the caller sits through for nothing. Those are made once, kept as
// finished u-law on disk, and played straight off it. A warmed line reaches the
// carrier in the time it takes to read a file.
//
// Only lines put through warm() are ever stored, and warm() is given the form's fixed
// text. Nothing a caller said reaches this folder: a cached read-back would be
// somebody's account number sitting in a file, and it would be a single generated
// take frozen in place — including a short one.
const cacheDir = () => process.env.TTS_CACHE_DIR || path.join(__dirname, '..', 'data', 'tts');
const warmed = new Map();

const cacheKey = (text) =>
  crypto
    .createHash('sha1')
    .update(JSON.stringify([modelFor(text), TTS_VOICE, styleFor(text), speedFor(text), text]))
    .digest('hex');

function sliceFrames(buf) {
  const frames = [];
  for (let i = 0; i < buf.length; i += FRAME_BYTES) {
    frames.push(buf.subarray(i, i + FRAME_BYTES).toString('base64'));
  }
  return frames;
}

// The same split as segments(), except that a sentence already made stands on its
// own rather than being joined to its neighbour.
//
// "Got it, 473. And the city?" is two ordinary sentences and segments() joins them
// into one request. The second half is a question the form asks on every call and is
// sitting on disk, so joining them means paying the endpoint to say it again, and
// paying for it in front of the caller. Split, only "Got it, 473." is generated, the
// question follows it out of the cache, and the first sound arrives sooner because a
// short input starts arriving sooner than a long one.
function piecesOf(text) {
  const out = [];
  for (const raw of sentencesOf(text)) {
    const piece = raw.trim();
    if (!piece) continue;
    const ready = warmed.get(piece) || null;
    const spelled = SPELLED_OUT.test(piece);
    const last = out[out.length - 1];
    if (last && !last.ready && !ready && last.spelled === spelled) last.text += ` ${piece}`;
    else out.push({ text: piece, spelled, ready });
  }
  if (out.length) {
    // A run that was joined back together may itself be a line that was warmed whole
    // — the greeting is two sentences and is stored as one.
    for (const part of out) if (!part.ready) part.ready = warmed.get(part.text) || null;
    return out;
  }
  const whole = String(text || '').trim();
  return whole ? [{ text: whole, spelled: SPELLED_OUT.test(whole), ready: warmed.get(whole) || null }] : [];
}

// Make the audio for a fixed set of lines, or load it if a previous run made it.
// Returns what it did, so the server can say so at startup.
async function warm(lines, opts = {}) {
  const dir = cacheDir();
  let made = 0;
  let loaded = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { made, loaded, held: warmed.size, skipped: 0 };
  }
  let skipped = 0;
  for (const line of lines) {
    for (const seg of segments(line)) {
      // The spelling engine's output is a generated take and its text carries the
      // caller's value, so neither half of it belongs in a cache.
      if (seg.spelled || warmed.has(seg.text)) {
        skipped += 1;
        continue;
      }
      const file = path.join(dir, `${cacheKey(seg.text)}.ulaw`);
      let audio = null;
      try {
        audio = fs.readFileSync(file);
        loaded += 1;
      } catch {
        audio = null;
      }
      if (!audio) {
        const frames = [];
        for await (const f of speechStream(seg.text, opts)) frames.push(Buffer.from(f, 'base64'));
        audio = Buffer.concat(frames);
        if (!audio.length) continue;
        try {
          fs.writeFileSync(file, audio);
        } catch {
          // A cache that cannot be written is a slow call, not a broken one.
        }
        made += 1;
      }
      warmed.set(seg.text, sliceFrames(audio));
    }
  }
  return { made, loaded, held: warmed.size, skipped };
}

// The rate the speech endpoint returns raw samples at, and the rate a phone line runs
// at. 24000 divides by 8000 exactly, so the resample is an average of every three
// samples rather than anything that needs a filter.
const TTS_RATE = 24000;
const PHONE_RATE = 8000;
const STEP = TTS_RATE / PHONE_RATE;

// 20 ms of 8 kHz u-law. One byte per sample, so 160 bytes.
const FRAME_BYTES = 160;

// ---------- G.711 u-law ----------

// The companding law every telephone in North America uses: 14 bits of signed audio
// squeezed into 8, with the steps close together near silence and far apart near the
// peaks, because that is where a human ear can hear the difference.
function linearToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// ---------- 24 kHz down to 8 kHz ----------

// The filter that has to run before the rate drops.
//
// Averaging every three samples was the first attempt and it sounded rough. An
// average of three is a filter, but a bad one: it leaves most of what sits between
// 4 and 8 kHz in place, and at 8 kHz everything above 4 kHz folds back down into
// speech as a hiss that moves with the voice. What is wanted is a proper low-pass
// with its corner at the top of the telephone band, and then take every third sample.
//
// A windowed sinc, 3.4 kHz corner, 48 taps at 24 kHz. Long enough to be steep, short
// enough that the whole thing costs a few microseconds per frame.
const CUTOFF_HZ = 3400;
const TAPS = 48;

const FILTER = (() => {
  const n = TAPS;
  const fc = CUTOFF_HZ / TTS_RATE; // cycles per sample
  const mid = (n - 1) / 2;
  const h = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    // sinc, with the hole at x = 0 filled in by its limit
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    // Blackman window: the sidelobes matter more than the width here, because a
    // sidelobe is exactly the energy that folds back down on decimation.
    const w =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum; // unity gain at DC, so nothing gets louder
  return h;
})();

const HISTORY = TAPS - 1;

// Turns 24 kHz signed 16-bit little-endian into 8 kHz u-law.
//
// `state` carries the tail of the previous call, because a filter needs the samples
// either side of the one it is producing and a stream arrives in arbitrary pieces.
// Without it every chunk boundary is a step in the waveform, and a step is a click.
function makeResampler() {
  // Starts as silence, which is the right thing for the filter to lead in from.
  let history = new Int16Array(HISTORY);
  return function feed(pcm) {
    const incoming = Math.floor(pcm.length / 2);
    const buf = new Int16Array(history.length + incoming);
    buf.set(history, 0);
    for (let i = 0; i < incoming; i++) buf[history.length + i] = pcm.readInt16LE(i * 2);

    // One output for every third input, taking only those whose whole window is
    // present. Everything past the last one consumed stays for the next piece —
    // everything, not a fixed 47: a chunk rarely divides by three, and throwing the
    // remainder away lost up to two samples at every boundary, which over a line is
    // both a shortened line and a click at each seam.
    const outCount = buf.length >= TAPS ? Math.floor((buf.length - TAPS) / STEP) + 1 : 0;
    const out = Buffer.allocUnsafe(outCount);
    for (let j = 0; j < outCount; j++) {
      const start = j * STEP;
      let acc = 0;
      for (let k = 0; k < TAPS; k++) acc += buf[start + k] * FILTER[k];
      let s = Math.round(acc);
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      out[j] = linearToMulaw(s);
    }
    const consumed = outCount * STEP;
    history = buf.slice(consumed);
    return out;
  };
}

// One-shot version, for a whole buffer at once. Used by the tests.
function pcm24kToMulaw8k(pcm) {
  return makeResampler()(pcm);
}

// ---------- the line ----------

// How long to wait for the endpoint before giving up on a request.
//
// fetch has no timeout of its own, so a request that never answers never ends. On a
// call on 13 Aug one hung after the income question: the line was never spoken, the
// promise every later line was queued behind never settled, and because an
// outstanding line also holds the microphone shut and stands the quiet watch down,
// the caller sat in silence for 25 seconds and hung up. Nothing in the log, because
// nothing failed — it simply never returned.
//
// First byte normally arrives in 0.3 to 2.3 seconds, so six is late by any measure
// and still short enough that a retry beats waiting. The second timer covers the
// stream going quiet halfway through, which is the same failure with the headers
// already sent.
const ttsTimeoutMs = () => Number(process.env.TTS_TIMEOUT_MS || 6000);
const ttsStallMs = () => Number(process.env.TTS_STALL_MS || 5000);

// One request, with a clock on it. The caller drives the clock: touch() on every
// chunk that arrives, done() when the body ends, abort() to drop it unread.
function request(text, { apiKey = process.env.OPENAI_API_KEY, signal } = {}) {
  const control = new AbortController();
  let timer = null;
  const stop = (ms, why) => {
    clearTimeout(timer);
    if (ms) timer = setTimeout(() => control.abort(new Error(why)), ms);
  };
  const first = ttsTimeoutMs();
  stop(first, `the speech endpoint sent nothing in ${first} ms`);
  if (signal) signal.addEventListener('abort', () => control.abort(), { once: true });

  const response = fetch(SPEECH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: control.signal,
    body: JSON.stringify({
      model: modelFor(text),
      voice: TTS_VOICE,
      input: text,
      // One or the other: the engine that takes an instruction is told what the line
      // is for, and the one that does not is given a number.
      ...(takesInstructions(modelFor(text))
        ? { instructions: styleFor(text) }
        : { speed: speedFor(text) }),
      // Raw samples. Every other format the endpoint offers is a container that would
      // have to be decoded here first.
      response_format: 'pcm',
    }),
  });
  // Headers arriving only means the endpoint answered; the body can still stall.
  response.then(() => stop(ttsStallMs(), `the speech stream stopped for ${ttsStallMs()} ms`)).catch(() => {});
  return {
    text,
    response,
    touch: () => stop(ttsStallMs(), `the speech stream stopped for ${ttsStallMs()} ms`),
    done: () => stop(0),
    abort: () => {
      stop(0);
      control.abort();
    },
  };
}

// One line of speech, as base64 frames, yielded as they come off the wire.
//
// Waiting for the whole line first cost 1.8 seconds of silence before every question,
// which on a phone call reads as the bot having hung up. The format is raw samples in
// a fixed order with no container around them, so the front of the line can be sent to
// the carrier while the back of it is still being generated, and the caller hears
// speech about a third of a second after the server decides to speak.
//
// Two remainders are carried across chunks: input bytes that do not divide into whole
// groups of three samples, and output bytes that do not fill a 20 ms frame. Dropping
// either one puts a click in the audio at every chunk boundary.
async function* framesOf(req) {
  const res = await req.response;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    req.done();
    throw new Error(`speech ${res.status}: ${detail.slice(0, 200)}`);
  }
  const resample = makeResampler();
  let pcmCarry = Buffer.alloc(0);
  let outCarry = Buffer.alloc(0);
  let bytes = 0;

  for await (const chunk of res.body) {
    // The stream is alive, so the clock that would abort it starts again.
    req.touch();
    // Whole samples only: a chunk can end in the middle of one, and reading half a
    // sample as a whole one puts a spike in the audio.
    const buf = Buffer.concat([pcmCarry, Buffer.from(chunk)]);
    const usable = buf.length - (buf.length % 2);
    pcmCarry = buf.subarray(usable);
    if (!usable) continue;
    outCarry = Buffer.concat([outCarry, resample(buf.subarray(0, usable))]);
    while (outCarry.length >= FRAME_BYTES) {
      yield outCarry.subarray(0, FRAME_BYTES).toString('base64');
      outCarry = outCarry.subarray(FRAME_BYTES);
      bytes += FRAME_BYTES;
    }
  }
  // The tail, padded to a whole frame with u-law silence (0xFF) so the carrier is
  // never handed a short one.
  if (outCarry.length) {
    const last = Buffer.alloc(FRAME_BYTES, 0xff);
    outCarry.copy(last);
    yield last.toString('base64');
    bytes += FRAME_BYTES;
  }
  req.done();
  return bytes / PHONE_RATE;
}

// One line of speech, as base64 frames, in the order they are to be played.
//
// A line is one or more pieces, and a piece is either already made — a fixed question
// warmed onto disk — or a request to the speech endpoint. Every request goes out at
// once, before the first frame of the first piece is handed over, because the pieces
// are played back to back and the carrier plays what it has: a piece whose request
// starts only when the piece before it starts is a hole in the middle of the line.
// Sent together, the second piece is generating while the first is still playing and
// arrives well before it is needed. Three or four small requests at once is what a
// line costs; the alternative is measured in seconds of silence mid-sentence.
async function* speechStream(text, opts = {}) {
  const split = piecesOf(text);
  // Only the front of the line, and only when the front is not already made.
  const parts =
    SPLIT_OPENERS && split.length && !split[0].ready
      ? [...splitOpener(split[0]).map((p) => ({ ...p, ready: warmed.get(p.text) || null })), ...split.slice(1)]
      : split;
  // The rejection is caught here so an unawaited request cannot take the process
  // down; awaiting the same one below still throws, which is where it is handled.
  const start = (part) => {
    if (part.ready) return null;
    const req = request(part.text, opts);
    req.response.catch(() => {});
    return req;
  };
  const inflight = parts.map(start);

  try {
    for (let i = 0; i < parts.length; i++) {
      const ready = parts[i].ready;
      if (ready) {
        yield* ready;
        continue;
      }
      let sent = 0;
      try {
        for await (const frame of framesOf(inflight[i])) {
          sent += 1;
          yield frame;
        }
      } catch (e) {
        // One more attempt, and only while nothing has reached the caller yet. Past
        // the first frame a second take would repeat audio they have already heard,
        // in a different reading of the line, halfway through a sentence. A request
        // that timed out with nothing to show is usually one that would have worked.
        if (sent) throw e;
        inflight[i] = start(parts[i]);
        yield* framesOf(inflight[i]);
      }
      inflight[i] = null;
    }
  } finally {
    // A caller who hangs up mid-line, or a piece that failed, leaves the rest of the
    // line arriving at a socket nobody is reading, and a timer holding the process.
    for (const req of inflight) if (req) req.abort();
  }
}

// The whole line at once. Used by the tests and by anything that wants the length
// before it starts playing.
async function speechFrames(text, opts = {}) {
  const frames = [];
  for await (const f of speechStream(text, opts)) frames.push(f);
  return { frames, seconds: (frames.length * FRAME_BYTES) / PHONE_RATE };
}

module.exports = {
  makeResampler,
  segments,
  piecesOf,
  splitOpener,
  OPENER_TEXT,
  warm,
  warmed,
  styleFor,
  speedFor,
  modelFor,
  TTS_STYLE_PLAIN,
  TTS_STYLE_SPELLED,
  TTS_SPEED_PLAIN,
  TTS_SPEED_SPELLED,
  speechStream,
  speechFrames,
  pcm24kToMulaw8k,
  linearToMulaw,
  FRAME_BYTES,
  PHONE_RATE,
};
