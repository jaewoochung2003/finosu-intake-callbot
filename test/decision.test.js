const assert = require('assert');
const { decide, firstKnockout } = require('../src/decision');

// A record that passes every rule. Each test breaks exactly one thing.
const CLEAN = {
  name: 'Gabriel Kim',
  email: 'gabriel@finosu.com',
  birthday: '1994-03-04',
  ssn_last_four: '4821',
  routing_number: '021000021',
  account_number: '5512340987',
  account_type: 'Checking',
  street_1: '1820 Gateway Drive',
  city: 'San Mateo',
  state: 'CA',
  zip: '94404',
  employment_status: 'Employed',
  employer_name: 'Finosu',
  pay_frequency: 'Biweekly',
  income_over_2000: true,
  employer_address: '1820 Gateway Drive, San Mateo, CA',
  employer_phone: '(650) 862-9110',
  financial_assistance: false,
  deployed_military: false,
};

const broken = (patch) => ({ ...CLEAN, ...patch });

t('clean record approves', () => {
  const d = decide(CLEAN);
  assert.strictEqual(d.decision, 'Approved');
  assert.deepStrictEqual(d.reasons, []);
});

t('savings declines', () => {
  const d = decide(broken({ account_type: 'Savings' }));
  assert.strictEqual(d.decision, 'Declined');
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['ACCOUNT_TYPE_SAVINGS']);
});

t('unemployed declines', () => {
  const d = decide(broken({ employment_status: 'Unemployed' }));
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['NOT_EMPLOYED']);
});

t('under 2000 declines', () => {
  const d = decide(broken({ income_over_2000: false }));
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['INCOME_BELOW_2000']);
});

t('deployed military declines', () => {
  const d = decide(broken({ deployed_military: true }));
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['DEPLOYED_MILITARY']);
});

t('financial assistance declines', () => {
  const d = decide(broken({ financial_assistance: true }));
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['FINANCIAL_ASSISTANCE']);
});

t('made-up routing number declines', () => {
  const d = decide(broken({ routing_number: '310000185' }));
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['BANK_ROUTING_INVALID']);
});

t('bad check digit declines', () => {
  const d = decide(broken({ routing_number: '123456789' }));
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['BANK_ROUTING_INVALID']);
});

t('repeated-digit account declines', () => {
  const d = decide(broken({ account_number: '1111111111' }));
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['BANK_ACCOUNT_INVALID']);
});

t('several rules fire together', () => {
  const d = decide(broken({ account_type: 'Savings', deployed_military: true, income_over_2000: false }));
  assert.strictEqual(d.decision, 'Declined');
  assert.strictEqual(d.reasons.length, 3);
});

t('a short record is Incomplete, not Declined', () => {
  const partial = { name: 'Gabriel Kim', email: 'gabriel@finosu.com' };
  const d = decide(partial);
  assert.strictEqual(d.decision, 'Incomplete');
  assert.strictEqual(d.reasons.length, 0);
  assert.ok(d.unevaluated.includes('NOT_EMPLOYED'));
});

t('a rule that already failed beats an unreachable one', () => {
  // Employment answered and bad, banking never reached: still Declined.
  const d = decide({ employment_status: 'Unemployed' });
  assert.strictEqual(d.decision, 'Declined');
});

// ---------- mid-call knockout ----------

t('knockout: nothing yet', () => assert.strictEqual(firstKnockout({}), null));

t('knockout: fires on the answer that settles it', () => {
  const rule = firstKnockout({ employment_status: 'Unemployed' });
  assert.strictEqual(rule.code, 'NOT_EMPLOYED');
});

t('knockout: savings', () => {
  assert.strictEqual(firstKnockout({ account_type: 'Savings' }).code, 'ACCOUNT_TYPE_SAVINGS');
});

t('knockout: does not fire on a good answer', () => {
  assert.strictEqual(firstKnockout({ employment_status: 'Employed', account_type: 'Checking' }), null);
});

t('knockout: bank rules are not knockouts', () => {
  // A bad routing number is caught at capture, not by ending the call early.
  assert.strictEqual(firstKnockout({ routing_number: '310000185' }), null);
});

// ---------- the figure decides, the boolean is the fallback ----------

const { screeningSettled, allKnockouts, INCOME_THRESHOLD, POLICY_VERSION } = require('../src/decision');

t('income figure decides over the boolean', () => {
  // Boolean says yes, figure says 900. The figure wins.
  const d = decide({ ...CLEAN, income_over_2000: true, monthly_income: 900 });
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['INCOME_BELOW_2000']);
});

t('income figure above the line approves', () => {
  const d = decide({ ...CLEAN, monthly_income: 2001 });
  assert.strictEqual(d.decision, 'Approved');
});

t('exactly the threshold approves, following the reject rule', () => {
  const d = decide({ ...CLEAN, monthly_income: INCOME_THRESHOLD });
  assert.strictEqual(d.decision, 'Approved');
});

t('one dollar under the threshold declines', () => {
  const d = decide({ ...CLEAN, monthly_income: INCOME_THRESHOLD - 1 });
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['INCOME_BELOW_2000']);
});

t('no figure falls back to the yes/no', () => {
  const d = decide({ ...CLEAN, monthly_income: undefined, income_over_2000: false });
  assert.deepStrictEqual(d.reasons.map((r) => r.code), ['INCOME_BELOW_2000']);
});

t('every decision carries the policy version', () => {
  assert.strictEqual(decide(CLEAN).policyVersion, POLICY_VERSION);
  assert.strictEqual(decide({}).policyVersion, POLICY_VERSION);
});

// ---------- the screening block ----------

t('screening is not settled until all five land', () => {
  assert.strictEqual(screeningSettled({}), false);
  assert.strictEqual(screeningSettled({ employment_status: 'Unemployed' }), false);
  assert.strictEqual(
    screeningSettled({
      employment_status: 'Employed',
      income_over_2000: true,
      deployed_military: false,
      financial_assistance: false,
      account_type: 'Checking',
    }),
    true,
  );
});

t('a question nobody could capture counts as settled', () => {
  const app = {
    employment_status: 'Employed',
    income_over_2000: true,
    deployed_military: false,
    financial_assistance: false,
  };
  assert.strictEqual(screeningSettled(app, []), false);
  assert.strictEqual(screeningSettled(app, ['account_type']), true);
});

t('allKnockouts returns every firing rule, not the first', () => {
  const codes = allKnockouts({
    employment_status: 'Unemployed',
    income_over_2000: false,
    deployed_military: true,
    financial_assistance: true,
    account_type: 'Savings',
  }).map((r) => r.code);
  assert.strictEqual(codes.length, 5);
  assert.ok(codes.includes('NOT_EMPLOYED'));
  assert.ok(codes.includes('ACCOUNT_TYPE_SAVINGS'));
});

t('allKnockouts ignores the bank rules', () => {
  const codes = allKnockouts({ ...CLEAN, routing_number: '310000185' }).map((r) => r.code);
  assert.deepStrictEqual(codes, []);
});
