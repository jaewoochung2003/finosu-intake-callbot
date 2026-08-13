// signalwire-setup.js — provision and configure the phone number over the API.
//
// The sibling of twilio-setup.js. SignalWire's Compatibility API is Twilio's REST
// API with a different host and a different pair of credentials, so the calls below
// are the same calls, and the number it buys answers the same markup.
//
//   node tools/signalwire-setup.js --check              account state, numbers
//   node tools/signalwire-setup.js --search [areacode]  voice-capable numbers for sale
//   node tools/signalwire-setup.js --buy <+1...>        buy one, pointed at WEBHOOK
//   node tools/signalwire-setup.js --webhook <url>      re-point every owned number
//
// Credentials come from .env: SIGNALWIRE_SPACE (the host, e.g. example.signalwire.com),
// SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN. The project id is both the username
// and the account id in the path, exactly as the account SID is at Twilio.

require('../src/env');

const https = require('https');

const SPACE = String(process.env.SIGNALWIRE_SPACE || '')
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');
const PROJECT = process.env.SIGNALWIRE_PROJECT_ID;
const TOKEN = process.env.SIGNALWIRE_API_TOKEN;
const WEBHOOK = process.env.PUBLIC_WEBHOOK_URL;

if (!SPACE || !PROJECT || !TOKEN) {
  console.error('Set SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT_ID and SIGNALWIRE_API_TOKEN in .env');
  console.error('  space is the host from your dashboard URL, e.g. jaewoo.signalwire.com');
  process.exit(1);
}

const host = SPACE.includes('.') ? SPACE : `${SPACE}.signalwire.com`;
const base = `/api/laml/2010-04-01/Accounts/${PROJECT}`;

function api(method, path, form) {
  const body = form ? new URLSearchParams(form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        path,
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${PROJECT}:${TOKEN}`).toString('base64')}`,
          ...(body
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(d) });
          } catch {
            resolve({ status: res.statusCode, data: d });
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function fail(label, res) {
  console.log(`\n  ${label} FAILED (HTTP ${res.status})`);
  const d = res.data || {};
  if (d.message) console.log(`  ${d.code ? `[${d.code}] ` : ''}${d.message}`);
  if (d.more_info) console.log(`  ${d.more_info}`);
  if (!d.message) console.log(`  ${JSON.stringify(d).slice(0, 400)}`);
}

async function check() {
  console.log(`\nSpace\n  ${host}`);

  console.log('\nNumbers already owned');
  const nums = await api('GET', `${base}/IncomingPhoneNumbers.json?PageSize=20`);
  if (nums.status !== 200) return fail('number list', nums);
  const list = nums.data.incoming_phone_numbers || [];
  if (!list.length) console.log('  (none)');
  for (const n of list) {
    console.log(`  ${n.phone_number}`);
    console.log(`     voice url: ${n.voice_url || '(unset)'} [${n.voice_method}]`);
    if (WEBHOOK && n.voice_url !== WEBHOOK) {
      console.log(`     WRONG URL. Fix with: node tools/signalwire-setup.js --webhook`);
    }
  }
}

async function search(areaCode) {
  const q = ['VoiceEnabled=true', 'PageSize=8'];
  if (areaCode) q.push(`AreaCode=${areaCode}`);
  const res = await api('GET', `${base}/AvailablePhoneNumbers/US/Local.json?${q.join('&')}`);
  if (res.status !== 200) return fail('number search', res);
  const list = res.data.available_phone_numbers || [];
  console.log('\nAvailable, voice-capable:');
  for (const n of list) console.log(`  ${n.phone_number}  ${n.locality || ''} ${n.region || ''}`);
  if (!list.length) console.log('  (none returned)');
}

async function buy(arg) {
  if (!WEBHOOK) {
    console.error('PUBLIC_WEBHOOK_URL is not set in .env');
    process.exit(1);
  }
  const pick = String(arg || '').startsWith('+')
    ? { PhoneNumber: arg }
    : { AreaCode: String(arg || '703') };
  const res = await api('POST', `${base}/IncomingPhoneNumbers.json`, {
    ...pick,
    VoiceUrl: WEBHOOK,
    VoiceMethod: 'POST',
    FriendlyName: 'Finosu intake callbot',
  });
  if (res.status !== 201 && res.status !== 200) return fail('purchase', res);
  console.log(`\n  bought ${res.data.phone_number}`);
  console.log(`  voice url: ${res.data.voice_url} [${res.data.voice_method}]`);
  console.log(`\n  Call it: ${res.data.phone_number}`);
}

async function rewebhook(url) {
  const target = url || WEBHOOK;
  if (!target) {
    console.error('give a url or set PUBLIC_WEBHOOK_URL');
    process.exit(1);
  }
  const nums = await api('GET', `${base}/IncomingPhoneNumbers.json?PageSize=20`);
  if (nums.status !== 200) return fail('number list', nums);
  for (const n of nums.data.incoming_phone_numbers || []) {
    const res = await api('POST', `${base}/IncomingPhoneNumbers/${n.sid}.json`, {
      VoiceUrl: target,
      VoiceMethod: 'POST',
    });
    if (res.status !== 200) fail(`update ${n.phone_number}`, res);
    else console.log(`  ${n.phone_number} -> ${target}`);
  }
}

const args = process.argv.slice(2);
const flag = args[0];

(async () => {
  if (flag === '--check') await check();
  else if (flag === '--search') await search(args[1]);
  else if (flag === '--buy') await buy(args[1]);
  else if (flag === '--webhook') await rewebhook(args[1]);
  else console.log('usage: --check | --search [areacode] | --buy <+1...|areacode> | --webhook [url]');
  console.log('');
})();
