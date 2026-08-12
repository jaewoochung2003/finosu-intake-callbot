// fields.js — the call script, as data.
//
// One entry per thing the brief asks for, in the order the bot asks it. The server
// owns this order, not the model: the model is handed one question at a time and
// gets the next one back from the tool result, so it cannot skip a field, invent a
// field, or wander off the form.
//
// Two orderings decisions worth naming, because they are the ones a reviewer would
// question:
//
//   1. The five knockout questions come before the social security digits, the
//      routing number and the account number. Every one of the five reject rules in
//      the brief can be settled from answers that are not secret, so an applicant
//      who is going to be declined never has to read a bank account down the phone.
//      Set EARLY_KNOCKOUT=0 to ask all 24 questions before deciding, which is the
//      literal reading of the brief.
//
//   2. Checking-or-savings is asked before the routing and account numbers rather
//      than after, for the same reason: savings is a reject, and there is no point
//      taking the numbers first.
//
// `ask` is what the bot says. `reask` is what it says when the answer did not
// validate; the validator's own error is appended to it, so the caller hears what
// was actually wrong ("that number fails the routing number check digit") instead
// of the same sentence twice.

const V = require('./validate');
const P = require('./parse');
// Policy lives in decision.js. This file only asks the questions.
const { INCOME_THRESHOLD } = require('./decision');

const PAY_FREQUENCIES = ['Weekly', 'Biweekly', 'Semiweekly', 'Monthly'];

// Spoken forms that map onto the four the brief lists. "Twice a month" is what
// people actually say for the third one; the brief writes "Semiweekly", which is
// almost certainly meant to be semimonthly, so both routes land on the same value.
const PAY_FREQUENCY_SYNONYMS = {
  'every week': 'Weekly',
  'once a week': 'Weekly',
  'every two weeks': 'Biweekly',
  'every other week': 'Biweekly',
  'twice a month': 'Semiweekly',
  'two times a month': 'Semiweekly',
  'semi monthly': 'Semiweekly',
  'semimonthly': 'Semiweekly',
  'semi weekly': 'Semiweekly',
  'twice a week': 'Semiweekly',
  'once a month': 'Monthly',
  'every month': 'Monthly',
};

const EMPLOYMENT_STATUSES = ['Employed', 'Self-employed', 'Unemployed', 'Retired', 'Student'];

const EMPLOYMENT_SYNONYMS = {
  'full time': 'Employed',
  'part time': 'Employed',
  'i work': 'Employed',
  'i have a job': 'Employed',
  'self employed': 'Self-employed',
  'own business': 'Self-employed',
  'freelance': 'Self-employed',
  'contractor': 'Self-employed',
  '1099': 'Self-employed',
  'not working': 'Unemployed',
  'no job': 'Unemployed',
  'laid off': 'Unemployed',
  'between jobs': 'Unemployed',
  'looking for work': 'Unemployed',
  'jobless': 'Unemployed',
  'retired': 'Retired',
  'on disability': 'Unemployed',
  'in school': 'Student',
};

