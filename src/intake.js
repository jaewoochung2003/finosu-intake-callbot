// intake.js — the state of one call.
//
// The server holds the script and the record; the model holds the microphone. Every
// answer arrives here as text, gets validated, and either lands in the record or
// comes back as a re-ask with the reason. The model is told what to say next by the
// return value, which is why it cannot skip a question or make one up.
//
// A field that will not validate after three tries is left out of the record rather
// than written as a guess. That matters for the decision: a routing number nobody
// could capture leaves the record short, and a short record decides Incomplete, not
// Declined. Failing to hear someone is not the same as catching them.
//
// Two things get stored that the application form does not ask for, because neither
// can be reconstructed afterwards:
//
//   The raw words next to the normalized value. "March second, ninety one" becomes
//   1991-03-02, and if that parse is ever found to be wrong the raw string can be
//   re-parsed. The normalized value alone cannot be un-normalized.
//
//   How long each field took, how many tries it needed, and every answer the caller
//   went back and changed. A caller revising their income mid-call is telling you
//   something, and the final value alone does not carry it. Timings cannot be
//   backfilled later; they either get recorded during the call or they never exist.

const { FIELDS, BY_KEY } = require('./fields');
const {
  allKnockouts,
  screeningSettled,
  decide,
  POLICY_VERSION,
} = require('./decision');
const V = require('./validate');
const P = require('./parse');

const MAX_ATTEMPTS = 3;

// The bank details are the one place a caller has to stop and go find something.
// Most people under 40 have never owned a paper check, so the routing and account
// numbers mean opening a banking app, and a caller who hits that question cold
// either sits in dead air or hangs up. Saying it in the first ten seconds costs a
// sentence and buys the caller the whole rest of the call to get ready.
const GREETING =
  'Thanks for calling Finosu. I can take your loan application right now. Have your ' +
  "routing and account numbers handy, plus the last four of your social, and we'll get started.";

function startSession(opts = {}) {
  const now = Date.now();
  return {
    callSid: opts.callSid || `local-${now}`,
    from: opts.from || null,
    startedAt: opts.now || new Date().toISOString(),
    earlyKnockout: opts.earlyKnockout !== false,
    policyVersion: POLICY_VERSION,
    record: {},
    index: 0,
    attempts: 0,
    unresolved: [],
    transcript: [],
    // What each field cost to capture: raw words, tries, seconds, how it arrived.
    capture: {},
    // Answers the caller went back and changed.
    corrections: [],
    askedAt: now,
    // A captured value waiting for the caller to say yes or no to it. Only the two
    // fields nothing can check hold one: a name and an email address have no check
    // digit, no directory and no shape, so the caller is the only test there is.
    pending: null,
    state: 'in_progress', // in_progress | complete
    outcome: null,
  };
}

// Walks past fields that do not apply to this application, writing their placeholder
// value as it goes ("N/A" for a day-of-month question on a weekly payroll).
function advance(session) {
  while (session.index < FIELDS.length) {
    const field = FIELDS[session.index];
    if (field.appliesWhen && !field.appliesWhen(session.record)) {
      if (field.skipValue !== undefined) session.record[field.key] = field.skipValue;
      session.index += 1;
      continue;
    }
    return field;
  }
  return null;
}

function currentField(session) {
  if (session.state !== 'in_progress') return null;
  return advance(session);
}

function nextPrompt(session) {
  const field = currentField(session);
  return field ? field.ask : null;
}

function finish(session, outcome) {
  session.state = 'complete';
  session.outcome = outcome;
  session.endedAt = new Date().toISOString();
  return session;
}

// ---------- capture record ----------

// The instrument record for one field: what was said, what it became, and what it
// cost. On a sensitive field neither half is kept — the raw is masked and the value
// is only counted, because the application record already holds the number once and
// there is no reason for a metrics table to hold it twice.
function noteCapture(session, field, { raw, value, source }) {
  const prior = session.capture[field.key];
  session.capture[field.key] = {
    raw: V.redact(field.key, raw),
    value: field.sensitive ? null : value,
    value_length: field.sensitive ? String(value).length : undefined,
    attempts: session.attempts + 1,
    ms: Date.now() - session.askedAt,
    source,
    at: new Date().toISOString(),
    revisions: prior ? (prior.revisions || 0) + 1 : 0,
  };
}

