// bridge-voice.js — one phone call, with the server holding the turn.
//
// The difference from bridge.js is one sentence: here the language model never
// speaks and never files anything. It listens, its transcripts come back as text,
// and the server does the rest.
//
//   caller audio ──▶ Realtime socket ──▶ transcript ──▶ intake.js ──▶ a line of text
//                                                                        │
//   caller ◀── carrier ◀── u-law frames ◀── voice.js ◀────────────────────┘
//
// bridge.js gave the model the line and asked it to say the words. Over one evening
// of live calls it reworded lines, dropped the question off the end of a read-back so
// the caller was never asked anything, said sentences the server had not written,
// skipped a question entirely and left the caller in silence, and finally answered its
// own yes-or-no question before the caller had made a sound. Each was fenced off and
// the next one appeared, because none of them was disobedience. A model given a turn
// produces a plausible continuation of the conversation, and after "is that right?"
// the plausible continuation is "yes". From inside the turn there is no difference
// between hearing an answer and an answer belonging there.
//
// Taking the turn away removes the whole class rather than the instance:
//
//   - A line cannot be reworded or cut short, because voice.js makes the audio from
//     the string and nothing reads it in between.
//   - A question cannot be skipped, because the server sends the frames itself and
//     knows how many it sent.
//   - An answer cannot be invented, because there is no tool to invent it with. An
//     answer exists only if audio arrived and was transcribed.
//   - The turn cannot be taken early, because the microphone is shut until the last
//     frame of the line has been played.
//
// What it costs: about nine tenths of a second between the server deciding to speak
// and the caller hearing the first syllable, and no barge-in during a line.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const intake = require('./intake');
const P = require('./parse');
const V = require('./validate');
const voice = require('./voice');
const format = require('./format');
const { sendEmail } = require('./email');

const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const REPORT_TO = process.env.REPORT_TO || 'jaewoochung2003@gmail.com';
const CALLS_DIR = path.join(__dirname, '..', 'calls');

// A quiet line. The first is a nudge, the second ends the call.
const QUIET_NUDGE_MS = 20000;
const QUIET_END_MS = 50000;
// How much sound goes in one message to the carrier. 20 frames is 400 ms.
//
// The first batch of a line is smaller. Waiting to fill 400 ms before sending
// anything put that 400 ms on top of the second already spent generating the audio,
// and the whole of it lands in the pause before the bot starts talking, which is the
// part of the delay a caller actually notices. 100 ms is enough of a head start for
// the carrier, and by the time it has played that the rest is well ahead of it.
const FRAMES_PER_BATCH = 20;
const FIRST_BATCH_FRAMES = 5;

// Base64 decodes and re-encodes to join frames, because two base64 strings cannot be
// concatenated as text unless each one happens to be a whole number of 3-byte groups.
// 160 bytes is not, so gluing the strings produced sound that was almost right, which
// is worse than sound that is obviously wrong.
const joinFrames = (frames) =>
  Buffer.concat(frames.map((f) => Buffer.from(f, 'base64'))).toString('base64');
// A line that never finishes playing must not hold the microphone shut for the rest
// of the call. Longer than the greeting, which is the longest thing the bot says.
const MAX_SPEAK_MS = 30000;
const CLOSE_MAX_MS = 15000;


// What speech recognition writes when it is handed silence or line hiss. Whisper
// produces these with no audible speech anywhere in the audio, and one of them was
// once filed as an applicant's surname.
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
  if (/\d/.test(raw)) return false;
  const t = raw.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return NOT_SPEECH.has(t);
};

function log(callSid, ...args) {
  console.log(`[${callSid || '----'}]`, ...args);
}

