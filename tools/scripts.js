// scripts.js — canned calls.
//
// Each `turns` array is what a caller says, in the order the bot asks. They run
// through the real intake code, so they are both the demo and the end-to-end test
// (test/intake.test.js asserts the `expect` value on every one of them).
//
// Answers are written the way people actually talk: spoken digits, a month name and
// an ordinal for a date, "every other week" for a pay cycle. Nothing here is
// pre-parsed, because parsing is the part being tested.

// The name and the email address are read back and confirmed, so a real call has a
// turn for each of those answers. They are turns like any other: a caller who says
// "no" to one of them is a case worth scripting.
const APPROVED = [
  'Gabriel',                                      //  0 First name
  'Kim',                                          //  1 Last name
  'yes',                                          //  2 Name read back, confirmed
  'gabriel at finosu dot com',                    //  3 Email
  'yes',                                          //  4 Email read back, confirmed
  'March fourth nineteen ninety four',            //  5 Birthday
  'no this number is fine',                       //  6 SMS number
  'I work full time',                             //  7 Employment status
  'every other week',                             //  8 Pay frequency
  'about thirty two hundred a month',             //  9 Monthly income
  'no',                                           // 10 Deployed military
  'no',                                           // 11 Financial assistance
  'checking',                                     // 12 Checking / savings
  'four eight two one',                           // 13 Last four of social
  'zero two one zero zero zero zero two one',     // 14 Routing number (JPMorgan Chase)
  'yes',                                          // 15 Routing read back, confirmed
  'five five one two three four zero nine eight seven', // 16 Account number
  'yes',                                          // 17 Account read back, confirmed
  '1820 Gateway Drive',                           // 18 Street 1
  'no',                                           // 19 Street 2
  'San Mateo',                                    // 20 City
  'California',                                   // 21 State
  'nine four four zero four',                     // 22 Zip
  'Finosu',                                       // 23 Employer
  'Engineering',                                  // 24 Department
  'Friday',                                       // 25 Pay day of the week
  '1820 Gateway Drive, San Mateo, California',    // 26 Employer address
  'six five zero eight six two nine one one zero', // 27 Employer phone
];

const I = {
  first_name: 0,
  last_name: 1,
  name_confirm: 2,
  email: 3,
  email_confirm: 4,
  birthday: 5,
  sms: 6,
  employment: 7,
  pay_frequency: 8,
  income: 9,
  military: 10,
  assistance: 11,
  account_type: 12,
  ssn: 13,
  routing: 14,
  routing_confirm: 15,
  account: 16,
  account_confirm: 17,
  department: 24,
  pay_day: 25,
};

// Replace the answer at `index` with one or more answers, leaving the rest alone.
// Removing exactly one turn and inserting N matters: an earlier version removed N
// and inserted N, which silently deleted the following question's answer and let a
// broken script still land on the expected decision.
function variant(index, ...replacements) {
  const turns = APPROVED.slice();
  turns.splice(index, 1, ...replacements);
  return turns;
}

function patch(map) {
  return APPROVED.slice().map((turn, i) => (i in map ? map[i] : turn));
}