// ---------- the turn ----------

// Feed one caller turn in.
//
// Returns what the model needs to say next:
//   { accepted, problem, note, say, done, decision }
function submit(session, said, opts = {}) {
  if (session.state !== 'in_progress') {
    return { accepted: false, done: true, say: null, decision: session.outcome };
  }

  if (session.pending) return resolveConfirmation(session, said);

  const field = currentField(session);
  if (!field) return complete(session);

  const source = opts.source || 'speech';

  session.transcript.push({
    at: new Date().toISOString(),
    field: field.key,
    said: V.redact(field.key, said),
    source,
  });

  // "No, this number is fine" / "I don't have a department" on an optional question.
  if (field.optional && field.skipOn && field.skipOn(said)) {
    session.record[field.key] = field.skipValue;
    noteCapture(session, field, { raw: said, value: field.skipValue, source: 'skip' });
    return step(session, { accepted: true });
  }

  const result = field.validate(said, session.record);

  if (!result.ok) {
    // An 18-and-over failure is a fact about the applicant, not a bad capture.
    if (result.fatal) {
      session.record[field.key] = P.parseDate(said) || said;
      noteCapture(session, field, { raw: said, value: session.record[field.key], source });
      return finishWith(session, 'Declined', [{ code: 'UNDER_18', reason: result.error }]);
    }

    session.attempts += 1;
    if (session.attempts >= MAX_ATTEMPTS) {
      if (field.optional) {
        session.record[field.key] = field.skipValue !== undefined ? field.skipValue : '';
      } else {
        session.unresolved.push(field.key);
      }
      session.capture[field.key] = {
        raw: V.redact(field.key, said),
        value: null,
        attempts: session.attempts,
        ms: Date.now() - session.askedAt,
        source,
        at: new Date().toISOString(),
        gaveUp: true,
      };
      session.attempts = 0;
      session.index += 1;

      // Giving up on a screening question can be the thing that settles the block.
      const knocked = maybeKnockout(session, field);
      if (knocked) return knocked;

      const nf = currentField(session);
      if (!nf) return complete(session);
      session.askedAt = Date.now();
      return {
        accepted: false,
        problem: result.error,
        say: `Let's come back to that one. ${nf.ask}`,
        done: false,
      };
    }

    return {
      accepted: false,
      problem: result.error,
      say: `${result.error === undefined ? '' : `Sorry, ${result.error}. `}${field.reask || field.ask}`,
      done: false,
    };
  }

  session.record[field.key] = result.value;
  noteCapture(session, field, { raw: said, value: result.value, source });

  // A field can settle more than its own slot: the income figure settles the
  // over-2000 question the brief asks for, so the record keeps the number and the
  // boolean is computed rather than asked.
  if (field.derive) Object.assign(session.record, field.derive(result.value, session.record));
  if (result.monthlyIncome !== undefined) session.record.monthly_income = result.monthlyIncome;
  if (result.bank) session.record.bank_name = result.bank;

  const knocked = maybeKnockout(session, field);
  if (knocked) return knocked;

  // A field marked `confirm` does not advance yet. The value is read back and the
  // call sits on this question until the caller says yes, which is the whole point:
  // reading a value back and asking the next question in the same breath means the
  // "that's right" lands in the next field. That is what happened on the 9:50 call,
  // where a yes about an email address was parsed as a date of birth.
  if (field.confirm) {
    session.pending = { key: field.key, value: result.value, tries: 0 };
    session.askedAt = Date.now();
    return {
      accepted: true,
      say: `${confirmLine(field, result.value, session.record)} Is that right?`,
      confirming: true,
      done: false,
    };
  }

  // Validators name the read-aloud line either spokenNote (bank name) or note (the
  // income figure). Only spokenNote was forwarded for a while, so the income
  // read-back existed and was never said — and a caller whose "3000" was heard as
  // "2000" found out from the decline email.
  return step(session, { accepted: true, note: result.spokenNote || result.note || null });
}

