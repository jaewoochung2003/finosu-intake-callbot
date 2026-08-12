// regressions.test.js — one test per bug that has actually shipped here.
//
// Every case below broke at some point and was found either by the adversarial
// review pass or by a fixture that turned out to be testing the wrong thing. They
// are kept apart from the feature tests so it is obvious what they are for: a
// failure in this file means something that was once wrong is wrong again.

const assert = require('assert');
const P = require('../src/parse');
const V = require('../src/validate');
const intake = require('../src/intake');
const SCRIPTS = require('../tools/scripts');

function play(turns) {
  const s = intake.startSession({ callSid: 'reg' });
  for (const line of turns) {
    if (s.state !== 'in_progress') break;
    intake.submit(s, line);
  }
  if (s.state === 'in_progress') intake.complete(s);
  return s;
}

// ---------- refusing to answer is not answering no ----------
// The leading-three-word scan ran before the refusal list, so the "not" in "prefer
// not to say" returned false and made the entire refusal list unreachable. On the
// assistance and military questions that settled a reject rule from an answer the
// caller never gave.

t('regression: "prefer not to say" is a re-ask, not a no', () => {
  for (const said of [
    'I would rather not say',
    'prefer not to say',
    'I prefer not to say',
    'I would prefer not to answer that',
    'not saying',
    'no comment',
    'none of your business',
    'not comfortable answering that',
    'I decline to answer',
    'do I have to answer that',
    'why do you need that',
  ]) {
    assert.strictEqual(P.parseYesNo(said), null, `"${said}" was not read as a refusal`);
  }
});

// An auxiliary verb in the YES set made any sentence starting with one an
// affirmative, so "I have no comment" recorded a yes on the assistance question.
t('regression: "I have no comment" is not a yes', () => {
  assert.strictEqual(P.parseYesNo('I have no comment'), null);
  assert.strictEqual(P.parseYesNo('I am not sure what you mean'), false);
  assert.strictEqual(P.parseYesNo('I do not receive anything'), false);
});

t('regression: "I do" and "I am" still read as yes', () => {
  assert.strictEqual(P.parseYesNo('I do'), true);
  assert.strictEqual(P.parseYesNo('I am'), true);
  assert.strictEqual(P.parseYesNo('I have'), true);
});

t('regression: a refused screening answer is asked again, not recorded', () => {
  const s = play(SCRIPTS['assistance-refused'].turns);
  assert.strictEqual(s.record.financial_assistance, false);
  assert.strictEqual(s.capture.financial_assistance.attempts, 3);
  assert.strictEqual(s.outcome.decision, 'Approved');
});

// ---------- income stated per paycheck ----------
// The income question invited a per-paycheck answer while the pay cycle was still
// twelve questions away, and no pattern matched the word "paycheck", so 1,200 every
// two weeks was recorded as 1,200 a month and declined.

t('regression: the pay cycle is asked before the income figure', () => {
  const { FIELDS } = require('../src/fields');
  const freq = FIELDS.findIndex((f) => f.key === 'pay_frequency');
  const income = FIELDS.findIndex((f) => f.key === 'monthly_income');
  assert.ok(freq >= 0 && income >= 0);
  assert.ok(freq < income, `pay_frequency is at ${freq}, monthly_income at ${income}`);
});

t('regression: twelve hundred a paycheck on a biweekly cycle clears the line', () => {
  const s = play(SCRIPTS['income-per-paycheck'].turns);
  assert.strictEqual(s.record.monthly_income, 2600);
  assert.strictEqual(s.record.income_over_2000, true);
  assert.strictEqual(s.outcome.decision, 'Approved');
});

t('regression: every way of saying per paycheck converts', () => {
  for (const said of [
    'about twelve hundred a paycheck',
    '1200 per paycheck',
    'twelve hundred each check',
    'about 1200 a pay period',
    'twelve hundred per check',
  ]) {
    assert.strictEqual(
      V.validateMonthlyIncome(said, 'Biweekly').value,
      2600,
      `"${said}" did not convert`,
    );
  }
});

// The mirror of the same bug: an unqualified answer is a month, because that is the
// question. Converting it by the pay frequency inflated it 2.17x on a weekly cycle.
t('regression: a bare figure is not multiplied by the pay cycle', () => {
  assert.strictEqual(V.validateMonthlyIncome('three thousand', 'Weekly').value, 3000);
  assert.strictEqual(V.validateMonthlyIncome('2500', 'Biweekly').value, 2500);
});

// ---------- compound spoken amounts ----------
// The ones-then-tens rule added its groups instead of placing them, so "twenty four
// fifty" came out as 470 and declined a caller earning 2,450.

t('regression: compound amounts place their groups', () => {
  const cases = {
    'twenty four fifty': 2450,
    'thirty one fifty': 3150,
    'forty two fifty': 4250,
    'twenty two seventy': 2270,
    'one thirty five': 135,
    'sixteen fifty': 1650,
    'four eighty': 480,
    'four eighty five': 485,
    'nine ninety': 990,
  };
  for (const [said, want] of Object.entries(cases)) {
    assert.strictEqual(P.parseAmount(said), want, `"${said}"`);
  }
});

t('regression: the amounts that already worked still work', () => {
  const cases = {
    'twenty five hundred': 2500,
    'thirty two hundred': 3200,
    'two thousand': 2000,
    'two thousand five hundred': 2500,
    'eleven hundred': 1100,
    'four hundred': 400,
    'a hundred and fifty': 150,
    'three grand': 3000,
    '3k a month': 3000,
    '$2,500': 2500,
    'twenty dollars an hour': 20,
    'twenty five': 25,
  };
  for (const [said, want] of Object.entries(cases)) {
    assert.strictEqual(P.parseAmount(said), want, `"${said}"`);
  }
});

