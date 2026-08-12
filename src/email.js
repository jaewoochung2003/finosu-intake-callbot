// email.js — send the finished application to the underwriting inbox.
//
// Gmail API over a stored OAuth refresh token, no dependencies. Credentials come
// from the environment (see .env.example); nothing secret is written in this file,
// because this directory gets zipped and sent to someone.
//
// Two send paths, tried in order, because a token minted for gmail.modify can
// create a draft but not always post to messages.send:
//   1. users.messages.send
//   2. users.drafts.create then users.drafts.send
// If both are refused the draft is left in place and the caller is told, so the
// application is never lost just because a scope was short.

const https = require('https');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function accessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN not set');
  }
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }).toString();
  const res = await request(
    {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
    body,
  );
  if (res.status !== 200) throw new Error(`token refresh failed: ${JSON.stringify(res.data)}`);
  return res.data.access_token;
}

function api(token, path, method, payload) {
  const body = payload ? JSON.stringify(payload) : null;
  return request(
    {
      hostname: 'gmail.googleapis.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    },
    body,
  );
}

// RFC 2045 encoded-word, so a subject with a name in it survives.
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function buildMime({ to, subject, text, html }) {
  const boundary = `b${Buffer.from(String(process.hrtime.bigint())).toString('hex').slice(0, 20)}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${boundary}--`,
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendEmail({ to, subject, text, html }) {
  const token = await accessToken();
  const raw = buildMime({ to, subject, text, html });

  const direct = await api(token, '/gmail/v1/users/me/messages/send', 'POST', { raw });
  if (direct.status === 200) return { sent: true, via: 'messages.send', id: direct.data.id };

  const draft = await api(token, '/gmail/v1/users/me/drafts', 'POST', { message: { raw } });
  if (draft.status !== 200) {
    throw new Error(
      `send failed (${direct.status} ${JSON.stringify(direct.data)}) and draft failed (${draft.status} ${JSON.stringify(draft.data)})`,
    );
  }

  const sent = await api(token, '/gmail/v1/users/me/drafts/send', 'POST', { id: draft.data.id });
  if (sent.status === 200) return { sent: true, via: 'drafts.send', id: sent.data.id };

  return {
    sent: false,
    via: 'drafts.create',
    draftId: draft.data.id,
    error: `left as a draft; sending was refused: ${JSON.stringify(sent.data)}`,
  };
}

module.exports = { sendEmail, buildMime };
