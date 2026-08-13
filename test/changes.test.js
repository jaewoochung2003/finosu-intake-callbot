// changes.test.js — the five things the second pass added.
//
//   1. income kept as a figure, the brief's yes/no derived from it
//   2. "I don't have one" skips a field instead of being written into it
//   3. all five screening questions asked before any of them is acted on
//   4. raw words, timings, retries and corrections recorded per field
//   5. the greeting says what the caller needs to have in front of them

const assert = require('assert');
const intake = require('../src/intake');
const format = require('../src/format');
const SCRIPTS = require('../tools/scripts');
const { FORM_ORDER } = require('../src/fields');

function play(turns, opts = {}) {
  const s = intake.startSession({ earlyKnockout: opts.earlyKnockout !== false, callSid: 'test' });
  for (const line of turns) {
    if (s.state !== 'in_progress') break;
    intake.submit(s, line);
  }
  if (s.state === 'in_progress') intake.complete(s);
  return s;
}

const KO = [
  'employment_status',
  'income_over_2000',
  'deployed_military',
  'financial_assistance',
  'account_type',
];

// ---------- 3. the screening block is asked whole ----------
// A reject row with four holes in it still looks like a row, which is worse than no
// row at all. Every decline carries all five answers.

t('a decline still carries all five screening answers', () => {
  const s = play(SCRIPTS.unemployed.turns);
  assert.strictEqual(s.outcome.decision, 'Declined');
  for (const k of KO) assert.notStrictEqual(s.record[k], undefined, `${k} was not asked`);
});

t('the first bad answer does not end the call', () => {
  const s = play(SCRIPTS.unemployed.turns);
  assert.strictEqual(s.record.employment_status, 'Unemployed');
  assert.strictEqual(s.record.account_type, 'Checking');
});

t('the block still stops before any sensitive field', () => {
  for (const name of ['unemployed', 'savings', 'military', 'assistance', 'low-income']) {
    const s = play(SCRIPTS[name].turns);
    assert.strictEqual(s.record.ssn_last_four, undefined, `${name} reached the SSN`);
    assert.strictEqual(s.record.routing_number, undefined, `${name} reached the routing number`);
    assert.strictEqual(s.record.account_number, undefined, `${name} reached the account number`);
  }
});

t('every firing rule is kept, not just the first', () => {
  const s = play(SCRIPTS['multi-reject'].turns);
  const codes = s.outcome.reasons.map((r) => r.code);
  assert.ok(codes.includes('NOT_EMPLOYED'));
  assert.ok(codes.includes('INCOME_BELOW_2000'));
  assert.ok(codes.includes('FINANCIAL_ASSISTANCE'));
  assert.strictEqual(codes.length, 3);
});

t('two declines have the same shape', () => {
  const a = play(SCRIPTS.savings.turns).record;
  const b = play(SCRIPTS.military.turns).record;
  const shape = (r) => KO.filter((k) => r[k] !== undefined).sort();
  assert.deepStrictEqual(shape(a), shape(b));
  assert.strictEqual(shape(a).length, 5);
});

// ---------- 1. income as a figure ----------

t('the figure is stored and the boolean is derived from it', () => {
  const s = play(SCRIPTS.approved.turns);
  assert.strictEqual(s.record.monthly_income, 3200);
  assert.strictEqual(s.record.income_over_2000, true);
});

t('a weekly figure is converted before the comparison', () => {
  const s = play(SCRIPTS['low-income-weekly'].turns);
  assert.strictEqual(s.record.monthly_income, 1733);
  assert.strictEqual(s.record.income_over_2000, false);
  assert.deepStrictEqual(s.outcome.reasons.map((r) => r.code), ['INCOME_BELOW_2000']);
});

t('the yes/no is never asked when a figure was given', () => {
  const s = play(SCRIPTS.approved.turns);
  assert.strictEqual(s.capture.income_over_2000, undefined);
  assert.ok(s.capture.monthly_income);
});

t('a caller who will not name a figure gets the yes/no instead', () => {
  const s = play(SCRIPTS['income-refused'].turns);
  assert.ok(s.unresolved.includes('monthly_income'));
  assert.strictEqual(s.record.income_over_2000, true);
  assert.strictEqual(s.record.monthly_income, undefined);
  assert.strictEqual(s.outcome.decision, 'Approved');
});

// ---------- 2. "I don't have one" ----------

t('no department skips instead of storing the sentence', () => {
  const s = play(SCRIPTS['no-department'].turns);
  assert.strictEqual(s.record.employer_department, 'None');
});

t('a real department is still stored', () => {
  const s = play(SCRIPTS.approved.turns);
  assert.strictEqual(s.record.employer_department, 'Engineering');
});

// ---------- 4. what the call cost ----------

