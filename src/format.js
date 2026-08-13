// format.js — what comes out of the call.
//
// Two shapes of the same record. The form is the one the brief asked for, label and
// value, one per line, in the brief's own order and wording. The payload is the JSON
// that would be POSTed to an underwriting API, with the decision and the rule codes
// attached so the reason for a decline is a value, not a sentence someone has to read.

const { FORM_ORDER, BY_KEY, EXTRA_ORDER, EXTRA_LABELS } = require('./fields');

function display(key, record) {
  const value = record[key];
  if (value === undefined || value === null || value === '') return '—';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (key === 'monthly_income') return `$${Number(value).toLocaleString('en-US')}`;
  return String(value);
}

function label(key) {
  return BY_KEY[key] ? BY_KEY[key].label : EXTRA_LABELS[key] || key;
}

// Values the call captured that the brief's form has no line for. Kept apart so the
// 24 lines above stay exactly as the brief wrote them.
function extraLines(record) {
  return EXTRA_ORDER.filter((k) => record[k] !== undefined && record[k] !== null).map(
    (k) => `${EXTRA_LABELS[k]}: ${display(k, record)}`,
  );
}

// "Name: Gabriel" lines, in the order the brief listed them.
function formLines(record) {
  return FORM_ORDER.map((key) => `${label(key)}: ${display(key, record)}`);
}

function formText(record) {
  return formLines(record).join('\n\n');
}

// Grouped version, same values, with the section headings the brief implied.
function formTextGrouped(record) {
  const out = [];
  let group = null;
  for (const key of FORM_ORDER) {
    const field = BY_KEY[key];
    if (field.group !== group) {
      group = field.group;
      out.push('', `--- ${group} ---`);
    }
    out.push(`${field.label}: ${display(key, record)}`);
  }
  const extra = extraLines(record);
  if (extra.length) out.push('', '--- Also captured ---', ...extra);
  return out.join('\n').trim();
}

