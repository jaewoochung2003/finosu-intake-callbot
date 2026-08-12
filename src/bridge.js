// bridge.js — one phone call.
//
// Twilio sends the caller's audio over a WebSocket as base64 G.711 u-law at 8 kHz.
// OpenAI's Realtime API takes and returns the same encoding, so the audio is copied
// across in both directions untouched: no resampling, no transcoding, no buffering
// beyond what the sockets already do. Everything interesting in this file is the
// two things that are not audio.
//
//   Tool calls. The model calls save_answer with what it heard. intake.js validates
//   it and hands back the next question, which becomes the model's next line. The
//   model never chooses what to ask and never decides anything.
//
//   Keypad digits. Twilio delivers touch-tone presses as dtmf events on the same
//   socket. For the social security digits, the routing number, the account number,
//   the zip and phone numbers, those digits go straight into the record and skip
//   speech recognition completely. A misheard word in a routing number is a wrong
//   bank; this is the path that removes that failure.
//
// Interruption: when the caller starts talking over the bot, Twilio's already-queued
// audio is dropped with a clear event and the model's in-flight response is
// cancelled, otherwise the bot keeps talking into a conversation that moved on.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const intake = require('./intake');
const V = require('./validate');
const agent = require('./agent');
const format = require('./format');
const { sendEmail } = require('./email');

const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const VOICE = process.env.OPENAI_VOICE || 'alloy';
const REPORT_TO = process.env.REPORT_TO || 'jaewoochung2003@gmail.com';
const CALLS_DIR = path.join(__dirname, '..', 'calls');

// A keypad entry is finished by the # key, by reaching the expected digit count, or
// by the caller stopping for this long.
const DTMF_IDLE_MS = 2500;
// After a keypad entry lands, ignore anything the model tries to save for a moment;
// it may still be transcribing the tones as speech.
const DTMF_SUPPRESS_MS = 2500;
// A much shorter deaf window on the keypad itself, long enough to swallow the extra
// press on an overtyped fixed-length field and short enough that it cannot block the
// next field: the caller has to hear the next question before answering it, and the
// save-answer window above is far too long for that job.
const DTMF_DEAF_MS = 800;
// Hard stop on how long the sockets stay open after the decision, waiting for the
// closing line to finish playing.
const CLOSE_MAX_MS = 15000;

function log(callSid, ...args) {
  console.log(`[${callSid || '----'}]`, ...args);
}

