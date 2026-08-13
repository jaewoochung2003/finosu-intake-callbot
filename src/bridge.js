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
// How long a gap between key presses ends the entry. This was 2.5 seconds, which is
// shorter than the pause a person takes reading a long number off a statement or
// finding the next digit on a phone held away from their ear.
//
// The fixed-length fields survived a short window, because a truncated entry fails
// its own length check and gets re-asked. The account number does not: it is the one
// field where the length is a range, 4 to 17, so a partial entry validates and the
// bot reads the half a caller typed back as though it were the whole number.
const DTMF_IDLE_MS = 6000;
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
// How much of the bot line may still be playing when the mic opens. People answer on
// the last syllable, and a mic that waited for the final byte clipped the front of
// the reply or lost it, so the caller repeated themselves into a bot that had already
// moved on. 100 ms at 8 kHz u-law is 800 bytes. Raise it and the bot starts hearing
// its own tail on a speakerphone; drop it to 0 for the old behaviour.
const MIC_LEAD_MS = 100;
const MIC_LEAD_BYTES = Math.round((8000 * MIC_LEAD_MS) / 1000);
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
  // The caller is entering digits, so the bot's remaining audio for this line is held
  // back rather than played over them. Cleared when the entry commits.
  let typing = false;
  // Audio frames forwarded for the line currently being spoken, reset when the line's
  // transcript lands. Distinguishes a line the bot said from a line the caller heard.
  let framesThisLine = 0;
  let bytesThisLine = 0;
  let droppedThisLine = 0;
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
  // Bytes of bot audio the carrier has not finished playing yet.
  let queuedBytes = 0;
  // Response ids the server asked for, and whether the next one to be created is
  // ours. Everything else the model generates is heard by nobody.
  const instructed = new Set();
  let awaitingInstructed = false;
  let uninstructedFrames = 0;

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
    awaitingInstructed = true;
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
        // Two responses happen on every caller turn, and only one of them is ours.
        // Server VAD creates a response automatically when the caller stops talking,
        // and the model both calls save_answer in it AND says whatever it feels like,
        // because nobody has given it a line yet. Then the tool result comes back and
        // speak() creates a second response carrying the line the server actually
        // wrote. Forwarding both is what put two bot turns back to back, out of order,
        // the second one contradicting the first — and it is where the invented bank
        // lookup and the line about seeing a document came from. The tool call in the
        // automatic response is load-bearing, so it cannot be switched off; its audio
        // is simply not played.
        if (awaitingInstructed && msg.response && msg.response.id) {
          instructed.add(msg.response.id);
          awaitingInstructed = false;
        }
        break;

      // Audio back to the caller. The payload is already u-law base64.
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        // Only audio from a response the server asked for reaches the caller. An event
        // carrying no response_id is passed through, so the fake sockets in the tests
        // still drive this path.
        if (msg.response_id && instructed.size && !instructed.has(msg.response_id)) {
          uninstructedFrames += 1;
          break;
        }
        if (msg.delta && streamSid && !typing) {
          lastActivity = Date.now();
          toTwilio({ event: 'media', streamSid, media: { payload: msg.delta } });
          toTwilio({ event: 'mark', streamSid, mark: { name: 'chunk' } });
          // Each entry carries how much audio it is worth, so the gate below can open
          // on the tail of the line rather than on the very last mark. u-law at 8 kHz
          // is 8000 bytes a second, and base64 carries three bytes in four characters.
          const chunkBytes = Math.round((msg.delta.length * 3) / 4);
          markQueue.push(chunkBytes);
          queuedBytes += chunkBytes;
          framesThisLine += 1;
          bytesThisLine += msg.delta.length;
        } else if (msg.delta && !streamSid) {
          // Audio generated before the carrier opened the stream, or after it closed,
          // goes nowhere. The caller hears silence while the log shows the bot spoke.
          droppedThisLine += 1;
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
          queuedBytes = 0;
        }
        break;

      // The console is a log file. This fires on every caller turn including the
      // social security, routing number and account number questions, so it is
      // redacted against whichever field is open rather than printed raw.
      case 'conversation.item.input_audio_transcription.completed': {
        if (!msg.transcript) break;
        lastCallerSaid = msg.transcript;
        // A transcript arriving while digits are half entered is the model writing
        // down the touch tones, not the caller changing their mind, so it must not
        // lift the hold in the middle of an entry. With no entry open it means they
        // spoke instead of typing, and the hold lifts.
        if (!dtmfBuffer) typing = false;
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
      //
      // Masked while a sensitive field is open, because the bot's own line is where
      // the number gets read back: "Okay, zero two six zero zero nine five nine three"
      // put a full routing number in the server log in the clear, on the one path that
      // masks the caller's side of the same exchange. V.redact takes both the digits
      // and the spelled-out words.
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (msg.transcript) {
          const open = session.pending ? session.pending.key : (intake.currentField(session) || {}).key;
          const spoken = V.redact(open, msg.transcript);
          // The frame count is here because a line can be generated and never reach
          // the caller, and the transcript alone cannot tell the two apart: a caller
          // reported not hearing "Are you still there?" on a call where the log showed
          // the bot saying it. Frames are what actually went down the wire, so a line
          // logged with 0 frames is a line nobody heard.
          // Frames alone cannot tell a whole sentence from a truncated one, so the
          // seconds of audio go next to them. u-law at 8 kHz is 8000 bytes a second
          // and the payload is base64, so three bytes of audio arrive as four
          // characters. Compare the seconds against how long the line takes to say:
          // a read-back that logs 1.2s did not deliver its question.
          const seconds = ((bytesThisLine * 3) / 4 / 8000).toFixed(1);
          const carried = framesThisLine > 0
            ? `[${framesThisLine} frames, ${seconds}s audio]`
            : `[NO AUDIO SENT${droppedThisLine ? `, ${droppedThisLine} deltas dropped, no stream` : ''}]`;
          log(session.callSid, 'bot:', spoken.slice(0, 160), carried);
          framesThisLine = 0;
          bytesThisLine = 0;
          droppedThisLine = 0;
        }
        break;

      case 'response.done': {
        responseActive = false;
        if (msg.response && msg.response.id) instructed.delete(msg.response.id);
        if (uninstructedFrames) {
          log(session.callSid, 'muted', uninstructedFrames, 'frames the model spoke unprompted');
          uninstructedFrames = 0;
        }
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

  // The model hears touch tones as audio and writes them down as words, so a caller
  // typing while the question is still playing gets the digits filed as a spoken
  // answer halfway through the entry. The window after a committed entry never covered
  // the entry itself.
  //
  // It has to stay narrow. A caller who starts typing, gives up and says the number
  // instead is a real case, and that answer is longer than what was typed. So only an
  // answer that is the digits already in the buffer, and nothing more, is the tones
  // coming back: type 0-2-1-0 and hear "zero two one zero", not "zero two one zero
  // zero zero zero two one".
  const echoesKeypad = (answer) => {
    if (!dtmfBuffer) return false;
    const spoken = P.spokenDigits(String(answer ?? ''));
    return !!spoken && dtmfBuffer.startsWith(spoken);
  };

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
      } else if ((echoesKeypad(args.answer) || Date.now() < suppressSavesUntil) && !session.pending) {
        // The model hears the touch tones as audio and writes them down as words. The
        // window after a committed entry caught that, but nothing covered the entry
        // itself, so a caller typing a routing number while the question was still
        // playing had the tones transcribed mid-entry and filed as the answer. That is
        // where "473" came from on a live call: it went in as the apartment number and
        // then as the city, while the digits it was made of were still being typed.
        //
        // `typing` covers the entry, the window covers the moment after it. Neither
        // may swallow the yes that answers a read-back: the entry is followed straight
        // away by "I have 5 5 1 2..., is that right?", and the caller answers inside
        // the window every time, which is what the pending check is for.
        result = {
          accepted: false,
          problem: 'already captured from the keypad',
          say_next: intake.nextPrompt(session),
        };
      } else {
        result = toResult(intake.submit(session, String(args.answer ?? '')));
      }
    } else if (name === 'redo_previous') {
      // A read-back is already a question about the value, so the server owns every
      // answer to it and the model has nothing to decide. On a live call the caller
      // answered "Okay, Mike Hawk, is that right?" with "Joe", meaning his first name
      // was wrong. The model read that as a redo and called this tool, which carries
      // no arguments, so the word "Joe" was destroyed before the server saw it and
      // the bot went on to re-ask the LAST name. Route it back through the normal
      // turn while a read-back is open, so the caller's words survive and the
      // confirmation logic decides what they mean.
      const heard = String(args.heard || '').trim();
      const back = session.pending && heard
        ? intake.submit(session, heard)
        : intake.undoLast(session);
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
        // Refusing the hang-up is not enough on its own. Reaching for this tool
        // instead of save_answer also threw the turn away, so a caller who answered
        // the question and happened to sound final ("that's all I've got, 22046")
        // heard the same question again with their answer gone. Same fault that let
        // redo_previous destroy the word "Joe": a tool that carries no words can only
        // be as good as the model's guess about what they meant. Put the words back
        // through the normal turn and let the validators decide.
        const said = String(args.heard || '').trim() || String(lastCallerSaid || '').trim();
        result = said
          ? toResult(intake.submit(session, said))
          : { accepted: false, problem: 'the caller did not ask to stop', say_next: intake.nextPrompt(session) };
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
        //
        // The gate opens on the TAIL of the line, not on its last byte. People start
        // answering while the last syllable is still playing, and a mic that opened
        // exactly at the end clipped the front of the reply or missed it entirely.
        // MIC_LEAD_BYTES of audio may still be queued when the caller is let in.
        if (
          (responseActive || queuedBytes > MIC_LEAD_BYTES) &&
          Date.now() - speakingSince < MAX_DEAF_MS
        ) {
          break;
        }
        toOpenai({ type: 'input_audio_buffer.append', audio: data.media.payload });
        break;

      case 'dtmf':
        onDtmf(data.dtmf.digit);
        break;

      case 'mark':
        queuedBytes = Math.max(0, queuedBytes - (markQueue.shift() || 0));
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
    // Every press is logged, including the ones that go nowhere. Three separate
    // guesses at why typing during a question misbehaved were wrong, and each was
    // wrong because a press can be dropped on four different paths without leaving a
    // trace. A key that vanishes now says so and says why.
    const trace = (what) =>
      log(
        session.callSid,
        `keypad ${digit === '#' || digit === '*' ? digit : '#'}: ${what}`,
        `field=${field ? field.key : 'none'}`,
        `buffered=${dtmfBuffer.length}`,
        `pending=${session.pending ? session.pending.key : 'no'}`,
        `speaking=${responseActive || queuedBytes > 0 ? 'yes' : 'no'}`,
      );

    if (!field) return trace('DROPPED, no question open');
    if (!field.dtmf) return trace('DROPPED, this question does not take digits');

    // A key pressed within the deaf window belongs to the digits that were just
    // submitted, not to the next question. Without it the extra press on an
    // overtyped fixed-length field starts a buffer against the following field.
    if (Date.now() < dtmfDeafUntil) {
      return trace(`DROPPED, inside the ${DTMF_DEAF_MS}ms window after the last entry`);
    }
    trace('accepted');

    if (dtmfTimer) clearTimeout(dtmfTimer);

    if (digit === '#') {
      commitDtmf();
      return;
    }
    if (digit === '*') {
      dtmfBuffer = '';
      typing = false;
      dtmfField = null;
      speak('Cleared. Go ahead and type it again.', { cancelFirst: true });
      return;
    }
    if (!/^\d$/.test(digit)) return;

    // The first press means they chose the keypad, so stop talking over them. Drop the
    // audio already queued at the carrier and hold back whatever else this line
    // generates, but do NOT cancel the response.
    //
    // Cancelling is what made typing early destroy the turn. The model treats a
    // cancelled response as being cut off and writes itself a recovery line, so a
    // caller who started typing before the question finished got "Go ahead whenever
    // you're ready", then "I'm ready for your account number now", each one a fresh
    // response arriving on top of the digits still being entered. Left alone the model
    // finishes its turn into a muted channel and says nothing more.
    if (!dtmfBuffer && streamSid) {
      toTwilio({ event: 'clear', streamSid });
      markQueue = [];
          queuedBytes = 0;
      typing = true;
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
    typing = false;
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
