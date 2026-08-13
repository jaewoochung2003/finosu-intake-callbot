// scripts.js — canned calls.
//
// Each `turns` array is what a caller says, in the order the bot asks. They run
// through the real intake code, so they are both the demo and the end-to-end test
// (test/intake.test.js asserts the `expect` value on every one of them).
//
// Answers are written the way people actually talk: spoken digits, a month name and
// an ordinal for a date, "every other week" for a pay cycle. Nothing here is
// pre-parsed, because parsing is the part being tested.
//
// The answers are keyed by FIELD, not by position, and the turn list is built by
// asking the real script what it wants next. The arrays used to be written out by
// hand with an index map beside them, and both broke whenever a question moved or a
// caller's answer changed which questions applied: an unemployed applicant skips the
// pay cycle, the pay day, the income figure and the whole employer block, so every
// answer after that slid up onto the wrong question. The multi-reject call was
// answering "every other week" to "are you deployed", failing it twice, and landing
// on the right decision by luck. Nothing built this way can drift, because the
// builder walks the same FIELDS the call walks.

const intake = require('../src/intake');

// Drive one call and collect what the caller said, in order. A field whose answer is
// an array is answered once per attempt, which is how a refusal or a corrected value
// gets scripted; the last entry repeats if the bot asks more times than that.
// A read-back is answered under `<field>_confirm`, defaulting to yes.
function build(answers, opts = {}) {
  const session = intake.startSession({ callSid: 'script', ...opts });
  const turns = [];
  const index = {};
  const used = {};
  let guard = 0;

  while (session.state === 'in_progress' && guard++ < 200) {
    const pending = session.pending;
    const field = intake.currentField(session);
    if (!pending && !field) break;

    const key = pending ? `${pending.key}_confirm` : field.key;
    let answer = answers[key];
    if (answer === undefined && pending) answer = 'yes';
    if (answer === undefined) break;

    const n = (used[key] = (used[key] || 0) + 1);
    const said = Array.isArray(answer) ? answer[Math.min(n - 1, answer.length - 1)] : answer;
    if (index[key] === undefined) index[key] = turns.length;
    turns.push(said);
    intake.submit(session, said);
  }
  return { turns, index };
}

const turnsFor = (answers) => build(answers).turns;

const BASE = {
  first_name: 'Gabriel',
  last_name: 'Kim',
  last_name_confirm: 'yes',
  email: 'gabriel at finosu dot com',
  email_confirm: 'yes',
  birthday: 'March fourth nineteen ninety four',
  sms_number: 'no this number is fine',
  employment_status: 'I work full time',
  pay_frequency: 'every other week',
  // Only one of these two is ever asked; which one depends on the cadence above.
  pay_frequency_day: 'Friday',
  specific_day: 'the first and the fifteenth',
  monthly_income: 'about thirty two hundred a month',
  // Only reached when the figure above fails three times.
  income_over_2000: 'yes it is over that',
  deployed_military: 'no',
  financial_assistance: 'no',
  account_type: 'checking',
  ssn_last_four: 'four eight two one',
  routing_number: 'zero two one zero zero zero zero two one', // JPMorgan Chase
  routing_number_confirm: 'yes',
  account_number: 'five five one two three four zero nine eight seven',
  account_number_confirm: 'yes',
  street_1: '1820 Gateway Drive',
  street_2: 'no',
  city: 'San Mateo',
  state: 'California',
  zip: 'nine four four zero four',
  employer_name: 'Finosu',
  employer_department: 'Engineering',
  employer_address: '1820 Gateway Drive, San Mateo, California',
  employer_phone: 'six five zero eight six two nine one one zero',
};

const with_ = (overrides) => turnsFor({ ...BASE, ...overrides });

const APPROVED_BUILD = build(BASE);
const APPROVED = APPROVED_BUILD.turns;

// Exported so tests can walk to a named question instead of counting turns. Built
// from the same run as APPROVED, so it cannot disagree with it. The short aliases are
// the names the tests already used.
const I = {
  ...APPROVED_BUILD.index,
  name_confirm: APPROVED_BUILD.index.last_name_confirm,
  sms: APPROVED_BUILD.index.sms_number,
  employment: APPROVED_BUILD.index.employment_status,
  income: APPROVED_BUILD.index.monthly_income,
  military: APPROVED_BUILD.index.deployed_military,
  assistance: APPROVED_BUILD.index.financial_assistance,
  ssn: APPROVED_BUILD.index.ssn_last_four,
  routing: APPROVED_BUILD.index.routing_number,
  account: APPROVED_BUILD.index.account_number,
  department: APPROVED_BUILD.index.employer_department,
  pay_day: APPROVED_BUILD.index.pay_frequency_day,
};