// `openWebSocket`, `deliver` and `callsDir` exist so a test can drive this with
// fake sockets. Nothing else passes them; the defaults are the real thing.
function handleCall(twilioWs, opts = {}) {
  const {
    openaiApiKey,
    openWebSocket = (url, options) => new WebSocket(url, options),
    deliver = sendEmail,
    callsDir = CALLS_DIR,
  } = opts;

  const session = intake.startSession({ earlyKnockout: process.env.EARLY_KNOCKOUT !== '0' });

  let streamSid = null;
  let finished = false;
  let dtmfBuffer = '';
  let dtmfField = null;
  let dtmfTimer = null;
  let suppressSavesUntil = 0;
  let dtmfDeafUntil = 0;
  const handledCalls = new Set();
  let markQueue = [];

  const openaiWs = openWebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${openaiApiKey}` } },
  );

  const toOpenai = (obj) => {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(obj));
  };
  const toTwilio = (obj) => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(obj));
  };

  // Ask the model to say a specific line next. Used for the greeting, for keypad
  // confirmations, and for the closing line, all of which originate on this side.
  const speak = (line, { cancelFirst = false } = {}) => {
    if (cancelFirst) toOpenai({ type: 'response.cancel' });
    toOpenai({
      type: 'response.create',
      response: { instructions: `Say this to the caller, in your own voice: "${line}"` },
    });
  };

  // ---------- OpenAI side ----------

  openaiWs.on('open', () => {
    toOpenai(agent.sessionUpdate({ model: OPENAI_MODEL, voice: VOICE }));
    const first = intake.nextPrompt(session);
    speak(`${intake.GREETING} ${first}`);
  });

  openaiWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'error':
        log(session.callSid, 'openai error:', JSON.stringify(msg.error || msg));
        break;

      // Audio back to the caller. The payload is already u-law base64.
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (msg.delta && streamSid) {
          toTwilio({ event: 'media', streamSid, media: { payload: msg.delta } });
          toTwilio({ event: 'mark', streamSid, mark: { name: 'chunk' } });
          markQueue.push('chunk');
        }
        break;

      // The caller started talking over the bot.
      case 'input_audio_buffer.speech_started':
        if (markQueue.length && streamSid) {
          toTwilio({ event: 'clear', streamSid });
          toOpenai({ type: 'response.cancel' });
          markQueue = [];
        }
        break;

      // The console is a log file. This fires on every caller turn including the
      // social security, routing number and account number questions, so it is
      // redacted against whichever field is open rather than printed raw.
      case 'conversation.item.input_audio_transcription.completed': {
        if (!msg.transcript) break;
        const open = intake.currentField(session);
        log(
          session.callSid,
          'caller:',
          V.redact(open ? open.key : '', msg.transcript.slice(0, 120)),
        );
        break;
      }

      case 'response.function_call_arguments.done':
        onToolCall(msg.call_id, msg.name, msg.arguments);
        break;

      case 'response.done': {
        for (const item of msg.response?.output || []) {
          if (item.type === 'function_call') onToolCall(item.call_id, item.name, item.arguments);
        }
        break;
      }

      default:
        break;
    }
  });

  openaiWs.on('close', () => log(session.callSid, 'openai socket closed'));
  openaiWs.on('error', (e) => log(session.callSid, 'openai socket error:', e.message));

  // ---------- tools ----------

  function onToolCall(callId, name, argsJson) {
    if (!callId || handledCalls.has(callId)) return;
    handledCalls.add(callId);

    let args = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      args = {};
    }

    let result;
    if (name === 'save_answer') {
      if (Date.now() < suppressSavesUntil) {
        result = {
          accepted: false,
          problem: 'already captured from the keypad',
          say_next: intake.nextPrompt(session),
        };
      } else {
        result = toResult(intake.submit(session, String(args.answer ?? '')));
      }
    } else if (name === 'redo_previous') {
      const back = intake.undoLast(session);
      result = back
        ? toResult(back)
        : { accepted: false, problem: 'nothing to go back to', say_next: intake.nextPrompt(session) };
    } else if (name === 'end_call') {
      log(session.callSid, 'caller ended:', args.reason);
      result = toResult(intake.complete(session));
    } else {
      result = { accepted: false, problem: `unknown tool ${name}` };
    }

    toOpenai({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    });
    toOpenai({ type: 'response.create' });

    if (result.done) closeOut('script complete');
  }

  function toResult(r) {
    if (!r) return { accepted: false, say_next: intake.nextPrompt(session) };
    return {
      accepted: !!r.accepted,
      problem: r.problem || null,
      note: r.note || null,
      // Fields the caller has to be able to catch an error on: the email address and
      // the two bank numbers. The model is told to say the value back before it asks
      // the next question.
      read_back: !!r.readBack,
      say_next: r.say || null,
      done: !!r.done,
    };
  }

  // ---------- Twilio side ----------

  twilioWs.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    switch (data.event) {
      case 'start':
        streamSid = data.start.streamSid;
        session.callSid = data.start.callSid || session.callSid;
        session.from = data.start.customParameters?.from || session.from;
        log(session.callSid, 'stream started from', session.from || 'unknown');
        break;

      case 'media':
        toOpenai({ type: 'input_audio_buffer.append', audio: data.media.payload });
        break;

      case 'dtmf':
        onDtmf(data.dtmf.digit);
        break;

      case 'mark':
        markQueue.shift();
        break;

      case 'stop':
        log(session.callSid, 'stream stopped');
        closeOut('caller hung up');
        break;

      default:
        break;
    }
  });

  twilioWs.on('close', () => closeOut('socket closed'));
  twilioWs.on('error', (e) => log(session.callSid, 'twilio socket error:', e.message));

  // ---------- keypad ----------

  function onDtmf(digit) {
    const field = intake.currentField(session);
    if (!field || !field.dtmf) return; // current question is not a number

    // A key pressed within the deaf window belongs to the digits that were just
    // submitted, not to the next question. Without it the extra press on an
    // overtyped fixed-length field starts a buffer against the following field.
    if (Date.now() < dtmfDeafUntil) return;

    if (dtmfTimer) clearTimeout(dtmfTimer);

    if (digit === '#') {
      commitDtmf();
      return;
    }
    if (digit === '*') {
      dtmfBuffer = '';
      dtmfField = null;
      speak('Cleared. Go ahead and type it again.', { cancelFirst: true });
      return;
    }
    if (!/^\d$/.test(digit)) return;

    // The first press means they chose the keypad; stop talking over them.
    if (!dtmfBuffer && streamSid) {
      toTwilio({ event: 'clear', streamSid });
      toOpenai({ type: 'response.cancel' });
      markQueue = [];
    }

    // Remember which question the digits are for. The idle timer fires later, and
    // by then a spoken answer may have moved the form on; digits typed for the
    // routing number must not land in the account number.
    if (!dtmfBuffer) dtmfField = field.key;
    dtmfBuffer += digit;
    if (dtmfBuffer.length >= field.dtmf) {
      commitDtmf();
      return;
    }
    dtmfTimer = setTimeout(commitDtmf, DTMF_IDLE_MS);
  }

  function commitDtmf() {
    if (dtmfTimer) {
      clearTimeout(dtmfTimer);
      dtmfTimer = null;
    }
    const digits = dtmfBuffer;
    const forField = dtmfField;
    dtmfBuffer = '';
    dtmfField = null;
    if (!digits) return;

    const open = intake.currentField(session);
    if (!open || open.key !== forField) {
      log(session.callSid, `dropped ${digits.length} keypad digits for ${forField}; the call moved on`);
      return;
    }

    const r = intake.submitDtmf(session, digits);
    if (!r) return;
    suppressSavesUntil = Date.now() + DTMF_SUPPRESS_MS;
    dtmfDeafUntil = Date.now() + DTMF_DEAF_MS;

    const line = r.accepted
      ? `${r.note ? `${r.note}. ` : ''}${r.say || ''}`
      : `${r.problem ? `${r.problem}. ` : ''}${r.say || ''}`;
    speak(line.trim() || 'Thanks.', { cancelFirst: true });

    if (r.done) closeOut('script complete');
  }

  // ---------- end of call ----------

  async function closeOut(why) {
    if (finished) return;
    finished = true;
    log(session.callSid, 'closing:', why);

    if (session.state === 'in_progress') intake.complete(session);

    try {
      persist(session);
    } catch (e) {
      log(session.callSid, 'could not write call record:', e.message);
    }

    // The closing line has not been spoken yet at this point; the model still has to
    // generate it and Twilio still has to play it. Wait for the outbound audio queue
    // to drain, and fall back to a hard stop so a stuck queue cannot hold the call
    // open. A flat four second timer cut the line off mid-sentence.
    const started = Date.now();
    const closeSockets = () => {
      try {
        if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      } catch {}
      try {
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      } catch {}
    };
    const drain = setInterval(() => {
      const quiet = markQueue.length === 0 && Date.now() - started > 2500;
      if (quiet || Date.now() - started > CLOSE_MAX_MS) {
        clearInterval(drain);
        closeSockets();
      }
    }, 500);

    try {
      const res = await deliver({
        to: REPORT_TO,
        subject: format.emailSubject(session),
        text: format.emailText(session),
        html: format.emailHtml(session),
      });
      log(session.callSid, res.sent ? `emailed ${REPORT_TO} via ${res.via}` : `email not sent: ${res.error}`);
    } catch (e) {
      log(session.callSid, 'email failed:', e.message);
    }
  }

  function persist(s) {
    fs.mkdirSync(callsDir, { recursive: true });
    const file = path.join(callsDir, `${s.callSid}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        { ...format.apiPayload(s), transcript: s.transcript, unresolved: s.unresolved },
        null,
        2,
      ),
    );
    log(s.callSid, 'wrote', file);
  }
}

module.exports = { handleCall };