t('every answered field has raw words next to the value', () => {
  const s = play(SCRIPTS.approved.turns);
  assert.strictEqual(s.capture.email.raw, 'gabriel at finosu dot com');
  assert.strictEqual(s.capture.email.value, 'gabriel@finosu.com');
  assert.strictEqual(s.capture.birthday.raw, 'March fourth nineteen ninety four');
  assert.strictEqual(s.capture.birthday.value, '1994-03-04');
});

t('a sensitive field keeps neither the raw nor the value', () => {
  const s = play(SCRIPTS.approved.turns);
  for (const key of ['ssn_last_four', 'routing_number', 'account_number']) {
    const c = s.capture[key];
    assert.strictEqual(c.value, null, `${key} value leaked into capture`);
    assert.ok(!/\d/.test(c.raw), `${key} raw leaked digits: ${c.raw}`);
    assert.strictEqual(typeof c.value_length, 'number');
  }
});

t('retries and timings are counted', () => {
  const s = play(SCRIPTS['fake-routing'].turns);
  assert.strictEqual(s.capture.routing_number.attempts, 2);
  assert.strictEqual(typeof s.capture.routing_number.ms, 'number');
  assert.ok(intake.captureMetrics(s).retried_fields.includes('routing_number'));
});

t('a field given up on is marked, not silently missing', () => {
  const turns = SCRIPTS.approved.turns.slice();
  turns.splice(SCRIPTS.INDEX.routing, 1, 'mmm', 'mmm', 'mmm');
  const s = play(turns);
  const m = intake.captureMetrics(s);
  assert.strictEqual(m.fields_given_up, 1);
  assert.ok(m.per_field.find((f) => f.field === 'routing_number').gave_up);
});

tKeypad('the keypad shows up as the source', () => {
  const s = intake.startSession({ callSid: 'test' });
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.ssn)) intake.submit(s, line);
  intake.submitDtmf(s, '4821');
  assert.strictEqual(s.capture.ssn_last_four.source, 'dtmf');
});

t('a correction is kept, not overwritten', () => {
  const s = intake.startSession({ callSid: 'test' });
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.income + 1)) intake.submit(s, line);
  assert.strictEqual(s.record.monthly_income, 3200);
  intake.undoLast(s);
  intake.submit(s, 'sorry, about eighteen hundred a month');
  assert.strictEqual(s.record.monthly_income, 1800);
  assert.strictEqual(s.corrections.length, 1);
  assert.strictEqual(s.corrections[0].field, 'monthly_income');
  assert.strictEqual(s.corrections[0].previous, 3200);
  assert.strictEqual(s.capture.monthly_income.revisions, 1);
});

t('undoing the income figure clears the derived boolean too', () => {
  const s = intake.startSession({ callSid: 'test' });
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.income + 1)) intake.submit(s, line);
  assert.strictEqual(s.record.income_over_2000, true);
  intake.undoLast(s);
  assert.strictEqual(s.record.income_over_2000, undefined);
  assert.strictEqual(s.record.monthly_income, undefined);
});

t('a correction on a sensitive field is logged masked', () => {
  const s = intake.startSession({ callSid: 'test' });
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.account + 1)) intake.submit(s, line);
  assert.strictEqual(s.record.account_number, '5512340987');
  intake.undoLast(s);
  assert.strictEqual(s.corrections[0].previous, '******0987');
});

// ---------- 5. the greeting ----------

t('the greeting says what to have ready before the call needs it', () => {
  assert.match(intake.GREETING, /routing/i);
  assert.match(intake.GREETING, /social/i);
});

// ---------- output ----------

t('the policy version rides on the decision and into the payload', () => {
  const s = play(SCRIPTS.approved.turns);
  assert.ok(s.outcome.policyVersion);
  assert.strictEqual(format.apiPayload(s).decision.policy_version, s.outcome.policyVersion);
});

t('the income figure reaches the payload', () => {
  const s = play(SCRIPTS.approved.turns);
  assert.strictEqual(format.apiPayload(s).application.employment.monthly_income_estimate, 3200);
});

t('the brief form is still exactly its 24 lines', () => {
  const s = play(SCRIPTS.approved.turns);
  assert.strictEqual(format.formLines(s.record).length, FORM_ORDER.length);
});

t('the figure is printed under its own heading, not inside the form', () => {
  const s = play(SCRIPTS.approved.turns);
  const grouped = format.formTextGrouped(s.record);
  assert.ok(grouped.includes('Also captured'));
  assert.ok(grouped.includes('$3,200'));
  assert.ok(!format.formLines(s.record).some((l) => l.startsWith('Monthly income')));
});

t('capture metrics land in the payload', () => {
  const s = play(SCRIPTS.approved.turns);
  const p = format.apiPayload(s);
  assert.ok(p.capture_metrics.fields_captured > 20);
  assert.ok(Array.isArray(p.capture_metrics.per_field));
});

t('the payload is still JSON-safe with the metrics attached', () => {
  const s = play(SCRIPTS['fake-routing'].turns);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(format.apiPayload(s))));
});