t('regression: 2450 spoken as a compound is approved, not declined', () => {
  const s = play(SCRIPTS['income-compound'].turns);
  assert.strictEqual(s.record.monthly_income, 2450);
  assert.strictEqual(s.outcome.decision, 'Approved');
});

// ---------- a real department that reads as a negative ----------
// saysNone fell through to the yes/no parser with no bound, so any free-text answer
// starting with a negation was thrown away.

t('regression: "Not-For-Profit Services" is a department, not a skip', () => {
  assert.strictEqual(P.saysNone('Not-For-Profit Services', { maxWords: 3 }), false);
  const s = play(SCRIPTS['awkward-department'].turns);
  assert.strictEqual(s.record.employer_department, 'Not-For-Profit Services');
});

t('regression: short refusals still skip', () => {
  for (const said of ["I don't have one", 'none', 'nope', 'no department', 'N/A', 'no']) {
    assert.strictEqual(P.saysNone(said, { maxWords: 3 }), true, `"${said}"`);
  }
});

// ---------- spoken email with a filler in front ----------
// Everything before the "at" was concatenated, so "uh, gabriel dot kim at ..." became
// uhgabriel.kim@..., which validates cleanly and is the wrong address.

t('regression: a leading filler does not join the address', () => {
  assert.strictEqual(P.parseEmail('uh, gabriel dot kim at finosu dot com'), 'gabriel.kim@finosu.com');
  assert.strictEqual(P.parseEmail('um so my email is jae at gmail dot com'), 'jae@gmail.com');
  assert.strictEqual(
    P.parseEmail('okay it is gabriel at finosu dot com'),
    'gabriel@finosu.com',
  );
});

t('regression: a filler word inside the handle survives', () => {
  // "so" and "me" are fillers at the front and part of the address in the middle
  assert.strictEqual(P.parseEmail('so dot me at mail dot com'), 'so.me@mail.com');
});

t('regression: a spoken zero is not mistaken for a filler', () => {
  assert.strictEqual(P.parseEmail('oh two one at mail dot com'), '021@mail.com');
});

// ---------- masking ----------
// maskAccount returned any value of four digits or fewer unchanged, so a retracted
// social security ending was written to the correction log in the clear.

t('regression: a four digit value is masked whole', () => {
  assert.strictEqual(V.maskAccount('4821'), '****');
  assert.strictEqual(V.maskAccount('5512340987'), '******0987');
});

t('regression: a retracted social security ending is not stored in the clear', () => {
  const s = intake.startSession({ callSid: 'reg' });
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.ssn + 1)) intake.submit(s, line);
  assert.strictEqual(s.record.ssn_last_four, '4821');
  intake.undoLast(s);
  assert.strictEqual(s.corrections[0].field, 'ssn_last_four');
  assert.ok(!/\d/.test(s.corrections[0].previous), s.corrections[0].previous);
});

// redact() skipped "o" and "nought", so a routing number read as "o two one o o o"
// kept its zeros in the transcript.
t('regression: every spoken form of a digit is redacted', () => {
  const said = 'o two one o o o o two one and nought';
  const out = V.redact('routing_number', said);
  assert.ok(!/\b(o|nought|two|one)\b/i.test(out), out);
});

// ---------- stepping back ----------
// The walk-back tested appliesWhen alone, which made the income backstop's answer
// unreachable and then deleted it as collateral when the walk passed over it.

t('regression: stepping back reaches the income backstop answer', () => {
  const s = intake.startSession({ callSid: 'reg' });
  const turns = SCRIPTS['income-refused'].turns.slice(0, SCRIPTS.INDEX.income + 4);
  for (const line of turns) intake.submit(s, line);
  assert.strictEqual(s.record.income_over_2000, true);
  const back = intake.undoLast(s);
  assert.ok(back);
  assert.strictEqual(intake.currentField(s).key, 'income_over_2000');
  assert.strictEqual(s.corrections[0].field, 'income_over_2000');
});

// A derived value is not an answer the caller gave, so stepping back must not land
// on the question it came from.
t('regression: stepping back skips a question the caller never heard', () => {
  const s = intake.startSession({ callSid: 'reg' });
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.income + 1)) intake.submit(s, line);
  assert.strictEqual(s.record.income_over_2000, true); // derived, never asked
  intake.undoLast(s);
  assert.strictEqual(intake.currentField(s).key, 'monthly_income');
  assert.strictEqual(s.record.income_over_2000, undefined);
});

// ---------- test fixtures ----------
// variant() removed N turns and inserted N, which deleted the following question's
// answer. A shifted script still landed on the expected decision, so the suite
// passed while testing the wrong call.

t('regression: replacing one turn with two lengthens the script', () => {
  assert.strictEqual(
    SCRIPTS['fake-routing'].turns.length,
    SCRIPTS.APPROVED.length + 1,
    'variant() dropped a turn',
  );
  assert.strictEqual(SCRIPTS.savings.turns.length, SCRIPTS.APPROVED.length);
});

t('regression: every canned script still answers every question it reaches', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    if (!script || !script.turns) continue;
    const s = play(script.turns);
    assert.strictEqual(
      s.state,
      'complete',
      `${name} ran out of answers before the call ended`,
    );
    // A script that has drifted shows up as a field nobody could capture.
    if (script.expect === 'Approved') {
      assert.deepStrictEqual(s.unresolved.filter((k) => k !== 'monthly_income'), [], name);
    }
  }
});
