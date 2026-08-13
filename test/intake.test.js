const assert = require('assert');
const intake = require('../src/intake');
const format = require('../src/format');
const SCRIPTS = require('../tools/scripts');
const { FORM_ORDER } = require('../src/fields');

// Runs a canned call end to end through the real code and hands back the session.
function play(turns, opts = {}) {
  const s = intake.startSession({ earlyKnockout: opts.earlyKnockout !== false, callSid: 'test' });
  for (const line of turns) {
    if (s.state !== 'in_progress') break;
    intake.submit(s, line);
  }
  if (s.state === 'in_progress') intake.complete(s);
  return s;
}

// ---------- every canned call lands where it says it does ----------

for (const [name, script] of Object.entries(SCRIPTS).filter(([, v]) => v && v.turns)) {
  t(`script "${name}" -> ${script.expect}`, () => {
    const s = play(script.turns);
    assert.strictEqual(
      s.outcome.decision,
      script.expect,
      `got ${s.outcome.decision} (${s.outcome.reasons.map((r) => r.code).join(', ')})`,
    );
  });
}

// ---------- what the clean call actually captured ----------

t('approved call fills the whole form', () => {
  const s = play(SCRIPTS.approved.turns);
  const r = s.record;
  assert.strictEqual(r.name, 'Gabriel Kim');
  assert.strictEqual(r.email, 'gabriel@finosu.com');
  assert.strictEqual(r.birthday, '1994-03-04');
  assert.strictEqual(r.sms_number, 'Same as calling number');
  assert.strictEqual(r.ssn_last_four, '4821');
  assert.strictEqual(r.routing_number, '021000021');
  assert.strictEqual(r.account_number, '5512340987');
  assert.strictEqual(r.account_type, 'Checking');
  assert.strictEqual(r.city, 'San Mateo');
  assert.strictEqual(r.state, 'CA');
  assert.strictEqual(r.zip, '94404');
  assert.strictEqual(r.employment_status, 'Employed');
  assert.strictEqual(r.pay_frequency, 'Biweekly');
  assert.strictEqual(r.pay_frequency_day, 'Friday');
  assert.strictEqual(r.specific_day, 'N/A'); // biweekly has no day of the month
  assert.strictEqual(r.income_over_2000, true);
  assert.strictEqual(r.employer_phone, '(650) 862-9110');
  assert.strictEqual(r.deployed_military, false);
  assert.strictEqual(r.financial_assistance, false);
});

t('routing number carries the bank name into the record', () => {
  const s = play(SCRIPTS.approved.turns);
  assert.match(s.record.bank_name, /JPMORGAN CHASE/);
});

t('monthly payroll asks the day of the month instead', () => {
  const s = play(SCRIPTS['monthly-payroll'].turns);
  assert.strictEqual(s.record.pay_frequency, 'Monthly');
  assert.strictEqual(s.record.pay_frequency_day, 'N/A');
  assert.strictEqual(s.record.specific_day, '1 and 15');
});

t('an amount instead of yes/no is converted and stored', () => {
  const s = play(SCRIPTS['messy-digits'].turns);
  assert.strictEqual(s.record.monthly_income, 3200);
  assert.strictEqual(s.record.income_over_2000, true);
  assert.strictEqual(s.record.email, 'j.chung2003@gmail.com');
  assert.strictEqual(s.record.sms_number, '(703) 555-0142');
});

// ---------- the fraud path ----------

t('a made-up routing number never reaches the record', () => {
  const s = play(SCRIPTS['fake-routing'].turns);
  assert.strictEqual(s.record.routing_number, '021000021');
  assert.strictEqual(s.outcome.decision, 'Approved');
});

t('the re-ask says what was actually wrong', () => {
  const s = intake.startSession({ callSid: 'test' });
  // walk to the routing number question
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.routing)) intake.submit(s, line);
  const r = intake.submit(s, 'three one zero zero zero zero one eight five');
  assert.strictEqual(r.accepted, false);
  assert.match(r.problem, /directory/);
  assert.match(r.say, /directory/);
});

// ---------- knockouts ----------

t('a knockout ends the call before the social security digits', () => {
  const s = play(SCRIPTS.unemployed.turns);
  assert.strictEqual(s.outcome.decision, 'Declined');
  assert.strictEqual(s.record.ssn_last_four, undefined);
  assert.strictEqual(s.record.routing_number, undefined);
  assert.strictEqual(s.record.account_number, undefined);
});

t('savings ends the call before the account number', () => {
  const s = play(SCRIPTS.savings.turns);
  assert.strictEqual(s.record.account_number, undefined);
  assert.deepStrictEqual(s.outcome.reasons.map((r) => r.code), ['ACCOUNT_TYPE_SAVINGS']);
});

t('with knockouts off the whole form is asked and the decision is the same', () => {
  const s = play(SCRIPTS.savings.turns, { earlyKnockout: false });
  assert.strictEqual(s.outcome.decision, 'Declined');
  assert.strictEqual(s.record.account_number, '5512340987'); // it did ask
  assert.deepStrictEqual(s.outcome.reasons.map((r) => r.code), ['ACCOUNT_TYPE_SAVINGS']);
});

t('under 18 ends it immediately', () => {
  const s = play(SCRIPTS['under-18'].turns);
  assert.strictEqual(s.outcome.decision, 'Declined');
  assert.strictEqual(s.outcome.reasons[0].code, 'UNDER_18');
});

// ---------- re-asks and giving up ----------

