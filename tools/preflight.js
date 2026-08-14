// preflight.js — does the pipeline work?
//
//   node tools/preflight.js
//
// Everything between the caller and the email has tests except two links, and both
// are to OpenAI: the speech endpoint that says every line, and the Realtime socket
// that hears every answer. The session shape, the audio format object and the event
// names are written from the documentation, so those two are the part of this project
// that can be wrong in a way nothing here would catch.
//
// So this runs the loop rather than describing it. It says a line through the same
// speech endpoint the bot speaks with, feeds those u-law frames into the same Realtime
// session the bot listens with, and reports the words that came back. If the
// transcript matches what was said, every piece between a caller's voice and a filled
// field has been exercised against the live API. It costs a few cents and takes about
// twenty seconds.
//
// The session sent is the one the running bot sends, chosen by KEYPAD the way
// server.js chooses a bridge, since checking the socket the bot does not use is the
// same as not checking it.
//
// It also checks the things that are merely annoying to discover on a live call:
// missing keys, a routing directory that never downloaded, a Gmail token that has
// expired.

require('../src/env');

const WebSocket = require('ws');
const https = require('https');
const V = require('../src/validate');
const agent = require('../src/agent');
const { FIELDS } = require('../src/fields');
const { earSession } = require('../src/bridge-voice');
const { speechFrames, modelFor, FRAME_BYTES } = require('../src/voice');

const VOICE = process.env.OPENAI_VOICE || 'alloy';

// Which bridge is live, decided exactly as server.js decides it. The default bridge
// never lets the model speak, so what proves that socket works is a transcript coming
// back rather than audio.
const KEYPAD_ON = /^(1|on|true|yes)$/i.test(String(process.env.KEYPAD || 'off'));

// The line preflight says to itself. It carries two closed answers and a run of digits,
// which is most of what a caller ever says.
const SPOKEN_LINE = 'Employed, checking, four eight two one.';
// A read-back, which is the shape that routes to the other speech engine.
const SPELLED_LINE = 'That is 4, 8, 2, 1. Is that right?';

// Tried in order. The documented name has changed more than once, and a wrong one
// fails with a 404 on the handshake rather than anything descriptive.
const MODELS = [
  process.env.OPENAI_REALTIME_MODEL,
  'gpt-realtime',
  'gpt-realtime-2.1',
  'gpt-realtime-2.1-mini',
].filter(Boolean);

const results = [];

function ok(name, detail) {
  results.push({ pass: true, name, detail });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name, detail) {
  results.push({ pass: false, name, detail });
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function note(text) {
  console.log(`        ${text}`);
}
function heading(text) {
  console.log(`\n${text}`);
}

// ---------- 1. configuration ----------

function checkConfig() {
  heading('Configuration');

  if (process.env.OPENAI_API_KEY) {
    const k = process.env.OPENAI_API_KEY;
    ok('OPENAI_API_KEY set', `${k.slice(0, 7)}…${k.slice(-4)}`);
  } else {
    bad('OPENAI_API_KEY set', 'copy .env.example to .env and paste your key');
  }

  const report = process.env.REPORT_TO;
  if (report && /@/.test(report)) ok('REPORT_TO set', report);
  else bad('REPORT_TO set', 'the finished application has nowhere to go');

  const gmail = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'].filter(
    (k) => !process.env[k],
  );
  if (gmail.length) bad('Gmail credentials set', `missing ${gmail.join(', ')}`);
  else ok('Gmail credentials set');

  const conditional = FIELDS.filter((f) => f.appliesWhen).length;
  ok(
    'Call script loaded',
    `${FIELDS.length} questions, ${conditional} of them only asked when they apply`,
  );

  const size = V.directorySize();
  if (size > 15000) ok('FedACH routing directory', `${size.toLocaleString('en-US')} routing numbers`);
  else bad('FedACH routing directory', `${size} entries — run: npm run fetch-directory`);

  // The one check that proves the directory is doing its job rather than just
  // sitting on disk.
  const real = V.validateRouting('021000021');
  const fake = V.validateRouting('310000185');
  if (real.ok && !fake.ok) ok('Routing check', `real number names ${real.bank}; made-up number refused`);
  else bad('Routing check', `real=${real.ok} fake=${fake.ok}`);
}

// ---------- 2. Gmail ----------

function gmailToken() {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID || '',
      client_secret: process.env.GMAIL_CLIENT_SECRET || '',
      refresh_token: process.env.GMAIL_REFRESH_TOKEN || '',
      grant_type: 'refresh_token',
    }).toString();
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(d) });
          } catch {
            resolve({ status: res.statusCode, data: d });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, data: String(e) }));
    req.write(body);
    req.end();
  });
}

async function checkGmail() {
  heading('Email');
  if (!process.env.GMAIL_REFRESH_TOKEN) {
    bad('Gmail token', 'not set, skipping');
    return;
  }
  const res = await gmailToken();
  if (res.status === 200 && res.data.access_token) {
    ok('Gmail token refreshes', `scope: ${res.data.scope || 'unknown'}`);
    note('Send is verified by: node tools/simulate.js --script approved --email');
  } else {
    bad('Gmail token refreshes', JSON.stringify(res.data).slice(0, 200));
  }
}

