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

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
// tts-1, not gpt-4o-mini-tts.
//
// The newer model speaks slowly. Not "carefully" — slowly: "And the city?" takes it
// 1.45 seconds, where tts-1 says the same three words in 0.78 and a person says them
// in less. Over a form with two dozen questions that is most of a minute of the
// caller waiting through sentences, and it is what "a bit slow and stuttering" was.
// Its `speed` control does not fix it either; asking for 1.15 came back LONGER than
// default, so the number is not being applied in any dependable way.
//
// What is given up is the `instructions` field, which tts-1 does not take, so the
// pacing hint for a spelled-out read-back is gone. That turned out to cost nothing:
// single characters separated by spaces are read one at a time regardless.
// TTS_MODEL=gpt-4o-mini-tts puts it back with its style instructions attached.
const TTS_MODEL = process.env.TTS_MODEL || 'tts-1';
const TTS_VOICE = process.env.TTS_VOICE || 'alloy';
// Pace, and there are two of them, because the two kinds of line want opposite
// things. An ordinary question is a sentence and wants to be over with; a read-back
// is a string of single characters the caller is checking one at a time against
// something in their hand, and at conversational pace it goes past faster than they
// can follow. One number for both made the greeting drag and the spelling a blur.
//
// Measure on a long line, not a short one. Short samples are dominated by how much
// generation varies between requests: 0.9, 1.0 and 1.05 all came back within 40 ms of
// each other on a three word question, which reads as "speed does nothing", while the
// same three values on the greeting came back 12.1, 10.7 and 9.6 seconds.
const TTS_SPEED_PLAIN = Number(process.env.TTS_SPEED_PLAIN || process.env.TTS_SPEED || 1.05);
const TTS_SPEED_SPELLED = Number(process.env.TTS_SPEED_SPELLED || 0.75);
const speedFor = (text) => (SPELLED_OUT.test(text) ? TTS_SPEED_SPELLED : TTS_SPEED_PLAIN);
// Which models take a free-text delivery note. The older ones reject the field.
const TAKES_INSTRUCTIONS = /^gpt-/.test(TTS_MODEL);

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

// For a line that spells something out, which is the one place the gaps earn their
// cost: a caller checking a routing number digit by digit cannot follow it at speed.
const TTS_STYLE_SPELLED =
  process.env.TTS_STYLE_SPELLED ||
  'Calm and clear, like a person taking down a form over the phone. Read the run of ' +
    'single digits or letters one at a time with a small gap between them. Speak the ' +
    'rest of the line at a normal pace.';

// A read-back spells its value out as single characters separated by spaces, which is
// a shape no ordinary sentence has. Three in a row is enough to recognise it and not
// enough for "a b" in ordinary text to trip it.
const SPELLED_OUT = /(?:(?:^|\s)[A-Za-z0-9](?=\s)){3,}/;
const styleFor = (text) => (SPELLED_OUT.test(text) ? TTS_STYLE_SPELLED : TTS_STYLE_PLAIN);

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

function request(text, { apiKey = process.env.OPENAI_API_KEY, signal } = {}) {
  return fetch(SPEECH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      ...(TAKES_INSTRUCTIONS ? { instructions: styleFor(text) } : {}),
      ...(TAKES_INSTRUCTIONS ? {} : { speed: speedFor(text) }),
      // Raw samples. Every other format the endpoint offers is a container that would
      // have to be decoded here first.
      response_format: 'pcm',
    }),
    signal,
  });
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
async function* speechStream(text, opts = {}) {
  const res = await request(text, opts);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`speech ${res.status}: ${detail.slice(0, 200)}`);
  }
  const resample = makeResampler();
  let pcmCarry = Buffer.alloc(0);
  let outCarry = Buffer.alloc(0);
  let bytes = 0;

  for await (const chunk of res.body) {
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
  return bytes / PHONE_RATE;
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
  styleFor,
  speedFor,
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