const FIELDS = [
  // --- who is calling -------------------------------------------------------
  {
    key: 'name',
    label: 'Name',
    group: 'Applicant',
    ask: 'Can I start with your full name?',
    reask: 'I want to be sure I have that right.',
    validate: (said) => V.validateName(said),
  },
  {
    key: 'email',
    label: 'Email',
    group: 'Applicant',
    ask: 'What email address should we send the decision to?',
    reask: 'Let me get that email again.',
    confirm: true,
    validate: (said) => V.validateEmail(said),
  },
  {
    key: 'birthday',
    label: 'Birthday',
    group: 'Applicant',
    ask: 'And your date of birth?',
    reask: 'One more time on the date of birth.',
    validate: (said) => V.validateDob(said),
  },
  {
    key: 'sms_number',
    label: 'Number for SMS if different',
    group: 'Applicant',
    ask: 'Is there a different number you want text messages sent to? If the number you are calling from is fine, just say no.',
    optional: true,
    skipOn: P.saysNone,
    skipValue: 'Same as calling number',
    dtmf: 10,
    validate: (said) => V.validatePhone(said),
  },

  // --- the five knockouts ---------------------------------------------------
  {
    key: 'employment_status',
    label: 'Employment Status',
    group: 'Employment',
    ask: 'What is your current employment status?',
    reask: 'I need your employment status.',
    knockout: true,
    validate: (said) => V.validateEnum(said, EMPLOYMENT_STATUSES, EMPLOYMENT_SYNONYMS),
  },
  {
    // Asked before the income figure, not with the rest of the employment block at
    // the end. A caller invited to answer "per paycheck" can only be understood if
    // the pay cycle is already known; asking it afterwards meant twelve hundred
    // every two weeks was recorded as twelve hundred a month and declined.
    key: 'pay_frequency',
    label: 'Pay Frequency',
    group: 'Employment',
    ask: 'How often are you paid? Weekly, every two weeks, twice a month, or monthly.',
    reask: 'Weekly, every two weeks, twice a month, or monthly?',
    validate: (said) => V.validateEnum(said, PAY_FREQUENCIES, PAY_FREQUENCY_SYNONYMS),
  },
  {
    key: 'monthly_income',
    label: 'Monthly income',
    group: 'Employment',
    ask: 'And about how much do you bring in a month? A rough figure is fine, or tell me what one paycheck is and I will work it out.',
    reask: 'A rough dollar figure is all I need.',
    knockout: true,
    // The boolean the brief asks for is derived here rather than asked, so the
    // record keeps the number. Move the threshold and this follows it.
    derive: (monthly) => ({ income_over_2000: monthly > INCOME_THRESHOLD }),
    validate: (said, app) => V.validateMonthlyIncome(said, app.pay_frequency),
  },
  {
    // Only asked when three tries at a figure produced nothing. A caller who will
    // not name a number can still answer the threshold question.
    key: 'income_over_2000',
    label: 'If salary is over 2000 dollars a month',
    group: 'Employment',
    ask: 'Then let me just ask it this way. Is what you bring in more than two thousand dollars a month?',
    reask: 'I need a yes or a no on whether it is over two thousand a month.',
    knockout: true,
    appliesWhen: (app) => app.income_over_2000 === undefined,
    validate: (said, app) => V.validateIncomeOver(said, INCOME_THRESHOLD, app.pay_frequency),
  },
  {
    key: 'deployed_military',
    label: 'If I am deployed military',
    group: 'Eligibility',
    ask: 'Are you active duty military on deployment, or a dependent of someone who is?',
    reask: 'I need a yes or a no on the deployment question.',
    knockout: true,
    validate: (said) => V.validateYesNo(said),
  },
  {
    key: 'financial_assistance',
    label: 'If I am on financial assistance',
    group: 'Eligibility',
    ask: 'Are you currently receiving any government financial assistance?',
    reask: 'I need a yes or a no on financial assistance.',
    knockout: true,
    validate: (said) => V.validateYesNo(said),
  },
  {
    key: 'account_type',
    label: 'Checking/Savings',
    group: 'Bank Account',
    ask: 'Would the funds go into a checking account or a savings account?',
    reask: 'Checking or savings?',
    knockout: true,
    validate: (said) =>
      V.validateEnum(said, ['Checking', 'Savings'], {
        'check in': 'Checking',
        'chequing': 'Checking',
        'saving': 'Savings',
      }),
  },

  // --- the sensitive block, only reached by an applicant still in play ------
  {
    key: 'ssn_last_four',
    label: 'Last Four of Social',
    group: 'Applicant',
    ask: 'I need the last four digits of your social security number. You can say them or type them on your keypad.',
    reask: 'Let me take those last four digits again.',
    dtmf: 4,
    sensitive: true,
    validate: (said) => V.validateSsn4(said),
  },
  {
    key: 'routing_number',
    label: 'Routing Number',
    group: 'Bank Account',
    ask: 'What is the nine digit routing number for that account? Typing it on your keypad is the surest way.',
    reask: 'Let me take that routing number again.',
    dtmf: 9,
    sensitive: true,
    confirm: true,
    validate: (said) => V.validateRouting(said),
  },
  {
    key: 'account_number',
    label: 'Account Number',
    group: 'Bank Account',
    ask: 'And the account number itself.',
    reask: 'Let me take that account number again.',
    dtmf: 17,
    sensitive: true,
    confirm: true,
    validate: (said, app) =>
      V.validateAccount(said, { routing: app.routing_number, ssn4: app.ssn_last_four }),
  },

  // --- address --------------------------------------------------------------
  {
    key: 'street_1',
    label: 'Street Address 1',
    group: 'Address',
    ask: 'What is your street address?',
    reask: 'The street address again.',
    validate: (said) => V.validateText(said, { min: 4 }),
  },
  {
    key: 'street_2',
    label: 'Street Address 2',
    group: 'Address',
    ask: 'Is there an apartment or unit number?',
    optional: true,
    skipOn: (said) => P.saysNone(said, { maxWords: 3 }),
    skipValue: '',
    validate: (said) => V.validateText(said, { min: 1 }),
  },
  {
    key: 'city',
    label: 'City',
    group: 'Address',
    ask: 'City?',
    validate: (said) => V.validateText(said, { min: 2, max: 60 }),
  },
  {
    key: 'state',
    label: 'State',
    group: 'Address',
    ask: 'State?',
    validate: (said) => V.validateState(said),
  },
  {
    key: 'zip',
    label: 'Zip Code',
    group: 'Address',
    ask: 'And the zip code.',
    dtmf: 5,
    validate: (said) => V.validateZip(said),
  },

  // --- employer -------------------------------------------------------------
  {
    key: 'employer_name',
    label: 'Employer Name',
    group: 'Employment',
    ask: 'Who do you work for?',
    validate: (said) => V.validateText(said, { min: 2, max: 80 }),
  },
  {
    key: 'employer_department',
    label: 'Employer Department',
    group: 'Employment',
    // Plenty of hourly jobs have no department, and without a skip phrase the
    // answer "I don't have one" gets written in as the department.
    ask: 'Do you work in a particular department? If not, that is fine.',
    optional: true,
    // Bounded: a department really called "Not-For-Profit Services" reads as a no
    // to the yes/no parser, and without the word cap it gets thrown away.
    skipOn: (said) => P.saysNone(said, { maxWords: 3 }),
    skipValue: 'None',
    validate: (said) => V.validateText(said, { min: 2, max: 60 }),
  },
  {
    key: 'pay_frequency_day',
    label: 'Pay Frequency Day',
    group: 'Employment',
    ask: 'Which day of the week does that land on?',
    reask: 'Which day of the week?',
    // Only a weekly or biweekly schedule has a day of the week.
    appliesWhen: (app) => app.pay_frequency === 'Weekly' || app.pay_frequency === 'Biweekly',
    skipValue: 'N/A',
    validate: (said) => {
      const day = require('./parse').parseWeekday(said);
      return day ? { ok: true, value: day } : { ok: false, error: 'I need a day of the week' };
    },
  },
  {
    key: 'specific_day',
    label: 'Specific Day',
    group: 'Employment',
    ask: 'Which day or days of the month is that?',
    reask: 'Which day of the month?',
    appliesWhen: (app) => app.pay_frequency === 'Semiweekly' || app.pay_frequency === 'Monthly',
    skipValue: 'N/A',
    validate: (said) => {
      const day = require('./parse').parseDayOfMonth(said);
      return day ? { ok: true, value: day } : { ok: false, error: 'I need a day of the month' };
    },
  },
  {
    key: 'employer_address',
    label: 'Employer address',
    group: 'Employment',
    ask: 'What is the address where you work? Street, city and state is enough.',
    reask: 'The work address again.',
    validate: (said) => V.validateText(said, { min: 6, max: 160 }),
  },
  {
    key: 'employer_phone',
    label: 'Employer phone number',
    group: 'Employment',
    ask: 'And a phone number for your employer.',
    reask: 'Let me take that employer phone number again.',
    dtmf: 10,
    validate: (said) => V.validatePhone(said),
  },
];

// The form the email prints, in the brief's own order and wording, which is not
// the order the questions are asked in.
const FORM_ORDER = [
  'name',
  'email',
  'birthday',
  'sms_number',
  'ssn_last_four',
  'routing_number',
  'account_number',
  'account_type',
  'street_1',
  'street_2',
  'city',
  'state',
  'zip',
  'employment_status',
  'employer_name',
  'employer_department',
  'pay_frequency',
  'pay_frequency_day',
  'specific_day',
  'income_over_2000',
  'employer_address',
  'employer_phone',
  'financial_assistance',
  'deployed_military',
];

const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

// Captured on the call but not part of the form the brief listed. Printed under
// their own heading so the brief's 24 lines stay exactly as the brief wrote them.
const EXTRA_ORDER = ['monthly_income', 'bank_name'];

const EXTRA_LABELS = {
  monthly_income: 'Monthly income (captured, dollars)',
  bank_name: 'Bank on file (FedACH)',
};

module.exports = {
  FIELDS,
  FORM_ORDER,
  BY_KEY,
  EXTRA_ORDER,
  EXTRA_LABELS,
  PAY_FREQUENCIES,
  EMPLOYMENT_STATUSES,
};
