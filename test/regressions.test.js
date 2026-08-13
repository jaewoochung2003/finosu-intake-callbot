// regressions.test.js — one test per bug that has actually shipped here.
//
// Every case below broke at some point and was found either by the adversarial
// review pass or by a fixture that turned out to be testing the wrong thing. They
// are kept apart from the feature tests so it is obvious what they are for: a
// failure in this file means something that was once wrong is wrong again.

const assert = require('assert');
const P = require('../src/parse');
const V = require('../src/validate');
const intake = require('../src/intake');
const SCRIPTS = require('../tools/scripts');

function play(turns) {
  const s = intake.startSession({ callSid: 'reg' });
  for (const line of turns) {
    if (s.state !== 'in_progress') break;
    intake.submit(s, line);
  }
  if (s.state === 'in_progress') intake.complete(s);
  return s;
}

// ---------- refusing to answer is not answering no ----------
// The leading-three-word scan ran before the refusal list, so the "not" in "prefer
// not to say" returned false and made the entire refusal list unreachable. On the
// assistance and military questions that settled a reject rule from an answer the
// caller never gave.

t('regression: "prefer not to say" is a re-ask, not a no', () => {
  for (const said of [
    'I would rather not say',
    'prefer not to say',
    'I prefer not to say',
    'I would prefer not to answer that',
    'not saying',
    'no comment',
    'none of your business',
    'not comfortable answering that',
    'I decline to answer',
    'do I have to answer that',
    'why do you need that',
  ]) {
    assert.strictEqual(P.parseYesNo(said), null, `"${said}" was not read as a refusal`);
  }
});

// An auxiliary verb in the YES set made any sentence starting with one an
// affirmative, so "I have no comment" recorded a yes on the assistance question.
t('regression: "I have no comment" is not a yes', () => {
  assert.strictEqual(P.parseYesNo('I have no comment'), null);
  assert.strictEqual(P.parseYesNo('I am not sure what you mean'), false);
  assert.strictEqual(P.parseYesNo('I do not receive anything'), false);
});

t('regression: "I do" and "I am" still read as yes', () => {
  assert.strictEqual(P.parseYesNo('I do'), true);
  assert.strictEqual(P.parseYesNo('I am'), true);
  assert.strictEqual(P.parseYesNo('I have'), true);
});

t('regression: a refused screening answer is asked again, not recorded', () => {
  const s = play(SCRIPTS['assistance-refused'].turns);
  assert.strictEqual(s.record.financial_assistance, false);
  assert.strictEqual(s.capture.financial_assistance.attempts, 3);
  assert.strictEqual(s.outcome.decision, 'Approved');
});

// ---------- income stated per paycheck ----------
// The income question invited a per-paycheck answer while the pay cycle was still
// twelve questions away, and no pattern matched the word "paycheck", so 1,200 every
// two weeks was recorded as 1,200 a month and declined.

t('regression: the pay cycle is asked before the income figure', () => {
  const { FIELDS } = require('../src/fields');
  const freq = FIELDS.findIndex((f) => f.key === 'pay_frequency');
  const income = FIELDS.findIndex((f) => f.key === 'monthly_income');
  assert.ok(freq >= 0 && income >= 0);
  assert.ok(freq < income, `pay_frequency is at ${freq}, monthly_income at ${income}`);
});

t('regression: twelve hundred a paycheck on a biweekly cycle clears the line', () => {
  const s = play(SCRIPTS['income-per-paycheck'].turns);
  assert.strictEqual(s.record.monthly_income, 2600);
  assert.strictEqual(s.record.income_over_2000, true);
  assert.strictEqual(s.outcome.decision, 'Approved');
});

t('regression: every way of saying per paycheck converts', () => {
  for (const said of [
    'about twelve hundred a paycheck',
    '1200 per paycheck',
    'twelve hundred each check',
    'about 1200 a pay period',
    'twelve hundred per check',
  ]) {
    assert.strictEqual(
      V.validateMonthlyIncome(said, 'Biweekly').value,
      2600,
      `"${said}" did not convert`,
    );
  }
});

// The mirror of the same bug: an unqualified answer is a month, because that is the
// question. Converting it by the pay frequency inflated it 2.17x on a weekly cycle.
t('regression: a bare figure is not multiplied by the pay cycle', () => {
  assert.strictEqual(V.validateMonthlyIncome('three thousand', 'Weekly').value, 3000);
  assert.strictEqual(V.validateMonthlyIncome('2500', 'Biweekly').value, 2500);
});