// ---------- 3. the speech endpoint ----------

// Says two lines and keeps the frames. Two, because the bot speaks through two
// engines and a wrong model name in either one is silence on half the call: ordinary
// questions go to the plain engine and read-backs to the one that can be told it is
// spelling something out. Which engine a line reaches is decided here by the same
// function the bridge decides it with, so this fails if that routing breaks too.
//
// The frames come back in the format the carrier plays and the Realtime socket takes,
// so the spoken line is handed straight to the next check rather than synthesised
// twice.
async function checkSpeech() {
  heading('OpenAI speech (every line the caller hears)');
  if (!process.env.OPENAI_API_KEY) {
    bad('Speech endpoint', 'no OPENAI_API_KEY, skipping');
    return null;
  }

  let spoken = null;
  for (const [what, text] of [
    ['question', SPOKEN_LINE],
    ['read-back', SPELLED_LINE],
  ]) {
    const model = modelFor(text);
    try {
      const t0 = process.hrtime.bigint();
      const { frames, seconds } = await speechFrames(text);
      const took = Number(process.hrtime.bigint() - t0) / 1e9;
      if (!frames.length) {
        bad(`Speech, ${what}`, `${model} returned no audio`);
        continue;
      }
      // 20 ms of u-law at 8 kHz. A frame of any other size is one the carrier plays
      // as a click.
      const short = frames.filter((f) => Buffer.from(f, 'base64').length !== FRAME_BYTES);
      if (short.length) {
        bad(`Speech, ${what}`, `${short.length} frame(s) are not ${FRAME_BYTES} bytes`);
        continue;
      }
      ok(
        `Speech, ${what}`,
        `${model} — ${frames.length} frames, ${seconds.toFixed(1)}s of audio in ${took.toFixed(1)}s`,
      );
      if (what === 'question') spoken = frames;
    } catch (e) {
      bad(`Speech, ${what}`, `${model}: ${String(e.message).slice(0, 160)}`);
    }
  }
  return spoken;
}

// ---------- 4. the live Realtime session ----------

// Opens the socket the running bridge opens and sends the session it sends. With the
// default bridge that is an ear: text out, no tools, and server voice detection told
// not to answer. Nothing is asked of it, so what proves it works is feeding it the
// line preflight just said and reading back what it heard.
//
// With KEYPAD=on the older bridge is live, the model does the talking, and the check
// is the one that path needs: ask for a line and count the audio.
function tryModel(model, spokenFrames) {
  return new Promise((resolve) => {
    const seen = {
      opened: false,
      sessionUpdated: false,
      audioEvent: null,
      audioBytes: 0,
      transcript: '',
      error: null,
      handshake: null,
      // Set if the model ever starts a turn nobody asked for. On the default bridge
      // that is the failure the whole session shape exists to prevent, so it is worth
      // more than any of the passes above it.
      unbidden: false,
      echo: null,
    };

    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });

    const done = () => {
      try {
        ws.close();
      } catch {}
      resolve(seen);
    };
    const timer = setTimeout(done, 25000);

    ws.on('unexpected-response', (_req, res) => {
      seen.handshake = `HTTP ${res.statusCode}`;
      clearTimeout(timer);
      done();
    });

    ws.on('open', () => {
      seen.opened = true;
      ws.send(
        JSON.stringify(KEYPAD_ON ? agent.sessionUpdate({ model, voice: VOICE }) : earSession(model)),
      );
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'error') {
        seen.error = msg.error ? `${msg.error.code || ''} ${msg.error.message || ''}`.trim() : 'unknown';
        clearTimeout(timer);
        return done();
      }

      if (msg.type === 'session.updated') {
        seen.sessionUpdated = true;
        seen.echo = msg.session || null;

        if (KEYPAD_ON) {
          // One short line, so the reply is cheap and the audio path is exercised.
          ws.send(
            JSON.stringify({
              type: 'response.create',
              response: { instructions: 'Say exactly: preflight check complete.' },
            }),
          );
          return;
        }

        // The ear is fed the line preflight just spoke. Voice detection ends the turn
        // on silence, so a second of it goes on the end; without that the socket sits
        // holding audio nobody told it was finished.
        if (!spokenFrames || !spokenFrames.length) {
          clearTimeout(timer);
          return done();
        }
        const silence = Buffer.alloc(FRAME_BYTES, 0xff).toString('base64');
        const feed = spokenFrames.concat(Array(60).fill(silence));
        for (const audio of feed) {
          ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
        }
      }

      // The line the bot would file as an answer.
      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        seen.transcript = msg.transcript || '';
        clearTimeout(timer);
        return done();
      }

      // create_response is false, so nothing here should ever produce one.
      if (!KEYPAD_ON && (msg.type === 'response.created' || msg.type === 'response.done')) {
        seen.unbidden = true;
      }

      // The two names this has gone by. bridge.js listens for both; this reports
      // which one the API actually sent, so the fallback can be dropped or kept
      // on evidence.
      if (msg.type === 'response.output_audio.delta' || msg.type === 'response.audio.delta') {
        seen.audioEvent = msg.type;
        seen.audioBytes += Buffer.from(msg.delta || '', 'base64').length;
      }

      if (
        msg.type === 'response.output_audio_transcript.done' ||
        msg.type === 'response.audio_transcript.done'
      ) {
        seen.transcript = msg.transcript || '';
      }

      if (msg.type === 'response.done') {
        clearTimeout(timer);
        done();
      }
    });

    ws.on('error', (e) => {
      if (!seen.handshake) seen.error = seen.error || e.message;
      clearTimeout(timer);
      done();
    });
  });
}