// The session sent to the Realtime API. It is an ear and nothing else: no tools to
// call, no voice to speak with, and server voice detection told not to answer.
//
// `create_response: false` is the load-bearing line. Left at its default the server
// creates a response every time the caller stops talking, and the model fills it —
// which is where every invented sentence and every invented answer came from.
function earSession(model) {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model,
      output_modalities: ['text'],
      instructions:
        'You transcribe and nothing else. Never speak, never answer, never comment.',
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          noise_reduction: { type: process.env.NOISE_REDUCTION || 'near_field' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.6,
            prefix_padding_ms: 300,
            // How long the caller has to stop for before the turn is called over.
            //
            // Back at 900 after a spell at 650. The quarter second was real and so was
            // the cost: at 650 one word came back as two turns, and a transcriber
            // handed a third of a second of audio has almost nothing to decide a
            // language on. "Mama" came back once in Cyrillic and once in Latin on the
            // same word, and a "yes" to a read-back came back as the Turkish "o
            // yüzden" and was refused. Two transcripts for one utterance is also two
            // answers for one question, with the second landing in the next field.
            //
            // The wait it was buying was not the expensive half anyway: measured on a
            // live call, the detector and transcriber together took 0.6 to 1.9
            // seconds and the speech endpoint 0.8 to 1.9.
            silence_duration_ms: Number(process.env.VAD_SILENCE_MS || 900),
            create_response: false,
            interrupt_response: false,
          },
          // English, stated rather than guessed.
          //
          // Left to detect, the transcriber decides per segment, and on a short one it
          // decides badly: a caller saying his own surname got it back in Cyrillic,
          // and a one word "yes" came back as Turkish and was refused as an answer.
          // Nothing on this call is in another language, so there is nothing to detect.
          transcription: { model: 'whisper-1', language: process.env.ASR_LANGUAGE || 'en' },
        },
      },
      tools: [],
      tool_choice: 'none',
    },
  };
}