// ---------- compound spoken amounts ----------
// The ones-then-tens rule added its groups instead of placing them, so "twenty four
// fifty" came out as 470 and declined a caller earning 2,450.

t('regression: compound amounts place their groups', () => {
  const cases = {
    'twenty four fifty': 2450,
    'thirty one fifty': 3150,
    'forty two fifty': 4250,
    'twenty two seventy': 2270,
    'one thirty five': 135,
    'sixteen fifty': 1650,
    'four eighty': 480,
    'four eighty five': 485,
    'nine ninety': 990,
  };
  for (const [said, want] of Object.entries(cases)) {
    assert.strictEqual(P.parseAmount(said), want, `"${said}"`);
  }
});

t('regression: the amounts that already worked still work', () => {
  const cases = {
    'twenty five hundred': 2500,
    'thirty two hundred': 3200,
    'two thousand': 2000,
    'two thousand five hundred': 2500,
    'eleven hundred': 1100,
    'four hundred': 400,
    'a hundred and fifty': 150,
    'three grand': 3000,
    '3k a month': 3000,
    '$2,500': 2500,
    'twenty dollars an hour': 20,
    'twenty five': 25,
  };
  for (const [said, want] of Object.entries(cases)) {
    assert.strictEqual(P.parseAmount(said), want, `"${said}"`);
  }
});

t('regression: 2450 spoken as a compound is approved, not declined', () => {
  const s = play(SCRIPTS['income-compound'].turns);
  assert.strictEqual(s.record.monthly_income, 2450);
  assert.strictEqual(s.outcome.decision, 'Approved');
});

// ---------- a real department that reads as a negative ----------
// saysNone fell through to the yes/no parser with no bound, so any free-text answer
// starting with a negation was thrown away.

t('regression: "Not-For-Profit Services" is a department, not a skip', () => {
  assert.strictEqual(P.saysNone('Not-For-Profit Services', { maxWords: 3 }), false);
  const s = play(SCRIPTS['awkward-department'].turns);
  assert.strictEqual(s.record.employer_department, 'Not-For-Profit Services');
});

t('regression: short refusals still skip', () => {
  for (const said of ["I don't have one", 'none', 'nope', 'no department', 'N/A', 'no']) {
    assert.strictEqual(P.saysNone(said, { maxWords: 3 }), true, `"${said}"`);
  }
});

// ---------- spoken email with a filler in front ----------
// Everything before the "at" was concatenated, so "uh, gabriel dot kim at ..." became
// uhgabriel.kim@..., which validates cleanly and is the wrong address.

t('regression: a leading filler does not join the address', () => {
  assert.strictEqual(P.parseEmail('uh, gabriel dot kim at finosu dot com'), 'gabriel.kim@finosu.com');
  assert.strictEqual(P.parseEmail('um so my email is jae at gmail dot com'), 'jae@gmail.com');
  assert.strictEqual(
    P.parseEmail('okay it is gabriel at finosu dot com'),
    'gabriel@finosu.com',
  );
});

t('regression: a filler word inside the handle survives', () => {
  // "so" and "me" are fillers at the front and part of the address in the middle
  assert.strictEqual(P.parseEmail('so dot me at mail dot com'), 'so.me@mail.com');
});

t('regression: a spoken zero is not mistaken for a filler', () => {
  assert.strictEqual(P.parseEmail('oh two one at mail dot com'), '021@mail.com');
});

// ---------- masking ----------
// maskAccount returned any value of four digits or fewer unchanged, so a retracted
// social security ending was written to the correction log in the clear.

t('regression: a four digit value is masked whole', () => {
  assert.strictEqual(V.maskAccount('4821'), '****');
  assert.strictEqual(V.maskAccount('5512340987'), '******0987');
});

t('regression: a retracted social security ending is not stored in the clear', () => {
  const s = intake.startSession({ callSid: 'reg' });
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.ssn + 1)) intake.submit(s, line);
  assert.strictEqual(s.record.ssn_last_four, '4821');
  intake.undoLast(s);
  assert.strictEqual(s.corrections[0].field, 'ssn_last_four');
  assert.ok(!/\d/.test(s.corrections[0].previous), s.corrections[0].previous);
});

// redact() skipped "o" and "nought", so a routing number read as "o two one o o o"
// kept its zeros in the transcript.
t('regression: every spoken form of a digit is redacted', () => {
  const said = 'o two one o o o o two one and nought';
  const out = V.redact('routing_number', said);
  assert.ok(!/\b(o|nought|two|one)\b/i.test(out), out);
});

// ---------- stepping back ----------
// The walk-back tested appliesWhen alone, which made the income backstop's answer
// unreachable and then deleted it as collateral when the walk passed over it.