// Yes, no, or a correction. A caller who hears their name back wrong rarely answers
// "no" on its own; they say the right one. So an answer that is neither yes nor no is
// tried as a fresh answer to the same question, and only if that fails does the bot
// ask again. Two unclear turns and it takes what it has, because a loop that cannot
// be escaped is worse than a value the email report shows as captured.
// A field can be marked for confirmation without spelling out how to say it back.
// Falling back beats throwing: the crash landed mid-call, on a live line.
function confirmLine(field, value, record) {
  return field.confirmLine ? field.confirmLine(value, record || {}) : `I have ${value}.`;
}

function resolveConfirmation(session, said) {
  const pending = session.pending;
  const field = FIELDS.find((f) => f.key === pending.key);
  const answer = P.parseYesNo(said);

  session.transcript.push({
    at: new Date().toISOString(),
    field: field.key,
    said: V.redact(field.key, said),
    source: 'confirm',
  });

  if (answer === true) {
    session.pending = null;
    return step(session, { accepted: true });
  }

  if (answer === false) {
    session.pending = null;
    // One read-back can cover more than one question: the name is asked in two
    // halves and confirmed as a whole. Clearing only the half that was confirmed
    // sent the re-spelled whole name into the last name field, and the read-back
    // came back "Jae Woo Jaewoo Chung".
    const covers = field.confirmCovers || [field.key];
    for (const key of covers) delete session.record[key];
    if (field.derive) for (const key of Object.keys(field.derive('', {}))) delete session.record[key];
    session.index = FIELDS.findIndex((f) => f.key === covers[0]);
    session.attempts = 0;
    session.askedAt = Date.now();
    return {
      accepted: false,
      say: field.respell || `Sorry about that. ${currentField(session).ask}`,
      done: false,
    };
  }

  // Not a yes or a no. Take it as the corrected answer if it reads as one.
  const retry = field.validate(said, session.record);
  if (retry.ok && retry.value !== pending.value) {
    session.record[field.key] = retry.value;
    noteCapture(session, field, { raw: said, value: retry.value, source: 'speech' });
    session.pending = { key: field.key, value: retry.value, tries: 0 };
    return {
      accepted: true,
      say: `${confirmLine(field, retry.value, session.record)} Is that right?`,
      confirming: true,
      done: false,
    };
  }

  pending.tries += 1;
  if (pending.tries >= 2) {
    session.pending = null;
    return step(session, { accepted: true });
  }
  return {
    accepted: false,
    say: `Sorry, was that a yes or a no? ${confirmLine(field, pending.value, session.record)} Is that right?`,
    done: false,
  };
}

// The screening block is checked once, after all five questions have been put to
// the caller, and never mid-block. See decision.js for why.
function maybeKnockout(session, field) {
  if (!session.earlyKnockout || !field.knockout) return null;
  if (!screeningSettled(session.record, session.unresolved)) return null;
  const fired = allKnockouts(session.record);
  return fired.length ? finishWith(session, 'Declined', fired) : null;
}

function step(session, { accepted, note }) {
  session.attempts = 0;
  session.index += 1;
  const field = currentField(session);
  if (!field) return complete(session);
  session.askedAt = Date.now();
  return { accepted, note: note || null, say: field.ask, done: false };
}

function complete(session) {
  const outcome = decide(session.record);
  return finishWith(session, outcome.decision, outcome.reasons, outcome.spoken);
}

function finishWith(session, decision, reasons, spoken) {
  const outcome = {
    decision,
    policyVersion: POLICY_VERSION,
    reasons,
    unresolved: session.unresolved.slice(),
    spoken:
      spoken ||
      (decision === 'Declined'
        ? "Based on what you've told me, we can't move forward with a loan today. " +
          "You'll get an email with the details."
        : "That's everything I need. You'll get an email with what I've got."),
  };
  finish(session, outcome);
  return { accepted: true, done: true, say: outcome.spoken, decision: outcome };
}

