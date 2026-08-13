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
  'bi weekly': 'Biweekly',
  'fortnightly': 'Biweekly',
  'fortnight': 'Biweekly',
  'every other monday': 'Biweekly',
  'every other tuesday': 'Biweekly',
  'every other wednesday': 'Biweekly',
  'every other thursday': 'Biweekly',
  'every other friday': 'Biweekly',
  'twice a month': 'Semiweekly',
  'two times a month': 'Semiweekly',
  // Two dates in a month IS twice a month, and it is how most semimonthly payrolls
  // are described. Without these, "the 1st and the 15th of every month" matched the
  // bare option "every month" and was stored as Monthly, which halves the multiplier
  // on a per-paycheck figure and declined a caller earning 2,400.
  '1st and 15th': 'Semiweekly',
  'first and fifteenth': 'Semiweekly',
  '1st and the 15th': 'Semiweekly',
  'first and the fifteenth': 'Semiweekly',
  '15th and 30th': 'Semiweekly',
  'fifteenth and thirtieth': 'Semiweekly',
  '15th and the 30th': 'Semiweekly',
  'fifteenth and the thirtieth': 'Semiweekly',
  '15th and the last': 'Semiweekly',
  'fifteenth and the last': 'Semiweekly',
  'middle and end of the month': 'Semiweekly',
  'twice per month': 'Semiweekly',
  'twice monthly': 'Semiweekly',
  'semi monthly': 'Semiweekly',
  'semimonthly': 'Semiweekly',
  'semi weekly': 'Semiweekly',
  // "twice a week" is not one of the brief's four cadences and is not semimonthly;
  // folding it into Semiweekly converted a twice-weekly paycheck at half the real
  // rate. Left out so it re-asks instead of banking a wrong frequency.
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
  // Every negative answer this question accepts is listed here by hand. parseEnum
  // reads the table before it refuses negatives, so these land and anything else
  // carrying a "not" is re-asked with the five choices named.
  'not working': 'Unemployed',
  'not employed': 'Unemployed',
  'no longer employed': 'Unemployed',
  'not currently employed': 'Unemployed',
  'dont have a job': 'Unemployed',
  'do not have a job': 'Unemployed',
  'dont work': 'Unemployed',
  'do not work': 'Unemployed',
  'out of work': 'Unemployed',
  'unemployment': 'Unemployed',
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
    key: 'first_name',
    label: 'First Name',
    group: 'Applicant',
    ask: 'Can I start with your first name?',
    reask: 'Your first name one more time?',
    validate: (said) => V.validateNamePart(said, 'first'),
  },
  {
    key: 'last_name',
    label: 'Last Name',
    group: 'Applicant',
    ask: 'And your last name?',
    reask: 'And the last name once more?',
    // Asked in two parts, confirmed as one. Two parts because a bot that ever says
    // the caller's name has to know which half is the first name, and because a
    // caller who gives a surname first ("Chung Jaewoo") puts a backwards name on the
    // form with nothing to catch it. Confirmed once because two read-backs for one
    // name is a call nobody wants to be on.
    //
    // Spelled as one run, no pause between the parts: a wrong letter is audible,
    // a stray space is not, and spacing is not worth a correction because nothing
    // downstream compares on it.
    confirm: true,
    confirmLine: (v, app) => {
      const whole = [app.first_name, v].filter(Boolean).join(' ');
      return `Okay, ${whole}. That's ${V.spellWords(whole)}.`;
    },
    confirmCovers: ['first_name', 'last_name'],
    respell: 'No problem. Spell your first name for me.',
    // Any words at all are a valid name, so an answer to this field's read-back
    // cannot be read as a new name unless the caller marked it as a correction.
    // "Is that right?" is a closed question; taking an open answer to it as data is
    // what let "that's right", "bingo" and "aye" replace the surname while the call
    // carried on and still ended Approved. Every other confirmed field has a shape
    // that conversation cannot accidentally satisfy — an email needs an at sign, the
    // bank numbers need nine and eight digits — so a bare correction still lands
    // there and only this one needs the cue.
    anyWordsValidate: true,
    // The brief's form has one Name line, so the two answers are joined the moment
    // the second one lands.
    // A half the caller never managed to give leaves the other half standing; the
    // form prints what there is rather than the word "undefined".
    derive: (v, app) => ({ name: [app.first_name, v].filter(Boolean).join(' ') }),
    validate: (said) => V.validateNamePart(said, 'last'),
  },
  {
    key: 'email',
    label: 'Email',
    group: 'Applicant',
    ask: "What's the best email address to send the decision to?",
    reask: 'That email one more time?',
    confirm: true,
    confirmLine: (v) => `So that's ${V.spellEmail(v)}.`,
    // Ask for the whole address, because that is what the validator accepts. The old
    // version asked only for "the part before the at sign", and then rejected exactly
    // that for having no domain, so a caller who did what he was told was told it was
    // not an email address. Nothing here needs to spell out that an address has a
    // domain on the end; asking for the address asks for all of it.
    respell: 'No problem. Spell out the whole address for me, one letter at a time.',
    validate: (said) => V.validateEmail(said),
  },
  {
    key: 'birthday',
    label: 'Birthday',
    group: 'Applicant',
    // One complete date per turn, and the question says which order. The old version
    // took whatever arrived and asked for the missing piece, which meant an attempt
    // depended on the one before it and nothing carried between them: "June 28th" was
    // answered with "what year?", the year came back mis-transcribed as "To", that was
    // read as a year on its own, and the bot asked for the month and day it had
    // already been given. Three turns in and it gave up on a date the caller had said
    // correctly twice. Each attempt stands alone now, so a bad turn costs one turn.
    ask: "And your date of birth? Give me the month, day and year, like March fourth nineteen ninety.",
    reask: 'The whole date this time, month, day and year.',
    // Eight digits on the keypad is the escape for a bad line: 06281990.
    dtmf: 8,
    validate: (said) => V.validateDob(said),
  },
  {
    key: 'sms_number',
    label: 'Number for SMS if different',
    group: 'Applicant',
    ask: "Do you want texts going to a different number? If this one's fine, just say no.",
    optional: true,
    skipOn: P.saysNone,
    skipValue: 'Same as calling number',
    dtmf: 10,
    validate: (said) =>
      V.bareYesNeedsValue(said, "Sure. What's the number for texts?") || V.validatePhone(said),
  },

  // --- the five knockouts ---------------------------------------------------
  {
    key: 'employment_status',
    label: 'Employment Status',
    group: 'Employment',
    ask: "What's your work situation right now?",
    reask: 'Working, self-employed, unemployed, retired, or a student?',
    knockout: true,
    // Someone out of work has no salary and no employer, so the pay, income and
    // employer questions below skip on this value (appliesWhen on each). The two
    // income slots the decision needs are filled here instead of asked: no wages is a
    // monthly income of 0, which is under the line, so the record shows both
    // NOT_EMPLOYED and INCOME_BELOW_2000 without ever asking an out-of-work caller
    // how much they earn. Retired and Student still get asked — a pension or a
    // part-time job can clear the line.
    derive: (v) => (v === 'Unemployed' ? { monthly_income: 0, income_over_2000: false } : {}),
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
    // Not asked of someone who just said they are unemployed; skipped to N/A.
    appliesWhen: (app) => app.employment_status !== 'Unemployed',
    // A student or anyone with no regular pay cycle has no answer among the four, and
    // without this they looped on the question. "Never"/"irregular"/"it varies" is a
    // real answer: mark it N/A, skip the pay-day question, and read income as a plain
    // monthly figure (frequencyMultiplier falls back to 1).
    optional: true,
    skipOn: (said) =>
      /\b(never|no regular|irregular|it varies|varies|dont get paid|do not get paid|no pay|nothing regular|whenever|not regularly|no set|no schedule)\b/i.test(
        String(said),
      ),
    skipValue: 'N/A',
    validate: (said) => V.validateEnum(said, PAY_FREQUENCIES, PAY_FREQUENCY_SYNONYMS),
  },
  // The pay-day question sits with the pay questions, straight after the cadence that
  // decides which of the two applies. It used to live in the employer block, where it
  // followed "are you in a particular department?" and asked "which day does that land
  // on?" with nothing in earshot for "that" to mean; a caller stopped and asked what it
  // was about. The printed form is unaffected: FORM_ORDER owns the brief's order
  // separately from the order the questions are asked in.
  {
    key: 'pay_frequency_day',
    label: 'Pay Frequency Day',
    group: 'Employment',
    ask: 'And which day of the week does that land on?',
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
    ask: 'And which day or days of the month is that?',
    reask: 'Which day of the month?',
    appliesWhen: (app) => app.pay_frequency === 'Semiweekly' || app.pay_frequency === 'Monthly',
    skipValue: 'N/A',
    validate: (said) => {
      const day = require('./parse').parseDayOfMonth(said);
      return day ? { ok: true, value: day } : { ok: false, error: 'I need a day of the month' };
    },
  },
  {
    key: 'monthly_income',
    label: 'Monthly income',
    group: 'Employment',
    // The offer to work it out from one paycheck is gone from the question. The
    // parser still understands "twelve hundred a paycheck" if a caller volunteers it,
    // because they do, but offering it made the question two questions long and gave
    // the caller a choice to make before answering.
    ask: 'And roughly how much do you bring in a month?',
    reask: 'A rough dollar figure is all I need.',
    knockout: true,
    // Skipped for the unemployed: employment_status already set this to 0. No skipValue,
    // so advance() leaves that 0 in place rather than overwriting it.
    appliesWhen: (app) => app.employment_status !== 'Unemployed',
    // The boolean the brief asks for is derived here rather than asked, so the
    // record keeps the number. Move the threshold and this follows it.
    //
    // `>=`, not `>`, so the boolean says the same thing the decision says. The brief's
    // field ("over 2000") and its reject rule ("less than 2000") disagree at exactly
    // 2,000, and decision.js follows the rule and approves there. With a bare `>` the
    // form printed "If salary is over 2000 dollars a month: No" three lines above an
    // Approved decision on the same page, which reads as a bug in the form whichever
    // way the boundary is meant to go. This is the boolean the decision's own fallback
    // reads, so it means "clears the income rule".
    derive: (monthly) => ({ income_over_2000: monthly >= INCOME_THRESHOLD }),
    validate: (said, app) => V.validateMonthlyIncome(said, app.pay_frequency),
  },
  {
    // Only asked when three tries at a figure produced nothing. A caller who will
    // not name a number can still answer the threshold question.
    key: 'income_over_2000',
    label: 'If salary is over 2000 dollars a month',
    group: 'Employment',
    ask: 'Let me ask it another way. Is it more than two thousand a month?',
    reask: 'Yes or no, is it over two thousand a month?',
    knockout: true,
    appliesWhen: (app) => app.income_over_2000 === undefined,
    validate: (said, app) => V.validateIncomeOver(said, INCOME_THRESHOLD, app.pay_frequency),
  },
  {
    key: 'deployed_military',
    label: 'If I am deployed military',
    group: 'Eligibility',
    ask: 'Are you active duty military on deployment right now, or a dependent of someone who is?',
    // The re-ask has to carry the dependent half too. Shortened to "are you deployed
    // right now?", it asked a narrower question than the rule covers, so a spouse of
    // a deployed servicemember answered no truthfully and was approved against a
    // reject rule that names them.
    reask: 'Yes or no: are you deployed right now, or is your spouse or parent?',
    knockout: true,
    validate: (said) => V.validateDeployed(said),
  },
  {
    key: 'financial_assistance',
    label: 'If I am on financial assistance',
    group: 'Eligibility',
    ask: 'Are you getting any government financial assistance right now?',
    reask: 'Yes or no, any government assistance?',
    knockout: true,
    validate: (said) => V.validateYesNo(said),
  },
  {
    key: 'account_type',
    label: 'Checking/Savings',
    group: 'Bank Account',
    ask: 'Is this going into a checking account or a savings account?',
    reask: 'Checking or savings?',
    knockout: true,
    validate: (said) =>
      V.validateEnum(said, ['Checking', 'Savings'], {
        'check in': 'Checking',
        'chequing': 'Checking',
        // Credit-union and business terms. "Share draft" is the credit-union word for
        // checking; without it the only CU term understood was "share savings", the
        // one that declines. A bare "business account" is overwhelmingly checking.
        'share draft': 'Checking',
        'draft account': 'Checking',
        'business account': 'Checking',
        'business checking': 'Checking',
        'commercial checking': 'Checking',
        'share savings': 'Savings',
        'share account': 'Savings',
        'saving': 'Savings',
      }),
  },

  // --- the sensitive block, only reached by an applicant still in play ------
  {
    key: 'ssn_last_four',
    label: 'Last Four of Social',
    group: 'Applicant',
    ask: 'Type the last four digits of your social security number on your keypad.',
    reask: 'Type those four digits on the keypad.',
    askSpoken: 'What are the last four digits of your social security number?',
    reaskSpoken: 'The last four digits again.',
    keypadOnly: true,
    dtmf: 4,
    sensitive: true,
    // Read back like the two bank numbers are.
    //
    // It was the one number on the call that went onto the form with nothing said
    // about it: four digits heard down a phone line, no check digit, no directory,
    // and the caller had no idea what had been written down. Four digits is also the
    // shortest read-back on the call, so it costs almost nothing.
    confirm: true,
    confirmLine: (v) => `Okay, ${V.spellDigits(v)}.`,
    respell: 'Let me take those four digits again.',
    validate: (said) => V.validateSsn4(said),
  },
  {
    key: 'routing_number',
    label: 'Routing Number',
    group: 'Bank Account',
    ask: 'Type the nine digit routing number on your keypad.',
    reask: 'Type the nine digits again.',
    askSpoken: "What's your nine digit routing number?",
    reaskSpoken: 'The nine digits again.',
    keypadOnly: true,
    dtmf: 9,
    sensitive: true,
    // Digit by digit, and with the bank named. The check digit and the Fed
    // directory catch a number that was never issued; neither catches a real
    // routing number belonging to the wrong bank, and hearing "that is Chase" when
    // you bank at Wells Fargo does.
    confirm: true,
    confirmLine: (v, app) =>
      `Okay, ${V.spellDigits(v)}${app && app.bank_name ? `. That's ${app.bank_name.replace(/\s*\([A-Z]{2}\)\s*$/, '')}` : ''}.`,
    respell: 'Let me take that routing number again, one digit at a time.',
    validate: (said) => V.validateRouting(said),
  },
  {
    key: 'account_number',
    label: 'Account Number',
    group: 'Bank Account',
    // The only digit field with no fixed length, so nothing but the caller can say
    // where it ends. Saying so is what makes the pound key useful; without it a
    // caller typing a long number pauses, the idle timer ends the entry early, and
    // the half they typed is a valid length for an account number.
    ask: 'Type the account number on your keypad, then press pound.',
    reask: 'Type the account number again, then press pound.',
    askSpoken: "What's your account number?",
    reaskSpoken: 'The account number again.',
    keypadOnly: true,
    dtmf: 17,
    sensitive: true,
    // An account number has no check digit and no directory. Nothing but the caller
    // can tell a real one from a plausible one, so the caller is asked.
    confirm: true,
    confirmLine: (v) => `And that's ${V.spellDigits(v)}.`,
    respell: 'Let me take that account number again, one digit at a time.',
    validate: (said, app) =>
      V.validateAccount(said, { routing: app.routing_number, ssn4: app.ssn_last_four }),
  },

  // --- address --------------------------------------------------------------
  {
    key: 'street_1',
    label: 'Street Address 1',
    group: 'Address',
    ask: "What's your street address?",
    reask: 'The street address again.',
    validate: (said) => V.validateText(said, { min: 4 }),
  },
  {
    key: 'street_2',
    label: 'Street Address 2',
    group: 'Address',
    ask: 'Any apartment or unit number?',
    optional: true,
    skipOn: (said) => P.saysNone(said, { maxWords: 3 }),
    skipValue: '',
    validate: (said) =>
      V.bareYesNeedsValue(said, "What's the apartment or unit number?") ||
      V.validateText(said, { min: 1 }),
  },
  {
    key: 'city',
    label: 'City',
    group: 'Address',
    ask: 'And the city?',
    validate: (said) => V.validateText(said, { min: 2, max: 60 }),
  },
  {
    key: 'state',
    label: 'State',
    group: 'Address',
    ask: 'And the state?',
    validate: (said) => V.validateState(said),
  },
  {
    key: 'zip',
    label: 'Zip Code',
    group: 'Address',
    ask: 'Type your five digit zip code on the keypad.',
    reask: 'Type the five digits again.',
    askSpoken: "And the zip code?",
    reaskSpoken: 'The five digits again.',
    keypadOnly: true,
    dtmf: 5,
    validate: (said) => V.validateZip(said),
  },

  // --- employer -------------------------------------------------------------
  {
    key: 'employer_name',
    label: 'Employer Name',
    group: 'Employment',
    ask: 'Who do you work for?',
    // An out-of-work caller has no employer; skip the whole employer block to N/A.
    appliesWhen: (app) => app.employment_status !== 'Unemployed',
    skipValue: 'N/A',
    validate: (said) => V.validateText(said, { min: 2, max: 80 }),
  },
  {
    key: 'employer_department',
    label: 'Employer Department',
    group: 'Employment',
    // Plenty of hourly jobs have no department, and without a skip phrase the
    // answer "I don't have one" gets written in as the department.
    ask: 'Are you in a particular department? If not, no problem.',
    appliesWhen: (app) => app.employment_status !== 'Unemployed',
    optional: true,
    // Bounded: a department really called "Not-For-Profit Services" reads as a no
    // to the yes/no parser, and without the word cap it gets thrown away.
    skipOn: (said) => P.saysNone(said, { maxWords: 3 }),
    skipValue: 'None',
    validate: (said) =>
      V.bareYesNeedsValue(said, 'Which department?') || V.validateText(said, { min: 2, max: 60 }),
  },
  {
    key: 'employer_address',
    label: 'Employer address',
    group: 'Employment',
    ask: "What's the address where you work? Street, city and state is plenty.",
    reask: 'The work address one more time?',
    appliesWhen: (app) => app.employment_status !== 'Unemployed',
    skipValue: 'N/A',
    validate: (said) => V.validateText(said, { min: 6, max: 160 }),
  },
  {
    key: 'employer_phone',
    label: 'Employer phone number',
    group: 'Employment',
    ask: 'And a phone number for your employer, if they have one.',
    reask: 'That phone number one more time?',
    dtmf: 10,
    appliesWhen: (app) => app.employment_status !== 'Unemployed',
    // A freelancer's client or a one-person shop has no phone line, and a caller
    // saying so was re-asked three times for a number that does not exist. Same
    // skip the department question has.
    optional: true,
    skipOn: (said) => P.saysNone(said, { maxWords: 8 }),
    skipValue: 'None',
    validate: (said) =>
      V.bareYesNeedsValue(said, "What's the number there?") || V.validatePhone(said),
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

// `name` is not asked; it is the two answers joined. The form the brief specified
// has one line for it, and this is the entry that prints that line.
const FORM_ONLY = {
  name: { key: 'name', label: 'Name', group: 'Applicant' },
};

// ---------- the keypad, on or off ----------
//
// Off by default. The keypad is the accurate way to give a routing number and it is
// still here, but it costs the one thing that matters more: a call that finishes.
// Touch tones and a speech model share a turn badly — the model hears the tones and
// writes them down, and every line the server sends has to be arranged around an
// entry that may be half typed. With it off there is one way in and nothing to
// arrange around.
//
// KEYPAD=on in .env puts it back. Nothing is deleted; the questions change and the
// digit lengths move from `dtmf` (which bridge.js reads as "this question takes
// touch tones") to `digits` (which intake reads as "this many digits are expected,
// however they arrive").
const KEYPAD_ON = /^(1|on|true|yes)$/i.test(String(process.env.KEYPAD || 'off'));

if (!KEYPAD_ON) {
  for (const f of FIELDS) {
    // A fixed-length number read out loud arrives in pieces. Somebody reading nine
    // digits off a cheque pauses between the groups, the turn detector ends the turn
    // in the gap, and three digits reach a validator that wants nine. With the keypad
    // there this failed into "type it instead"; without it, it is the end of the call.
    // The exact length is what makes the pieces addable, so it is recorded here and
    // intake keeps a running total against it.
    //
    // Not the account number: four to seventeen digits is a range, so there is no
    // length to count toward. It is read back to the caller instead, which is the
    // check that a partial one fails.
    // Only the questions that were keypad-only. The date of birth and the text
    // number take digits as an escape hatch but are normally answered in words, and
    // counting toward a length there broke the ordinary answer: "3 4 94" is a whole
    // date, four digits long, and it started waiting for four more.
    if (f.keypadOnly && f.dtmf && f.key !== 'account_number') f.digitsExact = f.dtmf;
    delete f.dtmf;
    if (f.keypadOnly) {
      delete f.keypadOnly;
      if (f.askSpoken) f.ask = f.askSpoken;
      if (f.reaskSpoken) f.reask = f.reaskSpoken;
    }
  }
}

const BY_KEY = { ...Object.fromEntries(FIELDS.map((f) => [f.key, f])), ...FORM_ONLY };

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