module.exports = {
  INDEX: I,
  APPROVED,
  // Exposed so a test can build the same call under EARLY_KNOCKOUT=0, where every
  // question is asked before anything is decided and the turn list is therefore
  // longer. Hand-written arrays could not serve both modes.
  build,
  BASE,

  approved: {
    about: 'clean application, everything checks out',
    expect: 'Approved',
    turns: APPROVED,
  },

  savings: {
    about: 'savings account instead of checking',
    expect: 'Declined',
    turns: with_({ account_type: 'savings' }),
  },

  unemployed: {
    about: 'not working',
    expect: 'Declined',
    turns: with_({ employment_status: "I'm between jobs right now" }),
  },

  'low-income': {
    about: 'brings in eleven hundred a month',
    expect: 'Declined',
    turns: with_({ monthly_income: 'about eleven hundred a month' }),
  },

  'low-income-weekly': {
    about: 'four hundred a week, which is under the line once converted',
    expect: 'Declined',
    turns: with_({ monthly_income: 'about four hundred dollars a week' }),
  },

  'income-per-paycheck': {
    about: 'answers per paycheck on a biweekly cycle, which clears the line',
    expect: 'Approved',
    // 1,200 every two weeks is 2,600 a month. Read as 1,200 a month it is a decline,
    // which is what happened before the pay cycle was asked first.
    turns: with_({ monthly_income: 'about twelve hundred a paycheck' }),
  },

  'income-compound': {
    about: 'says twenty four fifty, meaning 2,450',
    expect: 'Approved',
    turns: with_({ monthly_income: 'twenty four fifty' }),
  },

  'income-refused': {
    about: 'will not name a figure, so the yes/no backstop is asked',
    expect: 'Approved',
    turns: with_({
      monthly_income: [
        'I would rather not say',
        'I really do not want to give a number',
        'I prefer not to say',
      ],
      income_over_2000: 'yes it is over that',
    }),
  },

  military: {
    about: 'deployed active duty',
    expect: 'Declined',
    turns: with_({ deployed_military: 'yes I am, I deploy next month' }),
  },

  assistance: {
    about: 'on government assistance',
    expect: 'Declined',
    turns: with_({ financial_assistance: 'yeah I get SNAP' }),
  },

  'assistance-refused': {
    about: 'will not answer the assistance question, so it is asked again',
    expect: 'Approved',
    // A refusal is not a no. Recorded as one it would settle a reject rule from an
    // answer the caller never gave.
    turns: with_({ financial_assistance: ['I prefer not to say', 'no comment', 'no'] }),
  },

  'multi-reject': {
    about: 'unemployed, under the income line, and on assistance',
    expect: 'Declined',
    turns: with_({
      employment_status: 'I am not working at the moment',
      monthly_income: 'about six hundred a month',
      financial_assistance: 'yes, I get food stamps',
    }),
  },

  'fake-routing': {
    about: 'routing number passes the check digit but is not a real one',
    expect: 'Approved',
    // 310000185 is arithmetically a valid ABA number and is not in the FedACH
    // directory, so it is refused and the caller reads the real one instead. The
    // application still ends up Approved, which is the point: the bad number never
    // reaches the record.
    turns: with_({
      routing_number: [
        'three one zero zero zero zero one eight five',
        'zero two one zero zero zero zero two one',
      ],
    }),
  },

  'bad-checksum': {
    about: 'made-up routing number that fails the check digit',
    expect: 'Approved',
    turns: with_({
      routing_number: [
        'one two three four five six seven eight nine',
        'zero two one zero zero zero zero two one',
      ],
    }),
  },

  'no-department': {
    about: 'hourly worker with no department',
    expect: 'Approved',
    turns: with_({ employer_department: "I don't have one" }),
  },

  'awkward-department': {
    about: 'a real department whose name reads as a negative',
    expect: 'Approved',
    turns: with_({ employer_department: 'Not-For-Profit Services' }),
  },

  'messy-digits': {
    about: 'digits read in pairs and with doubles, an email said out loud',
    expect: 'Approved',
    turns: with_({
      email: 'uh, j dot chung two zero zero three at gmail dot com',
      birthday: 'the fourth of March, nineteen ninety four',
      sms_number: 'yes, seven zero three five five five zero one four two',
      monthly_income: 'thirty two hundred',
      ssn_last_four: 'double four two one',
    }),
  },

  'monthly-payroll': {
    about: 'paid monthly, so the day-of-month question is asked instead',
    expect: 'Approved',
    turns: with_({ pay_frequency: 'once a month', specific_day: 'the first and the fifteenth' }),
  },

  'under-18': {
    about: 'applicant is sixteen',
    expect: 'Declined',
    turns: with_({ birthday: 'June third two thousand nine' }),
  },

  // A second persona, so two test emails are tellable apart at a glance. Different
  // name shape (hyphenated), bank, address, weekly income, and a second address line.
  maria: {
    about: 'clean application under a different persona: hyphenated name, weekly pay, Bank of America',
    expect: 'Approved',
    turns: turnsFor({
      ...BASE,
      first_name: 'Maria',
      last_name: 'Alvarez dash Cruz',
      email: 'maria dot alvarez at yahoo dot com',
      birthday: 'July twelfth nineteen eighty eight',
      employment_status: 'yes I work full time',
      pay_frequency: 'every week',
      pay_frequency_day: 'Thursday',
      monthly_income: 'five hundred fifty a week', // 2,383 a month, clears the line
      ssn_last_four: 'seven seven three two',
      routing_number: 'zero two six zero zero nine five nine three', // Bank of America
      account_number: 'nine eight one two two seven zero four five six',
      street_1: '412 Cedar Court',
      street_2: 'apartment two',
      city: 'Falls Church',
      state: 'Virginia',
      zip: 'two two zero four six',
      employer_name: 'Inova Health',
      employer_department: 'Billing',
      employer_address: '8110 Gatehouse Road, Falls Church, Virginia',
      employer_phone: 'seven zero three seven seven six zero one zero zero',
    }),
  },
};