// "No, that was wrong" — step back one field and ask it again. Without this the
// only way to fix a misheard answer is to hang up and call back.
//
// The old value is kept in session.corrections rather than dropped. Someone
// revising their income after hearing the question again is a different applicant
// from someone who said it once, and only the correction log knows which is which.
function undoLast(session) {
  if (session.state !== 'in_progress') return null;
  // Going back while a read-back is waiting means the caller wants THIS answer
  // again, not the one before it: the value is captured but unconfirmed, and the
  // form has not moved on yet.
  const wasPending = session.pending !== null;
  session.pending = null;
  // Walk back to the last question that was actually put to the caller.
  //
  // "Put to the caller" is session.capture, not session.record. Two things live in
  // the record that were never asked: values a derive step wrote (income_over_2000
  // comes from the figure) and placeholders advance() filled in for questions that
  // did not apply. Walking on the record sends the caller back to a question they
  // never heard. Walking on appliesWhen alone has the opposite fault: the income
  // backstop's appliesWhen goes false the moment it is answered, so its answer was
  // unreachable and got deleted as collateral when the walk passed over it.
  let i = wasPending ? session.index : session.index - 1;
  while (i >= 0) {
    const field = FIELDS[i];
    if (session.capture[field.key] !== undefined) break;
    if (!field.appliesWhen || field.appliesWhen(session.record)) break;
    i -= 1;
  }
  if (i < 0) return null;
  const field = FIELDS[i];

  const had = session.record[field.key];
  if (had !== undefined) {
    session.corrections.push({
      field: field.key,
      previous: field.sensitive ? V.maskAccount(String(had)) : had,
      at: new Date().toISOString(),
    });
  }

  // The capture entry stays. It is what the walk above reads to know the question
  // was asked, and it carries the revision count that makes the re-answer legible
  // as a correction rather than a first answer.
  delete session.record[field.key];
  if (field.key === 'routing_number') delete session.record.bank_name;
  if (field.key === 'monthly_income') delete session.record.income_over_2000;
  if (field.key === 'income_over_2000') delete session.record.monthly_income;
  session.unresolved = session.unresolved.filter((k) => k !== field.key);
  session.index = i;
  session.attempts = 0;
  session.askedAt = Date.now();
  return { accepted: true, say: `No problem. ${field.reask || field.ask}`, done: false };
}

// Digits typed on the keypad go straight into the current field, skipping speech
// recognition entirely. This is the accuracy path for the fields where a misheard
// digit is a wrong bank account rather than a typo.
function submitDtmf(session, digits) {
  const field = currentField(session);
  if (!field || !field.dtmf) return null;
  return submit(session, digits, { source: 'dtmf' });
}

function expectedDtmfLength(session) {
  const field = currentField(session);
  return field && field.dtmf ? field.dtmf : null;
}

// What the call cost the caller, per field and in total. Written next to the
// application so a drop-off can be traced to the question that caused it.
function captureMetrics(session) {
  const fields = Object.entries(session.capture).map(([key, c]) => ({
    field: key,
    seconds: Math.round(c.ms / 100) / 10,
    attempts: c.attempts,
    source: c.source,
    revisions: c.revisions || 0,
    gave_up: !!c.gaveUp,
  }));
  const answered = fields.filter((f) => !f.gave_up);
  return {
    fields_reached: fields.length,
    fields_captured: answered.length,
    fields_given_up: fields.length - answered.length,
    retried_fields: fields.filter((f) => f.attempts > 1).map((f) => f.field),
    corrections: session.corrections,
    slowest_field: fields.slice().sort((a, b) => b.seconds - a.seconds)[0]?.field || null,
    total_seconds:
      Math.round(fields.reduce((sum, f) => sum + f.seconds, 0) * 10) / 10,
    per_field: fields,
    // Where the call stopped. On a completed call this is the last field; on an
    // abandoned one it is the question the caller hung up on.
    last_field: fields.length ? fields[fields.length - 1].field : null,
  };
}

module.exports = {
  GREETING,
  MAX_ATTEMPTS,
  startSession,
  currentField,
  nextPrompt,
  submit,
  submitDtmf,
  undoLast,
  complete,
  expectedDtmfLength,
  captureMetrics,
  BY_KEY,
};
