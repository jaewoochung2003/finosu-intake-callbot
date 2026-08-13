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
const P = require('./parse');
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
// The mic is held shut while the bot speaks its line. This caps how long that hold can
// last, so a lost play-completion mark can never leave the caller unheard. Longer than
// the longest line (the greeting), short enough that a real stuck queue self-heals.
const MAX_DEAF_MS = 25000;
// A quiet line. The first is a nudge, the second ends the call: a caller who has put
// the phone down should not hold an open line and a running model session, and one
// who is looking for a bank statement needs longer than a pause.
const QUIET_NUDGE_MS = 20000;
const QUIET_END_MS = 50000;

// What speech recognition writes when it is handed silence or line hiss. These are
// not answers, and on a live call one of them was filed as an applicant's name.
// Whisper produces them with no audible speech anywhere in the audio.
const NOT_SPEECH = new Set([
  'thank you',
  'thanks',
  'thank you very much',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'bye',
  'goodbye',
  'you',
  '',
]);

const isNotSpeech = (text) => {
  const raw = String(text || '').trim();
  if (!raw) return true;
  // Digits are an answer, always. Stripping non-letters first turned "3000" into an
  // empty string, which matched the empty entry in the list above, so every answer
  // made only of digits was thrown away: the income figure, the zip, and a social or
  // routing number said out loud rather than typed.
  if (/\d/.test(raw)) return false;
  const t = raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return NOT_SPEECH.has(t);
};

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
    quietNudgeMs = QUIET_NUDGE_MS,
    quietEndMs = QUIET_END_MS,
    // How long the goodbye line gets to play before the sockets close.
    goodbyeMs = 3000,
  } = opts;

  const session = intake.startSession({ earlyKnockout: process.env.EARLY_KNOCKOUT !== '0' });

  let streamSid = null;
  let finished = false;
  let dtmfBuffer = '';
  let dtmfField = null;
  let dtmfTimer = null;
  let suppressSavesUntil = 0;
  let dtmfDeafUntil = 0;
  // The caller's last transcribed words, kept so end_call can be checked against
  // what they actually said rather than taken on the model's word.
  let lastCallerSaid = '';
  // Whether the model is generating right now. Only then is a cancel meaningful.
  let responseActive = false;
  // When the bot started its current line.
  let speakingSince = 0;
  // The last time either side made a sound, and whether the quiet has been noted.
  let lastActivity = Date.now();
  let nudged = false;
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
    // Cancelling when nothing is generating is an error back from the API on every
    // turn, which buries the log lines that matter under noise.
    if (cancelFirst && responseActive) toOpenai({ type: 'response.cancel' });
    // Word for word, not "in your own voice." Every line here is already written to
    // be spoken, and the paraphrase latitude let the model drop the "Is that right?"
    // off a read-back and turn "spell your first name" into "your last name". The
    // exact text is the contract; the model's only job is to voice it.
    toOpenai({
      type: 'response.create',
      response: {
        instructions:
          'Say this line to the caller, out loud, word for word from the first word to the ' +
          'last, including the question at the end if there is one. Do not add anything before ' +
          'or after it, and do not change any word. Then stop and wait.\n' +
          `LINE: ${line}`,
      },
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
        // A cancel that lands as the response is already finishing answers with this
        // and nothing else happens. It is a race, not a fault, and printing it hides
        // the errors that matter in a log someone reads after a bad call.
        if ((msg.error || {}).code === 'response_cancel_not_active') break;
        log(session.callSid, 'openai error:', JSON.stringify(msg.error || msg));
        break;

      case 'response.created':
        responseActive = true;
        speakingSince = Date.now();
        lastActivity = Date.now();
        break;

      // Audio back to the caller. The payload is already u-law base64.
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (msg.delta && streamSid) {
          lastActivity = Date.now();
          toTwilio({ event: 'media', streamSid, media: { payload: msg.delta } });
          toTwilio({ event: 'mark', streamSid, mark: { name: 'chunk' } });
          markQueue.push('chunk');
        }
        break;

      // The caller started talking over the bot. Not in the first moment of a line
      // though: a real interruption comes after the caller has heard enough to want
      // to interrupt, and what arrives in the first half second is the line noise
      // that opens every phone call.
      case 'input_audio_buffer.speech_started':
        lastActivity = Date.now();
        nudged = false;
        // Deaf until the line finishes. While the bot is still generating its line
        // (responseActive) or that line is still playing out (markQueue), a
        // speech_started is the bot's own voice on a speakerphone, a click, or line
        // noise — not a real interruption. The caller's audio is not even being
        // forwarded right now (the media gate below holds it). Honoring it here is what
        // sent Twilio a `clear` mid-read-back and dropped the queued "Is that right?"
        // before it played, which is why the caller heard the name spelled and then
        // nothing. Ignore it while the bot speaks; the time cap matches the media gate
        // so a lost play-completion mark cannot wedge the bot deaf forever.
        if ((responseActive || markQueue.length > 0) && Date.now() - speakingSince < MAX_DEAF_MS) break;
        // A genuine interruption after the line finished: stop the queued audio and
        // cancel any in-flight response so the caller is not talked over.
        if (markQueue.length && streamSid) {
          log(session.callSid, 'barge-in: caller cut in after the line, clearing audio');
          toTwilio({ event: 'clear', streamSid });
          if (responseActive) toOpenai({ type: 'response.cancel' });
          markQueue = [];
        }
        break;

      // The console is a log file. This fires on every caller turn including the
      // social security, routing number and account number questions, so it is
      // redacted against whichever field is open rather than printed raw.
      case 'conversation.item.input_audio_transcription.completed': {
        if (!msg.transcript) break;
        lastCallerSaid = msg.transcript;
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

      // What the bot actually said, so a dropped or reworded line is visible in the
      // log instead of guessed at from the caller's report.
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (msg.transcript) log(session.callSid, 'bot:', msg.transcript.slice(0, 160));
        break;

      case 'response.done': {
        responseActive = false;
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
      if (isNotSpeech(args.answer)) {
        // Nothing was said. Say so like a person would and ask again, rather than
        // writing silence into the form or repeating the question with no reason.
        log(session.callSid, 'ignored a save from silence:', JSON.stringify(String(args.answer || '')));
        result = {
          accepted: false,
          problem: 'Sorry, I did not catch that',
          say_next: intake.nextPrompt(session),
        };
      } else if (Date.now() < suppressSavesUntil && !session.pending) {
        // The suppression window stops the model filing the tones it just heard as
        // if they were speech. It must not swallow the yes that answers a read-back:
        // the keypad entry is followed immediately by "I have 5 5 1 2..., is that
        // right?", and the caller answers inside the window every time.
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
      // Hanging up is the one thing the model can do that cannot be undone, and it
      // did it once on a caller who had said nothing but "no" to a yes-or-no
      // question. So the caller's own last words decide, not the model's reading of
      // them: no request to stop, no end of call, and the open question is asked
      // again. A caller who really wants out hangs up, which the stop event handles.
      if (!P.saysStop(lastCallerSaid)) {
        const open = intake.currentField(session);
        log(
          session.callSid,
          'refused end_call —',
          JSON.stringify(String(args.reason || '').slice(0, 80)),
          'after: ' +
            JSON.stringify(V.redact(open ? open.key : '', String(lastCallerSaid).slice(0, 60))),
        );
        result = {
          accepted: false,
          problem: 'the caller did not ask to stop',
          say_next: intake.nextPrompt(session),
        };
      } else {
        log(session.callSid, 'caller ended:', args.reason);
        result = toResult(intake.complete(session));
      }
    } else {
      result = { accepted: false, problem: `unknown tool ${name}` };
    }

    toOpenai({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    });

    // The server dictates the next line rather than leaving the model to compose one
    // off the tool result. On a live call the caller talked over the bot, the
    // interruption cancelled the response the save_answer call was riding in, and the
    // answer was lost while the model went on believing it had been recorded. From
    // that point the model asked question N+1 and the server filed the reply under
    // question N, and every answer after it landed in the wrong field. Handing over
    // the exact words keeps the two in step, whatever the model thinks happened.
    const line = [
      result.problem ? `${result.problem}.` : null,
      result.note ? `${result.note}.` : null,
      result.say_next,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    // No cancel here: the response this tool call arrived in is already finishing,
    // and asking to cancel it races the API into an error on every single turn.
    if (line) speak(line);
    else toOpenai({ type: 'response.create' });

    if (result.done) closeOut('script complete');
  }

  function toResult(r) {
    if (!r) return { accepted: false, say_next: intake.nextPrompt(session) };
    return {
      accepted: !!r.accepted,
      problem: r.problem || null,
      note: r.note || null,
      // Fields the caller has to be able to catch an error on: the name, the email
      // address and the two bank numbers. intake flags these as `confirming`, so the
      // model gets read_back:true and speaks the "Is that right?" verbatim, then stops.
      // This read the wrong key (`readBack`) and was always false, so the model treated
      // a read-back as an ordinary line and dropped the confirm question.
      read_back: !!(r.readBack || r.confirming),
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
        startQuietWatch();
        streamSid = data.start.streamSid;
        session.callSid = data.start.callSid || session.callSid;
        session.from = data.start.customParameters?.from || session.from;
        log(session.callSid, 'stream started from', session.from || 'unknown');
        break;

      case 'media':
        // Deaf while the bot is speaking. `responseActive` covers the line being
        // generated; `markQueue` covers the audio still playing out after that. On a
        // speakerphone the bot hears its own voice, and a mouse click or a cough
        // counted as the caller barging in, which cancelled the line mid-sentence and
        // dropped the "Is that right?" off a read-back. Holding the mic shut until the
        // line has finished playing removes the whole class of self-interruption. The
        // keypad still works — DTMF is handled separately and can stop the bot. The time
        // cap keeps a stuck queue from ever leaving the caller unheard.
        if ((responseActive || markQueue.length > 0) && Date.now() - speakingSince < MAX_DEAF_MS) break;
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

  // ---------- a caller who has gone quiet ----------

  // Nothing in the model or the carrier ends a silent call. Without this a caller who
  // put the phone down held an open line and a paid model session until the process
  // was killed, and a caller who simply stopped talking heard nothing at all.
  function startQuietWatch() {
    const timer = setInterval(() => {
      if (finished) {
        clearInterval(timer);
        return;
      }
      const quiet = Date.now() - lastActivity;
      if (!nudged && quiet > quietNudgeMs) {
        nudged = true;
        lastActivity = Date.now();
        speak('Are you still there?');
        return;
      }
      if (nudged && quiet > quietEndMs - quietNudgeMs) {
        log(session.callSid, 'caller went quiet');
        speak("I'll let you go. Call back when you're ready and we can pick this up.");
        setTimeout(() => closeOut('caller went quiet'), goodbyeMs);
        clearInterval(timer);
      }
    }, Math.min(2000, Math.max(20, Math.floor(quietNudgeMs / 3))));
  }

  // ---------- keypad ----------

  function onDtmf(digit) {
    // A keypad press is a caller doing something. Without this the quiet watch saw
    // silence while somebody read a routing number off a bank card and typed it in,
    // asked whether they were still there, and hung up on them mid-number.
    lastActivity = Date.now();
    nudged = false;
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