t('three bad answers moves on and leaves the field out', () => {
  const s = intake.startSession({ callSid: 'test' });
  for (let i = 0; i < 3; i++) intake.submit(s, 'mmm');
  assert.ok(s.unresolved.includes('first_name'));
  assert.strictEqual(s.record.first_name, undefined);
  // the other half is still worth asking for
  assert.strictEqual(intake.currentField(s).key, 'last_name');
});

t('an unresolved required field makes the call Incomplete, not Declined', () => {
  const turns = SCRIPTS.approved.turns.slice();
  turns.splice(SCRIPTS.INDEX.routing, 1, 'mmm', 'mmm', 'mmm'); // routing number never captured
  const s = play(turns);
  assert.strictEqual(s.outcome.decision, 'Incomplete');
  assert.ok(s.unresolved.includes('routing_number'));
});

t('back steps to the previous question and clears it', () => {
  const s = intake.startSession({ callSid: 'test' });
  intake.submit(s, 'Gabriel');
  intake.submit(s, 'Kim');
  intake.submit(s, 'yes'); // the name is read back before the call moves on
  intake.submit(s, 'gabriel at finosu dot com');
  intake.submit(s, 'yes');
  assert.strictEqual(s.record.email, 'gabriel@finosu.com');
  const back = intake.undoLast(s);
  assert.ok(back);
  assert.strictEqual(s.record.email, undefined);
  assert.strictEqual(intake.currentField(s).key, 'email');
});

t('back after a routing number clears the bank name too', () => {
  const s = intake.startSession({ callSid: 'test' });
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.routing + 1)) intake.submit(s, line);
  assert.ok(s.record.bank_name);
  intake.undoLast(s);
  assert.strictEqual(s.record.bank_name, undefined);
});

// ---------- keypad ----------

t('typed digits fill the field without speech', () => {
  const s = intake.startSession({ callSid: 'test' });
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.ssn)) intake.submit(s, line);
  assert.strictEqual(intake.currentField(s).key, 'ssn_last_four');
  assert.strictEqual(intake.expectedDtmfLength(s), 4);
  intake.submitDtmf(s, '4821');
  assert.strictEqual(s.record.ssn_last_four, '4821');
});

t('the keypad is not offered on a question that is not a number', () => {
  const s = intake.startSession({ callSid: 'test' });
  assert.strictEqual(intake.expectedDtmfLength(s), null); // name
  assert.strictEqual(intake.submitDtmf(s, '1234'), null);
});

// ---------- the transcript ----------

t('the transcript never holds the social or the account digits', () => {
  const s = play(SCRIPTS.approved.turns);
  const sensitive = s.transcript.filter((x) =>
    ['ssn_last_four', 'account_number', 'routing_number'].includes(x.field),
  );
  assert.ok(sensitive.length >= 3);
  for (const line of sensitive) {
    assert.ok(!/\d/.test(line.said), `digits leaked: ${line.said}`);
    assert.ok(
      !/\b(one|two|three|four|five|six|seven|eight|nine|zero)\b/i.test(line.said),
      `spoken digits leaked: ${line.said}`,
    );
  }
});

t('the transcript does keep the ordinary answers', () => {
  const s = play(SCRIPTS.approved.turns);
  const city = s.transcript.find((x) => x.field === 'city');
  assert.strictEqual(city.said, 'San Mateo');
});

// ---------- output ----------

t('the form prints every field the brief listed', () => {
  const s = play(SCRIPTS.approved.turns);
  const lines = format.formLines(s.record);
  assert.strictEqual(lines.length, FORM_ORDER.length);
  assert.ok(lines.includes('Name: Gabriel Kim'));
  assert.ok(lines.includes('Email: gabriel@finosu.com'));
  assert.ok(lines.includes('Checking/Savings: Checking'));
  assert.ok(lines.includes('If I am deployed military: No'));
  assert.ok(lines.includes('If salary is over 2000 dollars a month: Yes'));
});

t('a field never asked prints as a dash, not as blank or null', () => {
  const s = play(SCRIPTS.unemployed.turns);
  const lines = format.formLines(s.record);
  assert.ok(lines.includes('Routing Number: —'));
  assert.ok(!lines.some((l) => /null|undefined/.test(l)));
});

t('the API payload carries the decision and the reason codes', () => {
  const s = play(SCRIPTS.savings.turns);
  const p = format.apiPayload(s);
  assert.strictEqual(p.decision.outcome, 'Declined');
  assert.deepStrictEqual(p.decision.reason_codes, ['ACCOUNT_TYPE_SAVINGS']);
  assert.strictEqual(p.application.bank_account.account_type, 'Savings');
});

t('the payload is JSON-safe', () => {
  const s = play(SCRIPTS.approved.turns);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(format.apiPayload(s))));
});

t('the subject line names the caller and the outcome', () => {
  const s = play(SCRIPTS.approved.turns);
  assert.strictEqual(format.emailSubject(s), 'Loan intake — Gabriel Kim — Approved');
});

t('the HTML body escapes what came off the call', () => {
  const s = intake.startSession({ callSid: 'test' });
  intake.submit(s, 'Gabriel');
  intake.submit(s, 'Kim');
  intake.submit(s, 'yes');
  intake.submit(s, 'gabriel at finosu dot com');
  intake.submit(s, 'yes');
  s.record.city = '<script>alert(1)</script>';
  intake.complete(s);
  const html = format.emailHtml(s);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
