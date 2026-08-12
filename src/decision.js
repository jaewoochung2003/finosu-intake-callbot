// decision.js — the five rules from the brief, and nothing else.
//
// This runs in code, never in the model. The model's job is to hear the caller and
// fill slots; a language model deciding who gets a loan is a model that can be
// talked into it. Every rule below is a pure function of the application record, so
// the same record always produces the same answer and the answer can be replayed
// from the stored JSON without a phone call.
//
// The brief's five:
//   1. the routing number and account number have to be real
//   2. unemployed, or under 2000 dollars a month, is a reject
//   3. deployed military is a reject
//   4. financial assistance is a reject
//   5. a savings account is a reject
//
// Rule 1 is enforced twice on purpose. A field cannot be written unless it
// validates (validate.js), and then it is checked again here, because "the value in
// the record is real" is a property of the record and should not depend on how the
// record was filled.

const V = require('./validate');

// The line the brief draws, in one place. Moving it re-decides every stored
// application that carries an income figure, which is why the figure is stored.
const INCOME_THRESHOLD = 2000;

// Every application, approved or declined, is stamped with the rule set it faced.
// Without it you cannot tell later whether an old decline would still be a decline.
const POLICY_VERSION = '2026-08-11.1';

const RULES = [
  {
    code: 'BANK_ROUTING_INVALID',
    reason: 'Routing number did not verify against the Federal Reserve ACH directory.',
    applies: (app) => {
      const rn = app.routing_number;
      if (!rn) return true;
      if (!/^\d{9}$/.test(rn)) return true;
      if (!V.validPrefix(rn) || !V.abaChecksum(rn)) return true;
      return V.directorySize() > 0 && !V.bankName(rn);
    },
    // Only fires once the field was reached; a call that ended earlier is Incomplete,
    // not Declined.
    needs: ['routing_number'],
  },
  {
    code: 'BANK_ACCOUNT_INVALID',
    reason: 'Account number is not a usable account number.',
    applies: (app) => {
      const an = app.account_number;
      if (!an) return true;
      return !V.validateAccount(an, { routing: app.routing_number }).ok;
    },
    needs: ['account_number'],
  },
  {
    code: 'ACCOUNT_TYPE_SAVINGS',
    reason: 'Deposit account is a savings account. Checking is required.',
    applies: (app) => app.account_type === 'Savings',
    needs: ['account_type'],
  },
  {
    code: 'NOT_EMPLOYED',
    reason: 'Applicant is not employed.',
    applies: (app) => app.employment_status === 'Unemployed',
    needs: ['employment_status'],
  },
  {
    code: 'INCOME_BELOW_2000',
    reason: `Monthly income is not above ${INCOME_THRESHOLD.toLocaleString('en-US')} dollars.`,
    // The figure decides when there is one; the yes/no is the fallback for a caller
    // who would not name a number. Moving the threshold re-decides every stored
    // application that carries a figure, which is the reason for capturing it.
    //
    // The boundary: the brief's field says "over 2000" and its rule says reject
    // "less than 2000", which disagree at exactly 2,000. This follows the field and
    // declines at exactly 2,000. Flip the comparison here to follow the rule.
    applies: (app) =>
      typeof app.monthly_income === 'number'
        ? app.monthly_income <= INCOME_THRESHOLD
        : app.income_over_2000 === false,
    needs: ['income_over_2000'],
  },
  {
    code: 'DEPLOYED_MILITARY',
    reason: 'Applicant is deployed military or a military dependent.',
    applies: (app) => app.deployed_military === true,
    needs: ['deployed_military'],
  },
  {
    code: 'FINANCIAL_ASSISTANCE',
    reason: 'Applicant is receiving government financial assistance.',
    applies: (app) => app.financial_assistance === true,
    needs: ['financial_assistance'],
  },
];

// The five rules that can be settled without the caller reading out anything
// secret. The call asks all five questions, then checks them as a block, then stops
// if any fired. Two things fall out of that order:
//
//   A declined applicant never states a social security number or a bank account,
//   because the block sits ahead of every sensitive field.
//
//   Every declined application carries the same five answers, so one reject can be
//   compared against another. Stopping at the first bad answer would leave a reject
//   row with four holes in it, and four holes in a row that still looks like a row
//   is worse than no row.
const KNOCKOUT_CODES = new Set([
  'ACCOUNT_TYPE_SAVINGS',
  'NOT_EMPLOYED',
  'INCOME_BELOW_2000',
  'DEPLOYED_MILITARY',
  'FINANCIAL_ASSISTANCE',
]);

// The answers the block waits for. income_over_2000 is derived from the figure, so
// it is present whichever way the income question got answered.
const KNOCKOUT_KEYS = [
  'employment_status',
  'income_over_2000',
  'deployed_military',
  'financial_assistance',
  'account_type',
];

// Has every screening question been put to the caller and settled? A field nobody
// could capture counts as settled, otherwise one bad capture keeps the block open
// and the call walks into the sensitive questions.
function screeningSettled(app, unresolved = []) {
  return KNOCKOUT_KEYS.every((k) => app[k] !== undefined || unresolved.includes(k));
}

// Every knockout rule the record trips, not just the first. A caller who is both
// unemployed and on assistance failed for two reasons and the record should say so.
function allKnockouts(app) {
  const fired = [];
  for (const rule of RULES) {
    if (!KNOCKOUT_CODES.has(rule.code)) continue;
    if (rule.needs.every((k) => app[k] !== undefined) && rule.applies(app)) {
      fired.push({ code: rule.code, reason: rule.reason });
    }
  }
  return fired;
}

// Kept for the mid-call check in older callers; returns the first firing rule.
function firstKnockout(app) {
  return allKnockouts(app)[0] || null;
}

// The full decision over a finished record.
//   Declined  — at least one rule fired
//   Approved  — every rule was reachable and none fired
//   Incomplete — the call ended before the rules could all be evaluated
function decide(app, opts = {}) {
  const fired = [];
  const unevaluated = [];

  for (const rule of RULES) {
    const reachable = rule.needs.every((k) => app[k] !== undefined);
    if (!reachable) {
      unevaluated.push(rule.code);
      continue;
    }
    if (rule.applies(app)) fired.push({ code: rule.code, reason: rule.reason });
  }

  if (fired.length) {
    return {
      policyVersion: POLICY_VERSION,
      decision: 'Declined',
      reasons: fired,
      unevaluated,
      // Said to the caller. The brief does not ask the bot to read the rule out and
      // a lender generally does not, so the spoken line stays short and the codes
      // stay in the record.
      spoken:
        'Based on what you have told me, we are not able to move forward with a loan today. ' +
        'You will get an email with the details.',
    };
  }

  if (unevaluated.length) {
    return {
      policyVersion: POLICY_VERSION,
      decision: 'Incomplete',
      reasons: [],
      unevaluated,
      spoken: 'We did not get all the way through the application. Someone will follow up by email.',
    };
  }

  return {
    policyVersion: POLICY_VERSION,
    decision: 'Approved',
    reasons: [],
    unevaluated: [],
    spoken:
      'Everything checks out on my end. Your application is going through for review and ' +
      'you will get an email confirming what I have.',
  };
}

module.exports = {
  RULES,
  KNOCKOUT_CODES,
  KNOCKOUT_KEYS,
  INCOME_THRESHOLD,
  POLICY_VERSION,
  screeningSettled,
  allKnockouts,
  firstKnockout,
  decide,
};
