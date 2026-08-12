const assert = require('assert');
const P = require('../src/parse');

// ---------- spoken digit runs ----------

t('digits: plain words', () => assert.strictEqual(P.spokenDigits('four eight two one'), '4821'));
t('digits: already numeric', () => assert.strictEqual(P.spokenDigits('4821'), '4821'));
t('digits: read in pairs', () => assert.strictEqual(P.spokenDigits('forty eight twenty one'), '4821'));
t('digits: double', () => assert.strictEqual(P.spokenDigits('double four two one'), '4421'));
t('digits: triple', () => assert.strictEqual(P.spokenDigits('triple zero seven'), '0007'));
t('digits: oh for zero', () => assert.strictEqual(P.spokenDigits('oh two one'), '021'));
t('digits: nine spoken', () =>
  assert.strictEqual(P.spokenDigits('zero two one zero zero zero zero two one'), '021000021'));
t('digits: nothing to read', () => assert.strictEqual(P.spokenDigits('I would rather not'), ''));

// ---------- dates ----------

t('date: slashes', () => assert.strictEqual(P.parseDate('3/4/1994'), '1994-03-04'));
t('date: month name + ordinal', () =>
  assert.strictEqual(P.parseDate('March 4th 1994'), '1994-03-04'));
t('date: fully spoken', () =>
  assert.strictEqual(P.parseDate('March fourth nineteen ninety four'), '1994-03-04'));
t('date: spoken all-numeric', () =>
  assert.strictEqual(P.parseDate('oh three oh four nineteen ninety four'), '1994-03-04'));
t('date: two thousand nine', () =>
  assert.strictEqual(P.parseDate('June third two thousand nine'), '2009-06-03'));
t('date: eight digit run', () => assert.strictEqual(P.parseDate('03041994'), '1994-03-04'));
t('date: rejects Feb 31', () => assert.strictEqual(P.parseDate('February 31 1990'), null));
t('date: rejects nonsense', () => assert.strictEqual(P.parseDate('sometime in the spring'), null));

t('age: birthday already passed this year', () =>
  assert.strictEqual(P.ageOn('1994-03-04', new Date(Date.UTC(2026, 7, 9))), 32));
t('age: birthday still to come', () =>
  assert.strictEqual(P.ageOn('1994-12-25', new Date(Date.UTC(2026, 7, 9))), 31));

// ---------- yes / no ----------

t('yesno: yes', () => assert.strictEqual(P.parseYesNo('yes'), true));
t('yesno: yeah with tail', () => assert.strictEqual(P.parseYesNo('yeah I get SNAP'), true));
t('yesno: no', () => assert.strictEqual(P.parseYesNo('no'), false));
t('yesno: leading no wins over later words', () =>
  assert.strictEqual(P.parseYesNo("no, I'm not on any assistance"), false));
t('yesno: nowhere near that', () =>
  assert.strictEqual(P.parseYesNo('no, nowhere near that'), false));
t('yesno: negation without no', () =>
  assert.strictEqual(P.parseYesNo("I'm not receiving anything"), false));
t('yesno: unclear stays null', () =>
  assert.strictEqual(P.parseYesNo('I would rather not say'), null));

// ---------- money ----------

t('amount: numeric', () => assert.strictEqual(P.parseAmount('$2,500'), 2500));
t('amount: twenty five hundred', () =>
  assert.strictEqual(P.parseAmount('twenty five hundred'), 2500));
t('amount: three grand', () => assert.strictEqual(P.parseAmount('about three grand'), 3000));
t('amount: 3k', () => assert.strictEqual(P.parseAmount('3k a month'), 3000));
t('amount: two thousand', () => assert.strictEqual(P.parseAmount('two thousand'), 2000));
t('amount: thirty two hundred', () =>
  assert.strictEqual(P.parseAmount('about thirty two hundred a month'), 3200));
t('amount: none', () => assert.strictEqual(P.parseAmount('a decent amount'), null));

t('period: a week', () => assert.strictEqual(P.monthlyMultiplier('four hundred a week'), 52 / 12));
t('period: every other week', () =>
  assert.strictEqual(P.monthlyMultiplier('twelve hundred every other week'), 26 / 12));
t('period: a year', () => assert.strictEqual(P.monthlyMultiplier('sixty thousand a year'), 1 / 12));
t('period: hourly is unknown', () =>
  assert.strictEqual(P.monthlyMultiplier('twenty dollars an hour'), null));
t('period: unstated', () => assert.strictEqual(P.monthlyMultiplier('three thousand'), undefined));

// ---------- email ----------

t('email: typed', () =>
  assert.strictEqual(P.parseEmail('gabriel@finosu.com'), 'gabriel@finosu.com'));
t('email: spoken at and dot', () =>
  assert.strictEqual(P.parseEmail('gabriel at finosu dot com'), 'gabriel@finosu.com'));
t('email: with a dot in the handle', () =>
  assert.strictEqual(
    P.parseEmail('j dot chung two zero zero three at gmail dot com'),
    'j.chung2003@gmail.com',
  ));
t('email: underscore', () =>
  assert.strictEqual(P.parseEmail('a underscore b at mail dot com'), 'a_b@mail.com'));
t('email: not an email', () => assert.strictEqual(P.parseEmail('I do not have one'), null));

// ---------- small enums ----------

t('state: code', () => assert.strictEqual(P.parseState('CA'), 'CA'));
t('state: name', () => assert.strictEqual(P.parseState('California'), 'CA'));
t('state: two words', () => assert.strictEqual(P.parseState('New York'), 'NY'));
t('state: inside a sentence', () => assert.strictEqual(P.parseState('I live in Virginia'), 'VA'));
t('state: nonsense', () => assert.strictEqual(P.parseState('somewhere warm'), null));

t('weekday', () => assert.strictEqual(P.parseWeekday('every friday'), 'Friday'));
t('day of month: ordinal', () => assert.strictEqual(P.parseDayOfMonth('the fifteenth'), '15'));
t('day of month: two of them', () =>
  assert.strictEqual(P.parseDayOfMonth('the first and the fifteenth'), '1 and 15'));
t('day of month: last day', () =>
  assert.strictEqual(P.parseDayOfMonth('the fifteenth and the last day'), '15 and last'));

t('name: strips the lead-in', () =>
  assert.strictEqual(P.parseName('my name is Gabriel Kim'), 'Gabriel Kim'));
t('name: bare', () => assert.strictEqual(P.parseName('gabriel kim'), 'Gabriel Kim'));

// ---------- "I don't have one" ----------
// An hourly worker with no department must be able to say so without the sentence
// being written into the field.

t('none: apostrophe survives the split', () => assert.strictEqual(P.saysNone("I don't have one"), true));
t('none: bare none', () => assert.strictEqual(P.saysNone('none'), true));
t('none: n/a', () => assert.strictEqual(P.saysNone('N/A'), true));
t('none: no department', () => assert.strictEqual(P.saysNone('no department'), true));
t('none: spelled out negative', () =>
  assert.strictEqual(P.saysNone('I do not have a department'), true));
t('none: plain no', () => assert.strictEqual(P.saysNone('no this number is fine'), true));
t('none: a real department is not a skip', () =>
  assert.strictEqual(P.saysNone('Engineering'), false));
t('none: a department whose name contains no', () =>
  assert.strictEqual(P.saysNone('Northern Operations'), false));
t('none: empty', () => assert.strictEqual(P.saysNone(''), false));