t('regression: stepping back reaches the income backstop answer', () => {
  const s = intake.startSession({ callSid: 'reg' });
  const turns = SCRIPTS['income-refused'].turns.slice(0, SCRIPTS.INDEX.income + 4);
  for (const line of turns) intake.submit(s, line);
  assert.strictEqual(s.record.income_over_2000, true);
  const back = intake.undoLast(s);
  assert.ok(back);
  assert.strictEqual(intake.currentField(s).key, 'income_over_2000');
  assert.strictEqual(s.corrections[0].field, 'income_over_2000');
});

// A derived value is not an answer the caller gave, so stepping back must not land
// on the question it came from.
t('regression: stepping back skips a question the caller never heard', () => {
  const s = intake.startSession({ callSid: 'reg' });
  for (const line of SCRIPTS.APPROVED.slice(0, SCRIPTS.INDEX.income + 1)) intake.submit(s, line);
  assert.strictEqual(s.record.income_over_2000, true); // derived, never asked
  intake.undoLast(s);
  assert.strictEqual(intake.currentField(s).key, 'monthly_income');
  assert.strictEqual(s.record.income_over_2000, undefined);
});

// ---------- test fixtures ----------
// variant() removed N turns and inserted N, which deleted the following question's
// answer. A shifted script still landed on the expected decision, so the suite
// passed while testing the wrong call.

t('regression: replacing one turn with two lengthens the script', () => {
  assert.strictEqual(
    SCRIPTS['fake-routing'].turns.length,
    SCRIPTS.APPROVED.length + 1,
    'variant() dropped a turn',
  );
  assert.strictEqual(SCRIPTS.savings.turns.length, SCRIPTS.APPROVED.length);
});

t('regression: every canned script still answers every question it reaches', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    if (!script || !script.turns) continue;
    const s = play(script.turns);
    assert.strictEqual(
      s.state,
      'complete',
      `${name} ran out of answers before the call ended`,
    );
    // A script that has drifted shows up as a field nobody could capture.
    if (script.expect === 'Approved') {
      assert.deepStrictEqual(s.unresolved.filter((k) => k !== 'monthly_income'), [], name);
    }
  }
});

// ---------- a spoken answer ends in a full stop ----------
// Found on the first end-to-end call with real audio, 2026-08-12. The model hands
// over what it heard as a sentence, so the email answer arrived as "gabriel at
// finosu dot com." and the trailing dot made the address fail its shape test. The
// bot re-asked, the caller repeated the same words, and every later answer landed
// in the still-open email field. One character ended the application.

t('regression: an email answer that ends in a full stop is still an email', () => {
  for (const said of [
    'gabriel at finosu dot com.',
    'Gabriel at Finosu.com.',
    'gabriel@finosu.com.',
    'my email is gabriel at finosu dot com!',
    'gabriel at finosu dot com?',
    'gabriel at finosu dot com,',
  ]) {
    assert.strictEqual(P.parseEmail(said), 'gabriel@finosu.com', said);
    assert.strictEqual(V.validateEmail(said).ok, true, said);
  }
});

t('regression: every field survives its answer arriving as a sentence', () => {
  // The email bug was one field, but the same full stop reaches all of them.
  for (let k = 0; k < SCRIPTS.APPROVED.length; k++) {
    const s = intake.startSession({ callSid: 'reg' });
    let rejected = null;
    for (let i = 0; i < SCRIPTS.APPROVED.length; i++) {
      const field = intake.currentField(s);
      if (!field) break;
      const said = i === k ? `${SCRIPTS.APPROVED[i].replace(/\.*$/, '')}.` : SCRIPTS.APPROVED[i];
      const r = intake.submit(s, said);
      if (i === k && (!r || !r.accepted)) rejected = `${field.key} rejected ${JSON.stringify(said)}`;
      if (r && r.done) break;
    }
    assert.strictEqual(rejected, null, rejected || '');
  }
});

// ---------- "no" is an answer, not a request to hang up ----------
// Also found on that first real call: the model called end_call, with the reason
// "caller refused to continue", after the caller said nothing but "no" to the
// deployed-military question. The call ended eight fields in.

t('regression: a bare no is not a request to stop', () => {
  for (const said of [
    'no',
    'No.',
    'nope',
    'no, this number is fine',
    'no I am not deployed',
    'not right now',
    'I would rather not say',
    'checking',
  ]) {
    assert.strictEqual(P.saysStop(said), false, said);
  }
});

