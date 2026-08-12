const assert = require('assert');
const V = require('../src/validate');

// ---------- routing numbers ----------
// The three cases that matter, in order of how hard they are to catch:
//   1. wrong shape         — anyone catches this
//   2. bad check digit     — arithmetic catches this
//   3. good check digit,   — only the directory catches this, and it is what
//      no such bank          someone making a number up actually produces

t('routing: real one passes and names the bank', () => {
  const r = V.validateRouting('zero two one zero zero zero zero two one');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '021000021');
  assert.match(r.bank, /JPMORGAN CHASE/);
});

t('routing: Bank of America', () => {
  const r = V.validateRouting('026009593');
  assert.strictEqual(r.ok, true);
  assert.match(r.bank, /BANK OF AMERICA/);
});

t('routing: too few digits', () => {
  const r = V.validateRouting('0210000');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /nine/);
});

t('routing: 123456789 fails the check digit', () => {
  const r = V.validateRouting('123456789');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /check digit/);
});

t('routing: bad prefix', () => {
  // 45 is not an issued ABA prefix
  const r = V.validateRouting('450000018');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /prefix/);
});

t('routing: valid arithmetic but no such bank', () => {
  // 310000185 passes prefix and check digit and is not in the FedACH directory
  assert.strictEqual(V.abaChecksum('310000185'), true);
  assert.strictEqual(V.validPrefix('310000185'), true);
  const r = V.validateRouting('310000185');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /directory/);
});

t('routing: the directory actually loaded', () => {
  assert.ok(V.directorySize() > 15000, `directory has ${V.directorySize()} entries`);
});

// ---------- account numbers ----------

t('account: normal', () => {
  const r = V.validateAccount('five five one two three four zero nine eight seven');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '5512340987');
});

t('account: too short', () => assert.strictEqual(V.validateAccount('123').ok, false));
t('account: too long', () =>
  assert.strictEqual(V.validateAccount('123456789012345678').ok, false));

t('account: one digit repeated', () => {
  const r = V.validateAccount('1111111111');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /same digit/);
});

t('account: straight run', () => {
  const r = V.validateAccount('123456789');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /straight run/);
});

t('account: countdown run', () => assert.strictEqual(V.validateAccount('987654321').ok, false));

t('account: the routing number said twice', () => {
  const r = V.validateAccount('021000021', { routing: '021000021' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /routing number again/);
});

t('account: short run under six digits is allowed', () => {
  // 12345 is a run but too short to be worth rejecting; real accounts get short
  assert.strictEqual(V.validateAccount('12345').ok, true);
});

// ---------- the rest ----------

t('name: needs two parts', () => assert.strictEqual(V.validateName('Gabriel').ok, false));
t('name: full name', () =>
  assert.strictEqual(V.validateName('my name is Gabriel Kim').value, 'Gabriel Kim'));

t('email: spoken', () =>
  assert.strictEqual(V.validateEmail('gabriel at finosu dot com').value, 'gabriel@finosu.com'));
t('email: rejects a non-email', () =>
  assert.strictEqual(V.validateEmail('I do not use email').ok, false));

t('dob: adult', () => {
  const r = V.validateDob('March fourth nineteen ninety four', new Date(Date.UTC(2026, 7, 9)));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, '1994-03-04');
});

t('dob: minor is fatal, not a re-ask', () => {
  const r = V.validateDob('June third two thousand nine', new Date(Date.UTC(2026, 7, 9)));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fatal, true);
});

t('ssn4: four digits', () => assert.strictEqual(V.validateSsn4('four eight two one').value, '4821'));
t('ssn4: five digits is a bad capture', () =>
  assert.strictEqual(V.validateSsn4('48210').ok, false));
t('ssn4: 0000 refused', () => assert.strictEqual(V.validateSsn4('0000').ok, false));

t('phone: ten digits', () =>
  assert.strictEqual(V.validatePhone('6508629110').value, '(650) 862-9110'));
t('phone: leading 1 dropped', () =>
  assert.strictEqual(V.validatePhone('1 650 862 9110').value, '(650) 862-9110'));
t('phone: area code cannot start with 1', () =>
  assert.strictEqual(V.validatePhone('1508629110').ok, false));

t('zip: five', () => assert.strictEqual(V.validateZip('nine four four zero four').value, '94404'));
t('zip: plus four', () => assert.strictEqual(V.validateZip('941051234').value, '94105-1234'));
t('zip: four digits fails', () => assert.strictEqual(V.validateZip('9410').ok, false));

t('state', () => assert.strictEqual(V.validateState('California').value, 'CA'));

t('yes/no', () => assert.strictEqual(V.validateYesNo('yeah I get SNAP').value, true));
t('yes/no: unclear is a re-ask', () =>
  assert.strictEqual(V.validateYesNo('I would rather not say').ok, false));

// ---------- income ----------

t('income: plain yes', () => assert.strictEqual(V.validateIncomeOver('yes', 2000).value, true));
t('income: plain no', () => assert.strictEqual(V.validateIncomeOver('no', 2000).value, false));

