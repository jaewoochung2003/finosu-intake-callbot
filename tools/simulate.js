// simulate.js — the whole call, typed instead of spoken.
//
// Everything except the audio: the same field order, the same validators, the same
// knockout checks, the same decision, the same email. Type what you would say and
// the answers go through the identical code path a real call uses, which is what
// makes it a test rig and not a mock.
//
//   node tools/simulate.js                    interactive
//   node tools/simulate.js --script approved  run a canned call
//   node tools/simulate.js --script savings   ... and see it decline
//   node tools/simulate.js --list             the canned calls
//   node tools/simulate.js --script approved --email   actually send the email
//   node tools/simulate.js --no-knockout      ask all 24 questions before deciding

require('../src/env');

const readline = require('readline');
const intake = require('../src/intake');
const format = require('../src/format');
const SCRIPTS = require('./scripts');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const earlyKnockout = !has('--no-knockout');

function banner(session) {
  const o = session.outcome;
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log(`DECISION: ${o.decision}`);
  for (const r of o.reasons || []) console.log(`  ${r.code} — ${r.reason}`);
  if (o.unresolved && o.unresolved.length) {
    console.log(`  not captured: ${o.unresolved.join(', ')}`);
  }
  console.log(line);
  console.log(format.formTextGrouped(session.record));
  console.log(`${line}\n`);
}

async function maybeEmail(session) {
  if (!has('--email')) {
    console.log('(no email sent; add --email to send it)\n');
    return;
  }
  const { sendEmail } = require('../src/email');
  const to = valueOf('--to') || process.env.REPORT_TO || 'jaewoochung2003@gmail.com';
  try {
    const res = await sendEmail({
      to,
      subject: format.emailSubject(session),
      text: format.emailText(session),
      html: format.emailHtml(session),
    });
    console.log(res.sent ? `emailed ${to} via ${res.via} (id ${res.id})` : `not sent: ${res.error}`);
  } catch (e) {
    console.log(`email failed: ${e.message}`);
  }
}

// ---------- canned ----------

async function runScript(name) {
  const script = SCRIPTS[name];
  if (!script) {
    console.log(`no script named "${name}". try --list`);
    process.exit(1);
  }
  const session = intake.startSession({ earlyKnockout, callSid: `sim-${name}` });
  console.log(`\nBOT: ${intake.GREETING}`);
  console.log(`BOT: ${intake.nextPrompt(session)}`);

  for (const line of script.turns) {
    if (session.state !== 'in_progress') break;
    console.log(`YOU: ${line}`);
    const r = intake.submit(session, line);
    if (r.note) console.log(`     (${r.note})`);
    if (r.problem) console.log(`     ! ${r.problem}`);
    if (r.say) console.log(`BOT: ${r.say}`);
  }
  if (session.state === 'in_progress') intake.complete(session);

  banner(session);
  await maybeEmail(session);
}

// ---------- interactive ----------

function runInteractive() {
  const session = intake.startSession({ earlyKnockout, callSid: `sim-${Date.now()}` });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\nBOT: ${intake.GREETING}`);
  console.log('(type "back" to redo the last answer, "quit" to stop)\n');

  const ask = () => {
    const prompt = intake.nextPrompt(session);
    if (!prompt) return done();
    console.log(`BOT: ${prompt}`);
    rl.question('YOU: ', (line) => {
      const said = line.trim();
      if (said.toLowerCase() === 'quit') return done();
      if (said.toLowerCase() === 'back') {
        const back = intake.undoLast(session);
        if (back) console.log(`BOT: ${back.say}\n`);
        else console.log('(nothing to go back to)\n');
        return ask();
      }
      const r = intake.submit(session, said);
      if (r.note) console.log(`     (${r.note})`);
      if (r.problem) console.log(`     ! ${r.problem}`);
      if (r.done) {
        console.log(`BOT: ${r.say}`);
        return done();
      }
      console.log('');
      ask();
    });
  };

  const done = async () => {
    rl.close();
    if (session.state === 'in_progress') intake.complete(session);
    banner(session);
    await maybeEmail(session);
  };

  ask();
}

// ---------- go ----------

(async () => {
  if (has('--list')) {
    for (const [name, s] of Object.entries(SCRIPTS)) {
      console.log(`  ${name.padEnd(14)} ${s.expect.padEnd(11)} ${s.about}`);
    }
    return;
  }
  const script = valueOf('--script');
  if (script) await runScript(script);
  else runInteractive();
})();