t('regression: an actual request to stop is still recognised', () => {
  for (const said of [
    'stop',
    'I want to stop the call',
    'can you call me back later',
    'let me speak to a person',
    'I want to talk to a human',
    'take me off your list',
    'hang up',
    'never mind, forget it',
    'I am not interested',
    'goodbye',
  ]) {
    assert.strictEqual(P.saysStop(said), true, said);
  }
});

// ---------- a full stop is not part of an address ----------
// Same root cause as the email bug, seen on the printed form: every free text field
// came back carrying the sentence's punctuation, so the report read "Employer:
// Finosu." and "City: San Mateo."

t('regression: free text fields do not keep the sentence full stop', () => {
  for (const [said, want] of [
    ['1820 Gateway Drive.', '1820 Gateway Drive'],
    ['San Mateo.', 'San Mateo'],
    ['Finosu.', 'Finosu'],
    ['Engineering.', 'Engineering'],
    ['1820 Gateway Drive, San Mateo, California.', '1820 Gateway Drive, San Mateo, California'],
  ]) {
    const r = V.validateText(said);
    assert.strictEqual(r.ok, true, said);
    assert.strictEqual(r.value, want);
  }
});

// ---------- spelling an address out loud ----------
// Found on Jaewoo's own live call, 2026-08-12. Speech recognition heard "Jaywoo"
// for "Jaewoo", which no parser can fix, so the caller does what people do and
// spells it. That path was broken twice over: the letter "o" was read as a zero,
// because ONES maps it that way for phone numbers, and a year said as "two thousand
// three" came out as the literal "2thousand3".

t('regression: spelling an address letter by letter keeps the letters', () => {
  assert.strictEqual(
    P.parseEmail('j a e w o o c h u n g two zero zero three at gmail dot com'),
    'jaewoochung2003@gmail.com',
  );
});

t('regression: a year inside a handle is digits, not words', () => {
  for (const [said, want] of [
    ['jaewoo chung two thousand three at gmail dot com', 'jaewoochung2003@gmail.com'],
    ['mike nineteen ninety four at yahoo dot com', 'mike1994@yahoo.com'],
    ['sam twenty twenty five at gmail dot com', 'sam2025@gmail.com'],
  ]) {
    assert.strictEqual(P.parseEmail(said), want, said);
  }
});

// ---------- reading an address back so the error is audible ----------
// A caller who says the whole address and never spells it cannot catch a
// misspelling in a whole-word read-back: "jaywoochung2003 at gmail dot com" and the
// right one sound the same to the person who owns the name. Letters do not.

t('regression: the read-back spells the part before the at sign', () => {
  const r = V.validateEmail('jaewoochung2003 at gmail dot com');
  assert.strictEqual(r.value, 'jaewoochung2003@gmail.com');
  const line = SCRIPTS.FIELD_BY_KEY
    ? null
    : require('../src/fields').BY_KEY.email.confirmLine(r.value);
  assert.match(line, /j a e w o o c h u n g 2 0 0 3/);
  // the domain is not spelled; nobody mishears gmail
  assert.match(line, /at gmail dot com/);
});

// ---------- the name gets spelled back too ----------
// A name misheard by one letter reads back sounding like the caller's own name,
// same as the email address, and it is what goes on the loan paperwork.

t('regression: the name read-back spells every letter, and hides the spacing', () => {
  const field = require('../src/fields').BY_KEY.last_name;
  const spelled = (whole) => {
    const [first, ...rest] = whole.split(' ');
    return field.confirmLine(rest.join(' '), { first_name: first }).split("That's ")[1];
  };
  // a stray space is inaudible: one run of letters, no pause to correct
  assert.strictEqual(spelled('Jae Woo Chung'), spelled('Jaewoo Chung'));
  assert.match(spelled('Jaewoo Chung'), /j a e w o o c h u n g/);
  // a wrong letter is audible
  assert.ok(!/j a e w o o c h u n g/.test(spelled('Jaywoo Chung')));
});

// A name arriving as spelled letters, which is what the caller does after hearing a
// wrong one read back. "Jae Woo Chung" with the stray space was the live case.
t('regression: a spelled name comes back as one word per name', () => {
  assert.strictEqual(P.parseName('j a e w o o, c h u n g'), 'Jaewoo Chung');
  assert.strictEqual(P.parseName('j a e w o o and c h u n g'), 'Jaewoo Chung');
  // a lone initial is not a spelled word
  assert.strictEqual(P.parseName('J Robert Smith'), 'J Robert Smith');
});

