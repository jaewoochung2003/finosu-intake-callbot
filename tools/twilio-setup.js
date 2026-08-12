// twilio-setup.js — provision and configure the phone number over the API.
//
// The console is a maze and its layout changes; the REST API does not. This does
// the three things the console was supposed to do, and when Twilio refuses it says
// exactly why instead of bouncing to a dashboard.
//
//   node tools/twilio-setup.js --check              account state, numbers, verified caller IDs
//   node tools/twilio-setup.js --search [areacode]  voice-capable local numbers for sale
//   node tools/twilio-setup.js --buy <+1...>        buy one, pointed at WEBHOOK
//   node tools/twilio-setup.js --webhook <url>      re-point every owned number
//
// Credentials come from .env: TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID,
// TWILIO_API_KEY_SECRET. An API key pair authenticates as Basic user:password;
// the account SID stays in the URL path.

require('../src/env');

const https = require('https');

const ACCOUNT = process.env.TWILIO_ACCOUNT_SID;
const KEY = process.env.TWILIO_API_KEY_SID;
const SECRET = process.env.TWILIO_API_KEY_SECRET;
const WEBHOOK = process.env.PUBLIC_WEBHOOK_URL;

if (!ACCOUNT || !KEY || !SECRET) {
  console.error('Set TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET in .env');
  process.exit(1);
}

function api(method, path, form) {
  const body = form ? new URLSearchParams(form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.twilio.com',
        path,
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}`,
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

const base = `/2010-04-01/Accounts/${ACCOUNT}`;

function fail(label, res) {
  console.log(`\n  ${label} FAILED (HTTP ${res.status})`);
  const d = res.data || {};
  if (d.message) console.log(`  ${d.code ? `[${d.code}] ` : ''}${d.message}`);
  if (d.more_info) console.log(`  ${d.more_info}`);
  if (!d.message) console.log(`  ${JSON.stringify(d).slice(0, 400)}`);
}

async function check() {
  console.log('\nAccount');
  const acct = await api('GET', `${base}.json`);
  if (acct.status !== 200) return fail('account lookup', acct);
  console.log(`  ${acct.data.friendly_name}`);
  console.log(`  type:   ${acct.data.type}`); // "Trial" or "Full"
  console.log(`  status: ${acct.data.status}`);

  console.log('\nNumbers already owned');
  const nums = await api('GET', `${base}/IncomingPhoneNumbers.json?PageSize=20`);
  if (nums.status !== 200) return fail('number list', nums);
  if (!nums.data.incoming_phone_numbers.length) console.log('  (none)');
  for (const n of nums.data.incoming_phone_numbers) {
    console.log(`  ${n.phone_number}  voice=${n.capabilities.voice}`);
    console.log(`     voice url: ${n.voice_url || '(unset)'} [${n.voice_method}]`);
  }

  console.log('\nVerified caller IDs (who may call a trial number)');
  const cids = await api('GET', `${base}/OutgoingCallerIds.json?PageSize=20`);
  if (cids.status !== 200) return fail('caller id list', cids);
  if (!cids.data.outgoing_caller_ids.length) console.log('  (none)');
  for (const c of cids.data.outgoing_caller_ids) {
    console.log(`  ${c.phone_number}  ${c.friendly_name}`);
  }

  if (acct.data.type === 'Trial') {
    console.log('\n  Trial account: only the numbers listed above can call in.');
  }
}

async function search(areaCode) {
  const q = ['VoiceEnabled=true', 'PageSize=8'];
  if (areaCode) q.push(`AreaCode=${areaCode}`);
  const res = await api('GET', `${base}/AvailablePhoneNumbers/US/Local.json?${q.join('&')}`);
  if (res.status !== 200) return fail('number search', res);
  console.log('\nAvailable, voice-capable:');
  for (const n of res.data.available_phone_numbers) {
    console.log(`  ${n.phone_number}  ${n.locality || ''} ${n.region || ''}`);
  }
  if (!res.data.available_phone_numbers.length) console.log('  (none returned)');
}

// Twilio takes either an exact PhoneNumber or an AreaCode and picks one itself.
// The AreaCode form skips the AvailablePhoneNumbers search endpoint, which a trial
// account is not allowed to call.
async function buy(arg) {
  if (!WEBHOOK) {
    console.error('PUBLIC_WEBHOOK_URL is not set in .env');
    process.exit(1);
  }
  const pick = /^\+?\d{10,}$/.test(String(arg).replace(/\D/g, '')) && String(arg).startsWith('+')
    ? { PhoneNumber: arg }
    : { AreaCode: String(arg || '703') };
  const res = await api('POST', `${base}/IncomingPhoneNumbers.json`, {
    ...pick,
    VoiceUrl: WEBHOOK,
    VoiceMethod: 'POST',
    FriendlyName: 'Finosu intake callbot',
  });
  if (res.status !== 201) return fail('purchase', res);
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
  for (const n of nums.data.incoming_phone_numbers) {
    const res = await api('POST', `${base}/IncomingPhoneNumbers/${n.sid}.json`, {
      VoiceUrl: target,
      VoiceMethod: 'POST',
    });
    if (res.status !== 200) fail(`update ${n.phone_number}`, res);
    else console.log(`  ${n.phone_number} -> ${target}`);
  }
}

// A trial account cannot buy a number until one caller ID is verified (error
// 21404). Twilio places a call to the number and reads out a code.
async function verify(number) {
  const res = await api('POST', `${base}/OutgoingCallerIds.json`, {
    PhoneNumber: number,
    FriendlyName: 'Jaewoo mobile',
  });
  if (res.status !== 201) return fail('verification request', res);
  console.log(`\n  Twilio is calling ${res.data.phone_number} now.`);
  console.log(`  It will ask for this code: ${res.data.validation_code}`);
  console.log('  Type it on your keypad when asked. Nothing else to do here.');
}

const args = process.argv.slice(2);
const flag = args[0];

(async () => {
  if (flag === '--check') await check();
  else if (flag === '--verify') await verify(args[1]);
  else if (flag === '--search') await search(args[1]);
  else if (flag === '--buy') await buy(args[1]);
  else if (flag === '--webhook') await rewebhook(args[1]);
  else console.log('usage: --check | --search [areacode] | --buy <+1...> | --webhook [url]');
  console.log('');
})();