// Lowercase, no accents, no spaces, no punctuation.
function matchKey(name) {
  if (!name) return null;
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function apiPayload(session) {
  const r = session.record;
  const outcome = session.outcome || { decision: 'Incomplete', reasons: [], unresolved: [] };
  return {
    application: {
      applicant: {
        name: r.name ?? null,
        // What a downstream lookup compares on. A name captured by phone differs
        // from the one on file by spacing, hyphens, case and accents far more often
        // than by letters: "Jae Woo", "Jae-Woo" and "Jaewoo" are one applicant. The
        // spoken form is kept exactly as the caller gave it, because that is what
        // the brief asks for and what a person should read; the key beside it is
        // what a match runs on, so nobody normalizes the name in the caller's ear.
        name_match_key: matchKey(r.name),
        email: r.email ?? null,
        birthday: r.birthday ?? null,
        sms_number: r.sms_number ?? null,
        ssn_last_four: r.ssn_last_four ?? null,
      },
      address: {
        street_1: r.street_1 ?? null,
        street_2: r.street_2 || null,
        city: r.city ?? null,
        state: r.state ?? null,
        zip: r.zip ?? null,
      },
      bank_account: {
        routing_number: r.routing_number ?? null,
        account_number: r.account_number ?? null,
        account_type: r.account_type ?? null,
        institution: r.bank_name ?? null,
      },
      employment: {
        status: r.employment_status ?? null,
        employer_name: r.employer_name ?? null,
        employer_department: r.employer_department ?? null,
        employer_address: r.employer_address ?? null,
        employer_phone: r.employer_phone ?? null,
        pay_frequency: r.pay_frequency ?? null,
        pay_frequency_day: r.pay_frequency_day ?? null,
        specific_day: r.specific_day ?? null,
        income_over_2000: r.income_over_2000 ?? null,
        monthly_income_estimate: r.monthly_income ?? null,
      },
      eligibility: {
        financial_assistance: r.financial_assistance ?? null,
        deployed_military: r.deployed_military ?? null,
      },
    },
    decision: {
      outcome: outcome.decision,
      policy_version: outcome.policyVersion || session.policyVersion || null,
      reason_codes: (outcome.reasons || []).map((x) => x.code),
      reasons: (outcome.reasons || []).map((x) => x.reason),
      fields_not_captured: outcome.unresolved || [],
    },
    call: {
      call_sid: session.callSid,
      from: session.from,
      started_at: session.startedAt,
      ended_at: session.endedAt || null,
      turns: session.transcript.length,
    },
    // What each answer cost to get. Not part of the application; part of knowing
    // which question is losing callers.
    capture: session.capture || {},
    capture_metrics: require('./intake').captureMetrics(session),
  };
}

function emailSubject(session) {
  const outcome = session.outcome || {};
  const name = session.record.name || 'Unknown caller';
  return `Loan intake — ${name} — ${outcome.decision || 'Incomplete'}`;
}

function emailText(session) {
  const outcome = session.outcome || { decision: 'Incomplete', reasons: [], unresolved: [] };
  const parts = [];

  parts.push(`DECISION: ${outcome.decision}   (policy ${outcome.policyVersion || 'unversioned'})`);
  if (outcome.reasons && outcome.reasons.length) {
    for (const r of outcome.reasons) parts.push(`  ${r.code} — ${r.reason}`);
  }
  if (outcome.unresolved && outcome.unresolved.length) {
    parts.push(`  Not captured on the call: ${outcome.unresolved.join(', ')}`);
  }
  if (session.record.bank_name) {
    parts.push(`  Routing number matched: ${session.record.bank_name}`);
  }
  parts.push('');
  parts.push(formTextGrouped(session.record));
  parts.push('');
  parts.push('--- API payload ---');
  parts.push(JSON.stringify(apiPayload(session), null, 2));
  parts.push('');
  parts.push(
    'Note: the account and routing numbers are printed here because this email stands in ' +
      'for the API call. In production the email would carry the application id and the ' +
      'numbers would go only to the underwriting endpoint.',
  );
  return parts.join('\n');
}

const COLORS = {
  Approved: '#1a7f37',
  Declined: '#b42318',
  Incomplete: '#8a6d00',
};

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function emailHtml(session) {
  const outcome = session.outcome || { decision: 'Incomplete', reasons: [], unresolved: [] };
  const color = COLORS[outcome.decision] || '#333';
  const heading = (text) =>
    `<tr><td colspan="2" style="padding:16px 0 4px;font:600 12px/1.4 -apple-system,Segoe UI,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#6b7280">${esc(text)}</td></tr>`;
  const row = (k, v) =>
    `<tr>` +
    `<td style="padding:5px 16px 5px 0;font:400 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
    `<td style="padding:5px 0;font:500 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#111827">${esc(v)}</td>` +
    `</tr>`;

  const rows = [];
  let group = null;
  for (const key of FORM_ORDER) {
    const field = BY_KEY[key];
    if (field.group !== group) {
      group = field.group;
      rows.push(heading(group));
    }
    rows.push(row(field.label, display(key, session.record)));
  }
  const extras = EXTRA_ORDER.filter(
    (k) => session.record[k] !== undefined && session.record[k] !== null,
  );
  if (extras.length) {
    rows.push(heading('Also captured'));
    for (const k of extras) rows.push(row(EXTRA_LABELS[k], display(k, session.record)));
  }

  const reasons = (outcome.reasons || [])
    .map((r) => `<div style="font:400 13px/1.6 -apple-system,Segoe UI,sans-serif;color:#374151">${esc(r.code)} — ${esc(r.reason)}</div>`)
    .join('');

  const unresolved =
    outcome.unresolved && outcome.unresolved.length
      ? `<div style="font:400 13px/1.6 -apple-system,Segoe UI,sans-serif;color:#8a6d00">Not captured on the call: ${esc(outcome.unresolved.join(', '))}</div>`
      : '';

  const bank = session.record.bank_name
    ? `<div style="font:400 13px/1.6 -apple-system,Segoe UI,sans-serif;color:#374151">Routing number matched <strong>${esc(session.record.bank_name)}</strong> in the FedACH directory.</div>`
    : '';

  return `<div style="background:#ffffff;padding:24px;max-width:640px">
  <div style="font:600 20px/1.3 -apple-system,Segoe UI,sans-serif;color:#111827">Loan intake — ${esc(session.record.name || 'Unknown caller')}</div>
  <div style="margin:12px 0 4px"><span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${color};color:#fff;font:600 13px/1.4 -apple-system,Segoe UI,sans-serif">${esc(outcome.decision)}</span></div>
  ${reasons}${unresolved}${bank}
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px">${rows.join('')}</table>
  <div style="margin-top:24px;font:600 12px/1.4 -apple-system,Segoe UI,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#6b7280">API payload</div>
  <pre style="background:#f6f7f9;border:1px solid #e5e7eb;border-radius:6px;padding:12px;font:400 12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:#111827;overflow-x:auto;white-space:pre-wrap">${esc(JSON.stringify(apiPayload(session), null, 2))}</pre>
  <div style="margin-top:16px;font:400 12px/1.6 -apple-system,Segoe UI,sans-serif;color:#6b7280">The account and routing numbers are printed here because this email stands in for the API call. In production the email carries the application id and the numbers go only to the underwriting endpoint.</div>
</div>`;
}

module.exports = {
  display,
  label,
  extraLines,
  formLines,
  formText,
  formTextGrouped,
  apiPayload,
  emailSubject,
  emailText,
  emailHtml,
};