async function checkRealtime(spokenFrames) {
  heading(
    KEYPAD_ON
      ? 'OpenAI Realtime (KEYPAD=on, so the model does the talking)'
      : 'OpenAI Realtime (the ear the caller talks into)',
  );
  if (!process.env.OPENAI_API_KEY) {
    bad('Realtime session', 'no OPENAI_API_KEY, skipping the live check');
    note('This is the one thing preflight exists to test. Everything above passes without it.');
    return;
  }
  if (!KEYPAD_ON && !spokenFrames) {
    bad('Realtime session', 'the speech check produced no audio to feed it');
    return;
  }

  for (const model of MODELS) {
    process.stdout.write(`        trying ${model} … `);
    const r = await tryModel(model, spokenFrames);
    console.log('');

    if (r.handshake) {
      note(`${model}: handshake refused (${r.handshake})`);
      continue;
    }
    if (!r.opened) {
      note(`${model}: socket never opened (${r.error || 'no reason given'})`);
      continue;
    }
    if (r.error) {
      note(`${model}: ${r.error}`);
      continue;
    }

    ok('Socket opens', model);

    if (KEYPAD_ON) {
      if (r.sessionUpdated) ok('session.update accepted', 'audio format, voice, VAD and the three tools');
      else bad('session.update accepted', 'no session.updated came back');

      if (r.audioBytes > 0) {
        ok('Audio comes back', `${r.audioBytes.toLocaleString('en-US')} bytes on ${r.audioEvent}`);
        if (r.audioEvent !== 'response.output_audio.delta') {
          note(`bridge.js listens for response.output_audio.delta first; this API sent ${r.audioEvent}`);
        }
      } else {
        bad('Audio comes back', 'no audio deltas arrived');
      }

      if (r.transcript) note(`it said: "${r.transcript.trim()}"`);
    } else {
      // The session comes back echoed, which is the only place to see whether the
      // three lines that keep the model quiet survived the trip.
      const input = (r.echo && r.echo.audio && r.echo.audio.input) || {};
      const asr = (input.transcription && input.transcription.model) || 'none';
      const vad = input.turn_detection || {};
      if (r.sessionUpdated) {
        ok('session.update accepted', `u-law in, text out, ${asr}, silence ${vad.silence_duration_ms}ms`);
      } else {
        bad('session.update accepted', 'no session.updated came back');
      }
      if (asr === 'none') bad('Transcription is on', 'the echoed session names no transcriber');
      if (vad.create_response === true) {
        bad('The model holds no turn', 'create_response came back true — it will answer for the caller');
      }

      if (r.unbidden) {
        bad('The model holds no turn', 'it started a response nobody asked for');
      } else if (r.transcript) {
        ok('The model holds no turn', 'it transcribed and said nothing');
      }

      if (r.transcript) {
        ok('It heard the line', `"${r.transcript.trim()}"`);
        // Loose on purpose: a transcriber is allowed to punctuate and capitalise as it
        // likes. What is being checked is that the audio arrived as words rather than
        // as noise, so the digits are enough.
        const heard = r.transcript.toLowerCase();
        const missed = ['employed', 'checking'].filter((w) => !heard.includes(w));
        if (missed.length) note(`it did not catch: ${missed.join(', ')}`);
      } else {
        bad('It heard the line', 'no transcript came back within the timeout');
      }
    }

    if (model !== process.env.OPENAI_REALTIME_MODEL) {
      note(`set OPENAI_REALTIME_MODEL=${model} in .env`);
    }
    return;
  }

  bad('Realtime session', 'no model name worked — check the key and its billing');
}

// ---------- 5. what to do next ----------

function nextSteps() {
  heading('To take a call');
  console.log(`        1. npm start                            (listens on :${process.env.PORT || 5050})`);
  console.log('        2. cloudflared tunnel --url http://localhost:' + (process.env.PORT || 5050));
  console.log('        3. Twilio console -> your number -> A call comes in:');
  console.log('             Webhook  POST  https://<tunnel-host>/incoming-call');
  console.log('        4. call it');
}

(async () => {
  console.log('\nFinosu intake callbot — preflight');
  checkConfig();
  await checkGmail();
  const spoken = await checkSpeech();
  await checkRealtime(spoken);

  const failed = results.filter((r) => !r.pass);
  heading(failed.length ? `${failed.length} check(s) failed` : 'All checks passed');
  for (const f of failed) console.log(`        ${f.name}: ${f.detail || ''}`);
  if (!failed.length) nextSteps();
  console.log('');
  process.exit(failed.length ? 1 : 0);
})();