// ---------- name spacing is a matching problem, not a capture problem ----------
// The bot read "Jae Woo Chung" back letter by letter and the caller corrected a
// space. Nothing downstream cares about that space, so the read-back no longer
// surfaces it, and the record carries the key a lookup actually compares on.

t('regression: names that differ only in spacing share one match key', () => {
  const F = require('../src/format');
  const key = (name) =>
    F.apiPayload({
      record: { name },
      outcome: { decision: 'Approved', reasons: [] },
      transcript: [],
      capture: {},
      unresolved: [],
    }).application.applicant.name_match_key;

  const same = ['Jae Woo Chung', 'Jaewoo Chung', 'Jae-Woo Chung', 'JAEWOO CHUNG'];
  for (const n of same) assert.strictEqual(key(n), 'jaewoochung', n);
  assert.notStrictEqual(key('Jaywoo Chung'), 'jaewoochung', 'a real misspelling is not the same person');
});

t('regression: a name is read back spelled, and a no asks for a spelling', () => {
  const s = intake.startSession({ callSid: 'reg' });
  intake.submit(s, 'Jae Woo');
  const first = intake.submit(s, 'chung');
  assert.match(first.say, /Okay, Jae Woo Chung\. That's j a e w o o c h u n g\. Is that right\?/);
  const after = intake.submit(s, 'no');
  assert.match(after.say, /Spell your first name/);
  intake.submit(s, 'j a e w o o');
  const second = intake.submit(s, 'c h u n g');
  assert.match(second.say, /That's j a e w o o c h u n g/);
  // and the correction reached the form, not just the read-back
  intake.submit(s, 'yes');
  assert.strictEqual(s.record.name, 'Jaewoo Chung');
});

// ---------- a letter O in a run of digits ----------
// Speech recognition writes "O21000021" for a routing number read out clearly, and
// the digit parser saw no digits at all in it.

t('regression: a letter O inside a number is a zero', () => {
  assert.strictEqual(P.spokenDigits('O21000021'), '021000021');
  assert.strictEqual(P.spokenDigits('482I'.replace('I', '1')), '4821');
  assert.strictEqual(V.validateRouting('O21000021').value, '021000021');
  // and a lone letter is still a letter, which the email address depends on
  assert.strictEqual(P.parseEmail('j o e at gmail dot com'), 'joe@gmail.com');
});

// ---------- accented transcriptions ----------
// Transcription writes a name in its native spelling. The ASCII filter turned each
// accented letter into a space, so on a live call (Aug 13) "María" reached the
// record as "Mar A" and "Álvarez-Cruz" as "Lvarez-cruz". NFD plus dropping the
// combining marks keeps the base letters instead.

t('regression: accented letters survive name parsing', () => {
  assert.strictEqual(P.parseName('María'), 'Maria');
  assert.strictEqual(P.parseName('Álvarez-Cruz'), 'Alvarez-cruz');
  assert.strictEqual(P.parseName('José Muñoz'), 'Jose Munoz');
  assert.strictEqual(P.parseName('Renée'), 'Renee');
});

// ---------- the income figure is said back ----------
// The validator built "about 3,000 dollars a month" from the day it was written,
// and intake forwarded only spokenNote, so the line was never spoken. On a live
// call (Aug 13) "3000" was heard as "2000", the caller could not know, and the
// record declined at the exact-2000 boundary. The note is the only audible copy
// of the figure the decision runs on.

// ---------- an employer with no phone ----------
// "My employer doesn't have a phone" was re-asked three times on a live call
// (Aug 13) and the field left empty, because the phone question had no skip path
// while SMS, street 2 and department all did.

t('regression: an employer with no phone is a skip, not three re-asks', () => {
  const turns = SCRIPTS.APPROVED.slice();
  turns[turns.length - 1] = "my employer doesn't have a phone";
  const s = play(turns);
  assert.strictEqual(s.record.employer_phone, 'None');
});

t('regression: a real employer phone still captures', () => {
  const s = play(SCRIPTS.APPROVED);
  assert.strictEqual(s.record.employer_phone, '(650) 862-9110');
});

t('regression: the income figure comes back as a spoken note', () => {
  const s = intake.startSession({ callSid: 'reg' });
  let r;
  for (let i = 0; i <= 9; i++) r = intake.submit(s, SCRIPTS.APPROVED[i]);
  assert.ok(r.note && /a month/.test(r.note), `income note not spoken: ${JSON.stringify(r.note)}`);
  // and the yes/no screening answers right after it stay silent
  r = intake.submit(s, SCRIPTS.APPROVED[10]);
  assert.strictEqual(r.note, null, `military yes/no grew a note: ${JSON.stringify(r.note)}`);
});