// Exported so tests address turns by name. Hardcoded turn numbers broke silently
// the first time a question moved.
module.exports = {
  INDEX: I,
  APPROVED,

  approved: {
    about: 'clean application, everything checks out',
    expect: 'Approved',
    turns: APPROVED,
  },

  savings: {
    about: 'savings account instead of checking',
    expect: 'Declined',
    turns: variant(I.account_type, 'savings'),
  },

  unemployed: {
    about: 'not working',
    expect: 'Declined',
    turns: variant(I.employment, "I'm between jobs right now"),
  },

  'low-income': {
    about: 'brings in eleven hundred a month',
    expect: 'Declined',
    turns: variant(I.income, 'about eleven hundred a month'),
  },

  'low-income-weekly': {
    about: 'four hundred a week, which is under the line once converted',
    expect: 'Declined',
    turns: variant(I.income, 'about four hundred dollars a week'),
  },

  'income-per-paycheck': {
    about: 'answers per paycheck on a biweekly cycle, which clears the line',
    expect: 'Approved',
    // 1,200 every two weeks is 2,600 a month. Read as 1,200 a month it is a decline,
    // which is what happened before the pay cycle was asked first.
    turns: variant(I.income, 'about twelve hundred a paycheck'),
  },

  'income-compound': {
    about: 'says twenty four fifty, meaning 2,450',
    expect: 'Approved',
    turns: variant(I.income, 'twenty four fifty'),
  },

  'income-refused': {
    about: 'will not name a figure, so the yes/no backstop is asked',
    expect: 'Approved',
    turns: variant(
      I.income,
      'I would rather not say',
      'I really do not want to give a number',
      'I prefer not to say',
      'yes it is over that', // the backstop question
    ),
  },

  military: {
    about: 'deployed active duty',
    expect: 'Declined',
    turns: variant(I.military, 'yes I am, I deploy next month'),
  },

  assistance: {
    about: 'on government assistance',
    expect: 'Declined',
    turns: variant(I.assistance, 'yeah I get SNAP'),
  },

  'assistance-refused': {
    about: 'will not answer the assistance question, so it is asked again',
    expect: 'Approved',
    // A refusal is not a no. Recorded as one it would settle a reject rule from an
    // answer the caller never gave.
    turns: variant(I.assistance, 'I prefer not to say', 'no comment', 'no'),
  },

  'multi-reject': {
    about: 'unemployed, under the income line, and on assistance',
    expect: 'Declined',
    turns: patch({
      [I.employment]: 'I am not working at the moment',
      [I.income]: 'about six hundred a month',
      [I.assistance]: 'yes, I get food stamps',
    }),
  },

  'fake-routing': {
    about: 'routing number passes the check digit but is not a real one',
    expect: 'Approved',
    // 310000185 is arithmetically a valid ABA number and is not in the FedACH
    // directory, so it is refused and the caller reads the real one instead. The
    // application still ends up Approved, which is the point: the bad number never
    // reaches the record.
    turns: variant(
      I.routing,
      'three one zero zero zero zero one eight five',
      'zero two one zero zero zero zero two one',
    ),
  },

  'bad-checksum': {
    about: 'made-up routing number that fails the check digit',
    expect: 'Approved',
    turns: variant(
      I.routing,
      'one two three four five six seven eight nine',
      'zero two one zero zero zero zero two one',
    ),
  },

  'no-department': {
    about: 'hourly worker with no department',
    expect: 'Approved',
    turns: variant(I.department, "I don't have one"),
  },

  'awkward-department': {
    about: 'a real department whose name reads as a negative',
    expect: 'Approved',
    turns: variant(I.department, 'Not-For-Profit Services'),
  },

  'messy-digits': {
    about: 'digits read in pairs and with doubles, an email said out loud',
    expect: 'Approved',
    turns: patch({
      [I.email]: 'uh, j dot chung two zero zero three at gmail dot com',
      [I.birthday]: 'the fourth of March, nineteen ninety four',
      [I.sms]: 'yes, seven zero three five five five zero one four two',
      [I.income]: 'thirty two hundred',
      [I.ssn]: 'double four two one',
    }),
  },

  'monthly-payroll': {
    about: 'paid monthly, so the day-of-month question is asked instead',
    expect: 'Approved',
    turns: patch({
      [I.pay_frequency]: 'once a month',
      [I.pay_day]: 'the first and the fifteenth',
    }),
  },

  'under-18': {
    about: 'applicant is sixteen',
    expect: 'Declined',
    turns: variant(I.birthday, 'June third two thousand nine'),
  },

  // A second persona, so two test emails are tellable apart at a glance. Different
  // name shape (hyphenated), bank, address, weekly income, and a second address line.
  'maria': {
    about: 'clean application under a different persona: hyphenated name, weekly pay, Bank of America',
    expect: 'Approved',
    turns: [
      'Maria',                                        //  0 First name
      'Alvarez dash Cruz',                            //  1 Last name
      'yes',                                          //  2 Name read back, confirmed
      'maria dot alvarez at yahoo dot com',           //  3 Email
      'yes',                                          //  4 Email read back, confirmed
      'July twelfth nineteen eighty eight',           //  5 Birthday
      'no this number is fine',                       //  6 SMS number
      'yes I work full time',                         //  7 Employment status
      'every week',                                   //  8 Pay frequency
      'five hundred fifty a week',                    //  9 Income (2,383 a month, clears the line)
      'no',                                           // 10 Deployed military
      'no',                                           // 11 Financial assistance
      'checking',                                     // 12 Checking / savings
      'seven seven three two',                        // 13 Last four of social
      'zero two six zero zero nine five nine three',  // 14 Routing (Bank of America)
      'yes',                                          // 15 Routing read back, confirmed
      'nine eight one two two seven zero four five six', // 16 Account number
      'yes',                                          // 17 Account read back, confirmed
      '412 Cedar Court',                              // 18 Street 1
      'apartment two',                                // 19 Street 2
      'Falls Church',                                 // 20 City
      'Virginia',                                     // 21 State
      'two two zero four six',                        // 22 Zip
      'Inova Health',                                 // 23 Employer
      'Billing',                                      // 24 Department
      'Thursday',                                     // 25 Pay day of the week
      '8110 Gatehouse Road, Falls Church, Virginia',  // 26 Employer address
      'seven zero three seven seven six zero one zero zero', // 27 Employer phone
    ],
  },
};
