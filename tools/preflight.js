// preflight.js — does the pipeline work?
//
//   node tools/preflight.js
//
// Everything between the caller and the email has tests except one link: the
// WebSocket to OpenAI's Realtime API. The session shape, the audio format object
// and the event names in src/agent.js and src/bridge.js are written from the
// documentation and have never met the live API. That is the only part of this
// project that can be wrong in a way nothing here would catch.
//
// This opens that socket for real, sends the exact session.update the bot sends,
// asks for one short spoken reply, and reports whether audio came back in the event
// the bridge listens for. It costs a few cents and takes about fifteen seconds.
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

const VOICE = process.env.OPENAI_VOICE || 'alloy';

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

// ---------- 3. the live Realtime session ----------

// Opens the socket exactly as bridge.js does, sends the same session.update, and
// asks for one short line of speech. Resolves with what actually came back.
function tryModel(model) {
  return new Promise((resolve) => {
    const seen = {
      opened: false,
      sessionUpdated: false,
      audioEvent: null,
      audioBytes: 0,
      transcript: '',
      error: null,
      handshake: null,
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
      ws.send(JSON.stringify(agent.sessionUpdate({ model, voice: VOICE })));
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
        // One short line, so the reply is cheap and the audio path is exercised.
        ws.send(
          JSON.stringify({
            type: 'response.create',
            response: { instructions: 'Say exactly: preflight check complete.' },
          }),
        );
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

async function checkRealtime() {
  heading('OpenAI Realtime (the only untested link)');
  if (!process.env.OPENAI_API_KEY) {
    bad('Realtime session', 'no OPENAI_API_KEY, skipping the live check');
    note('This is the one thing preflight exists to test. Everything above passes without it.');
    return;
  }

  for (const model of MODELS) {
    process.stdout.write(`        trying ${model} … `);
    const r = await tryModel(model);
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

    if (model !== process.env.OPENAI_REALTIME_MODEL) {
      note(`set OPENAI_REALTIME_MODEL=${model} in .env`);
    }
    return;
  }

  bad('Realtime session', 'no model name worked — check the key and its billing');
}

// ---------- 4. what to do next ----------

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
  await checkRealtime();

  const failed = results.filter((r) => !r.pass);
  heading(failed.length ? `${failed.length} check(s) failed` : 'All checks passed');
  for (const f of failed) console.log(`        ${f.name}: ${f.detail || ''}`);
  if (!failed.length) nextSteps();
  console.log('');
  process.exit(failed.length ? 1 : 0);
})();