t('income: amount over', () => {
  const r = V.validateIncomeOver('about thirty two hundred a month', 2000);
  assert.strictEqual(r.value, true);
  assert.strictEqual(r.monthlyIncome, 3200);
});

t('income: weekly amount converted to monthly', () => {
  // 400 a week is 1733 a month, which is under the line even though 400 x 4 is not
  const r = V.validateIncomeOver('about four hundred dollars a week', 2000);
  assert.strictEqual(r.value, false);
  assert.strictEqual(r.monthlyIncome, 1733);
});

t('income: biweekly amount over the line', () => {
  const r = V.validateIncomeOver('twelve hundred every other week', 2000);
  assert.strictEqual(r.value, true);
  assert.strictEqual(r.monthlyIncome, 2600);
});

t('income: hourly needs a re-ask', () => {
  const r = V.validateIncomeOver('twenty dollars an hour', 2000);
  assert.strictEqual(r.ok, false);
});

t('income: a bare number is a month, because that is what was asked', () => {
  // This test used to assert 2600, multiplying an unqualified answer by the pay
  // frequency. That converted "twelve hundred" on a biweekly payroll into 2,600 a
  // month when the caller had answered the monthly question directly.
  const r = V.validateIncomeOver('twelve hundred', 2000, 'Biweekly');
  assert.strictEqual(r.monthlyIncome, 1200);
  assert.strictEqual(r.value, false);
});

t('income: per paycheck IS converted by the pay frequency', () => {
  const r = V.validateIncomeOver('twelve hundred a paycheck', 2000, 'Biweekly');
  assert.strictEqual(r.monthlyIncome, 2600);
  assert.strictEqual(r.value, true);
});

// ---------- logging ----------

t('redact: account digits never survive', () =>
  assert.strictEqual(V.redact('account_number', 'five five one two'), '# # # #'));

t('redact: numerals masked', () =>
  assert.strictEqual(V.redact('ssn_last_four', '4821'), '####'));

t('redact: spoken digits masked', () =>
  assert.ok(!/four|eight|two|one/i.test(V.redact('ssn_last_four', 'four eight two one'))));

t('redact: leaves ordinary fields alone', () =>
  assert.strictEqual(V.redact('city', 'San Mateo'), 'San Mateo'));

t('mask: keeps the last four', () =>
  assert.strictEqual(V.maskAccount('5512340987'), '******0987'));

// ---------- income as a figure ----------
// The brief asks a yes/no. Storing only that answer throws away the number, and the
// number is the thing that survives a change in the threshold.

t('monthly income: plain figure', () => {
  const r = V.validateMonthlyIncome('about thirty two hundred a month');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, 3200);
});

t('monthly income: weekly converted at 52/12, not 4', () => {
  // 400 a week is 1,733 a month. Times four is 1,600, and the two land on opposite
  // sides of nothing here, but at 480 a week they land on opposite sides of 2,000.
  assert.strictEqual(V.validateMonthlyIncome('four hundred dollars a week').value, 1733);
  assert.strictEqual(V.validateMonthlyIncome('four eighty a week').value, 2080);
});

t('monthly income: per paycheck, period taken from pay frequency', () => {
  assert.strictEqual(V.validateMonthlyIncome('twelve hundred a paycheck', 'Biweekly').value, 2600);
  assert.strictEqual(V.validateMonthlyIncome('1200 per check', 'Biweekly').value, 2600);
  assert.strictEqual(V.validateMonthlyIncome('twelve hundred each pay period', 'Weekly').value, 5200);
});

t('monthly income: a bare number is a month, not a paycheck', () => {
  // The question asks for a month. Multiplying an unqualified answer by the pay
  // frequency turned a correct monthly answer into 2.17x on a weekly payroll.
  assert.strictEqual(V.validateMonthlyIncome('twelve hundred', 'Weekly').value, 1200);
});

t('monthly income: per paycheck with no pay cycle known is a re-ask', () => {
  const r = V.validateMonthlyIncome('twelve hundred a paycheck', undefined);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /how often/);
});

t('monthly income: hourly is refused rather than guessed', () => {
  const r = V.validateMonthlyIncome('twenty dollars an hour');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /per month, per week, or per paycheck/);
});

t('monthly income: a yes is not a figure', () => {
  const r = V.validateMonthlyIncome('yes');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /dollar figure/);
});

t('monthly income: absurd figure refused', () =>
  assert.strictEqual(V.validateMonthlyIncome('nine hundred thousand a month').ok, false));

t('income backstop: still takes a yes/no', () => {
  assert.strictEqual(V.validateIncomeOver('yes', 2000).value, true);
  assert.strictEqual(V.validateIncomeOver('no', 2000).value, false);
});

t('income backstop: prefers a figure if one arrives', () => {
  const r = V.validateIncomeOver('about three thousand a month', 2000);
  assert.strictEqual(r.value, true);
  assert.strictEqual(r.monthlyIncome, 3000);
});