function handleCall(twilioWs, opts = {}) {
  const {
    openaiApiKey,
    openWebSocket = (url, options) => new WebSocket(url, options),
    deliver = sendEmail,
    callsDir = CALLS_DIR,
    speak: speakOverride = null,
    quietNudgeMs = QUIET_NUDGE_MS,
    quietEndMs = QUIET_END_MS,
    goodbyeMs = 3000,
  } = opts;

  const session = intake.startSession({ earlyKnockout: process.env.EARLY_KNOCKOUT !== '0' });

  let streamSid = null;
  let finished = false;
  let lastActivity = Date.now();
  let nudged = false;
  // Batches handed to the carrier that it has not reported playing yet. The
  // microphone is shut while any are outstanding.
  let unplayedBatches = 0;
  let speakingSince = 0;
  // For the wait breakdown in the log.
  let stoppedTalkingAt = 0;
  let transcriptAt = 0;
  // Whether a caller turn has already been taken since the bot last started a line.
  // A second one before the bot has spoken is the same utterance arriving in pieces.
  let heardSinceLine = false;
  let lastAnsweredField = '';
  // One line at a time, in the order they were written. Speaking is asynchronous —
  // the audio is fetched while the call runs — so without a queue a line written
  // during another line's fetch would race it onto the wire.
  let speakChain = Promise.resolve();
  let lineNumber = 0;
  // Lines the server has committed to saying and has not finished sending. Held
  // separately from the frame count because a line spends its first second being
  // fetched, with no frames to show for it.
  let linesOutstanding = 0;

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

  // Whichever question the log should be masked against: the one being read back if
  // there is one, otherwise the one on the table.
  const openKey = () =>
    session.pending ? session.pending.key : (intake.currentField(session) || {}).key || '';

  // Is the bot still talking? The lead-in lets the caller start answering over the
  // last breath of the line, and the time cap means a line whose play-completion
  // reports go missing cannot leave the caller unheard for the rest of the call.
  const stillSpeaking = () => {
    if (Date.now() - speakingSince > MAX_SPEAK_MS) return false;
    // A line that has been decided on but whose audio is still being fetched counts
    // as speaking. Frames alone did not cover it: for the second or so between the
    // server writing a line and the first frame coming back there are no frames at
    // all, the microphone read as open, and anything the caller said in that gap was
    // transcribed as the answer to a question they had not been asked yet.
    return linesOutstanding > 0 || unplayedBatches > 0;
  };

  // ---------- speaking ----------

  // Say one line. The audio is made here from the string, so what the caller hears is
  // the line, all of it, in order, every time.
  //
  // A `mark` rides behind every frame. The carrier sends each one back once it has
  // played that frame, which is how the microphone knows when the line is over —
  // there is no other way to find out, and guessing from the length of the text is
  // what let the bot listen while it was still talking.
  async function sayNow(line) {
    const text = String(line || '').trim();
    if (!text || finished || !streamSid) return;
    const n = ++lineNumber;
    speakingSince = Date.now();
    let frames = 0;
    try {
      const askedAt = Date.now();
      let firstFrameAt = 0;
      const stream = speakOverride
        ? speakOverride(text)
        : voice.speechStream(text, { apiKey: openaiApiKey });
      // Frames go out in batches, not one at a time.
      //
      // One 20 ms frame per websocket message, each with a mark behind it, is a
      // hundred messages a second at the carrier, and six hundred for a read-back.
      // That is what the stutter was: the carrier spends its time on message
      // bookkeeping instead of on playing the audio, and the gaps are audible. A
      // batch is 400 ms of sound in one message, which is the same bytes in a
      // fiftieth of the traffic, and one mark behind each batch is still fine enough
      // to know when the line has finished.
      let batch = [];
      const flush = () => {
        if (!batch.length) return;
        // The bot has started talking, so the next thing the caller says answers this
        // rather than continuing the last thing they said.
        heardSinceLine = false;
        toTwilio({ event: 'media', streamSid, media: { payload: joinFrames(batch) } });
        toTwilio({ event: 'mark', streamSid, mark: { name: `line-${n}-${frames}` } });
        unplayedBatches += 1;
        frames += batch.length;
        batch = [];
        // Keep the clock moving while a long line plays, so the quiet watch does not
        // count the bot's own speech as a silent caller.
        speakingSince = Date.now();
        lastActivity = Date.now();
      };
      for await (const payload of stream) {
        if (finished || !streamSid) break;
        if (!firstFrameAt) firstFrameAt = Date.now();
        batch.push(payload);
        if (batch.length >= (frames === 0 ? FIRST_BATCH_FRAMES : FRAMES_PER_BATCH)) flush();
      }
      flush();
      // Where the wait went, when this line is a reply to something the caller said.
      const waited =
        stoppedTalkingAt && transcriptAt >= stoppedTalkingAt
          ? ` [wait ${((firstFrameAt || Date.now()) - stoppedTalkingAt) / 1000}s` +
            ` = vad+asr ${((transcriptAt - stoppedTalkingAt) / 1000).toFixed(2)}` +
            ` + speech ${(((firstFrameAt || Date.now()) - askedAt) / 1000).toFixed(2)}]`
          : '';
      stoppedTalkingAt = 0;
      log(
        session.callSid,
        'bot:',
        V.redact(openKey(), text).slice(0, 160),
        `[${frames} frames, ${(frames * 0.02).toFixed(1)}s]${waited}`,
      );
    } catch (e) {
      // The line could not be turned into audio. Say so in the log rather than
      // leaving a caller in silence wondering; the quiet watch will pick the call up.
      log(session.callSid, 'could not speak the line:', e.message);
    }
  }

  const say = (line) => {
    if (!String(line || '').trim()) return speakChain;
    linesOutstanding += 1;
    speakingSince = Date.now();
    speakChain = speakChain
      .then(() => sayNow(line))
      .catch(() => {})
      .finally(() => {
        linesOutstanding = Math.max(0, linesOutstanding - 1);
      });
    return speakChain;
  };

  // ---------- the form ----------

  // One caller turn in, one line out. This is the whole control loop.
  function turn(said) {
    if (finished || session.state !== 'in_progress') return;
    const result = intake.submit(session, String(said));
    if (!result) return;

    const endStopped = (s) => (/[.!?]$/.test(String(s).trim()) ? String(s).trim() : `${String(s).trim()}.`);
    const line = [
      result.problem ? endStopped(result.problem) : null,
      result.note ? endStopped(result.note) : null,
      result.say,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    log(
      session.callSid,
      `heard ${JSON.stringify(V.redact(openKey(), String(said)).slice(0, 60))}`,
      `-> ${result.accepted ? 'accepted' : 'refused'}`,
      `pending=${session.pending ? session.pending.key : 'no'}`,
    );

    if (line) say(line);
    if (result.done) {
      speakChain.then(() => closeOut('script complete'));
    }
  }

  // ---------- the ear ----------

  openaiWs.on('open', () => {
    toOpenai(earSession(OPENAI_MODEL));
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

      // The caller said something. This event is the only thing on the call that can
      // produce an answer, and it exists only if audio arrived, which is why an
      // invented answer is not reachable from here.
      case 'conversation.item.input_audio_transcription.completed': {
        const said = String(msg.transcript || '').trim();
        transcriptAt = Date.now();
        lastActivity = Date.now();
        nudged = false;
        if (!said) break;
        if (isNotSpeech(said)) {
          log(session.callSid, 'ignored line noise:', JSON.stringify(said.slice(0, 40)));
          break;
        }
        // One utterance, two transcripts.
        //
        // The voice detector can call a turn over inside a word and open another, and
        // the caller said one thing while the server gets handed two. The second lands
        // against the NEXT question, because by then the form has moved: on an earlier
        // call an apartment number given once went in as the apartment number and then
        // as the city, and the application went out with a city called 473.
        //
        // What separates the two cases is whether the bot has said anything in
        // between, not what the words are or how fast they came. A caller repeating
        // themselves on purpose is answering a question they have just been asked;
        // two halves of one utterance arrive with nothing spoken between them.
        //
        // Matching on the words instead was wrong in both directions. "No" answers two
        // knockout questions in a row and both are real, so identical words are not
        // proof of anything — and the split that caused this returned "Mama" once in
        // Cyrillic and once in Latin, which are not identical words at all.
        const openNow = (intake.currentField(session) || {}).key || '';
        if (heardSinceLine && openNow !== lastAnsweredField) {
          log(
            session.callSid,
            'ignored a second transcript from the same turn:',
            JSON.stringify(said.slice(0, 40)),
          );
          break;
        }
        heardSinceLine = true;
        lastAnsweredField = openNow;
        turn(said);
        break;
      }

      case 'input_audio_buffer.speech_started':
        lastActivity = Date.now();
        nudged = false;
        break;

      // The caller stopped talking. From here to the first sound of the reply is the
      // wait they actually feel, and it is three things stacked: the silence the voice
      // detector waits out before calling the turn over, the transcriber's round trip,
      // and the speech endpoint's. Only the first is a setting. The other two are
      // somebody else's round trip and the only honest thing to do with them is
      // measure them, so the log carries both rather than a guess.
      case 'input_audio_buffer.speech_stopped':
        stoppedTalkingAt = Date.now();
        lastActivity = Date.now();
        nudged = false;
        break;

      default:
        break;
    }
  });

  openaiWs.on('close', () => log(session.callSid, 'openai socket closed'));
  openaiWs.on('error', (e) => log(session.callSid, 'openai socket error:', e.message));

  // ---------- the carrier ----------

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
        startQuietWatch();
        say(`${intake.GREETING} ${intake.nextPrompt(session)}`);
        break;

      case 'media':
        // Deaf while the bot is talking. On a speakerphone the bot hears its own
        // voice, and every word of its own line that reaches the transcriber comes
        // back as something the caller said.
        if (stillSpeaking()) break;
        toOpenai({ type: 'input_audio_buffer.append', audio: data.media.payload });
        break;

      case 'mark':
        unplayedBatches = Math.max(0, unplayedBatches - 1);
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

  function startQuietWatch() {
    const timer = setInterval(() => {
      if (finished) {
        clearInterval(timer);
        return;
      }
      if (stillSpeaking()) return;
      const quiet = Date.now() - lastActivity;
      if (!nudged && quiet > quietNudgeMs) {
        nudged = true;
        lastActivity = Date.now();
        say('Are you still there?');
        return;
      }
      if (nudged && quiet > quietEndMs - quietNudgeMs) {
        log(session.callSid, 'caller went quiet');
        say("I'll let you go. Call back when you're ready and we can pick this up.");
        setTimeout(() => closeOut('caller went quiet'), goodbyeMs);
        clearInterval(timer);
      }
    }, Math.min(2000, Math.max(20, Math.floor(quietNudgeMs / 3))));
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
      if (unplayedBatches === 0 || Date.now() - started > CLOSE_MAX_MS) {
        clearInterval(drain);
        closeSockets();
      }
    }, 300);

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

module.exports = { handleCall, earSession, isNotSpeech };
