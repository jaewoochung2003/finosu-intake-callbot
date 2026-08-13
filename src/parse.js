// parse.js — turn what a person said on the phone into a value.
//
// Speech recognition hands back words, not data. "four eight two one" and "forty
// eight twenty one" and "4821" are the same four digits; "j chung at gmail dot com"
// is an email address; "twenty five hundred a month" is 2500. Every one of those
// shapes shows up on a real call, so the conversions live here in one place and
// every one of them is a pure function with a test.
//
// Nothing here decides anything. It only converts. validate.js judges, decision.js
// decides.

// ---------- word tables ----------

const ONES = {
  zero: 0, oh: 0, o: 0, nought: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9,
};

const TEENS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, twentyfirst: 21, thirtieth: 30, thirtyfirst: 31,
};

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC', 'washington dc': 'DC',
  'puerto rico': 'PR',
  // Territories and the military ZIP state codes, all valid USPS abbreviations that
  // show up on real applications. Without them a Guam or APO caller re-asked three
  // times and the required state field dropped, sinking an approvable call to Incomplete.
  guam: 'GU', 'virgin islands': 'VI', 'us virgin islands': 'VI',
  'american samoa': 'AS', 'northern mariana islands': 'MP',
  'armed forces americas': 'AA', 'armed forces europe': 'AE', 'armed forces pacific': 'AP',
};

// AA/AE/AP are the military ZIP state codes; GU/VI/AS/MP are the territories. They
// have no spelled-out name a caller would say, so they only need to be recognized
// as two-letter codes.
const STATE_CODES = new Set([...Object.values(STATES), 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP']);

const WEEKDAYS = {
  monday: 'Monday', mon: 'Monday', tuesday: 'Tuesday', tues: 'Tuesday', tue: 'Tuesday',
  wednesday: 'Wednesday', wed: 'Wednesday', thursday: 'Thursday', thurs: 'Thursday',
  thur: 'Thursday', thu: 'Thursday', friday: 'Friday', fri: 'Friday',
  saturday: 'Saturday', sat: 'Saturday', sunday: 'Sunday', sun: 'Sunday',
};

// Auxiliary verbs are deliberately absent. "I have no comment" and "I am not sure"
// both open with one, and a set that contained them read those as yes. The "I do" /
// "I am" style of answer is matched as a phrase instead, after the negation check.
// "right" is deliberately absent. It is a yes ("that's right") only in confirmation,
// and a filler everywhere else: "right, no I'm not deployed", "well right now, no",
// and the echo of a question that literally ends "...right now?". Treating it as yes
// flipped clear noes into knockout declines. A bare "right" now re-asks, which costs
// a sentence and never a wrong decline.
const YES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'yah', 'sure', 'correct', 'affirmative',
  'absolutely', 'definitely', 'certainly', 'true', 'uhhuh', 'mhm', 'mmhm',
]);

const NO = new Set([
  'no', 'nope', 'nah', 'negative', 'never', 'false', 'not', 'dont', 'doesnt', 'didnt',
  'wont', 'cant', 'isnt', 'arent', 'wasnt', 'havent', 'hasnt', 'nothing', 'none', 'nada',
  'nah', 'negatory', 'uhuh', 'nuhuh',
]);

// ---------- helpers ----------

function words(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function wordDigits(w) {
  if (/^\d+$/.test(w)) return w;
  if (w in ONES) return String(ONES[w]);
  if (w in TEENS) return String(TEENS[w]);
  if (w in TENS) return String(TENS[w]);
  return '';
}

// ---------- digit runs ----------

// A run of digits read aloud: account numbers, routing numbers, SSN last four, zips.
// Handles "four eight two one", "forty eight twenty one", "double four two one",
// "triple zero one", and a plain "4821". Anything it cannot read becomes nothing,
// which is what makes a bad capture fail validation instead of passing quietly.
function spokenDigits(text) {
  // A letter O sitting in a run of digits is a zero. Speech recognition writes
  // "O21000021" often enough that a routing number said perfectly clearly came back
  // as no digits at all. Only inside a run: on its own, "o" is a letter, and the
  // email parser depends on it staying one.
  const list = words(String(text == null ? '' : text)).map((w) =>
    /^[o\d]+$/i.test(w) && /\d/.test(w) ? w.replace(/o/gi, '0') : w,
  );
  let out = '';
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    const repeat = w === 'double' ? 2 : w === 'triple' ? 3 : 0;
    if (repeat) {
      out += wordDigits(list[++i] || '').repeat(repeat);
      continue;
    }
    if (w === 'hundred' || w === 'thousand') continue;
    // "forty eight" is one pair of digits in a read-aloud number, not 40 then 8
    if (w in TENS && list[i + 1] in ONES && ONES[list[i + 1]] !== 0) {
      out += String(TENS[w] + ONES[list[++i]]);
      continue;
    }
    out += wordDigits(w);
  }
  return out;
}

// ---------- dates ----------

// "nineteen ninety four" -> 1994, "two thousand one" -> 2001, "ninety four" -> 1994
function spokenYear(list) {
  const nums = [];
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (/^\d+$/.test(w)) nums.push(Number(w));
    else if (w === 'thousand') nums.push(1000);
    else if (w === 'hundred') nums.push(100);
    else if (w in TEENS) nums.push(TEENS[w]);
    else if (w in TENS) nums.push(TENS[w] + (list[i + 1] in ONES ? ONES[list[++i]] : 0));
    else if (w in ONES) nums.push(ONES[w]);
    else return null;
  }
  if (!nums.length) return null;
  if (nums.length === 1) {
    const n = nums[0];
    if (n >= 1900) return n;
    if (n < 100) return n > 25 ? 1900 + n : 2000 + n;
    return null;
  }
  if (nums[1] === 1000) return nums[0] * 1000 + (nums[2] || 0);
  if (nums[0] >= 10 && nums[0] <= 20 && nums[1] < 100) return nums[0] * 100 + nums[1];
  return null;
}

function isoDate(y, m, d) {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const year = y < 100 ? (y > 25 ? 1900 + y : 2000 + y) : y;
  const probe = new Date(Date.UTC(year, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null; // Feb 31
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Returns "YYYY-MM-DD" or null. Handles "3/4/1994", "March 4th 1994",
// "March fourth nineteen ninety four", "oh three oh four ninety four", "03041994".
function parseDate(text) {
  const raw = String(text == null ? '' : text);

  const iso = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = raw.match(/(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2,4})/);
  if (slash) return isoDate(Number(slash[3]), Number(slash[1]), Number(slash[2]));

  const list = words(raw);
  let month = null;
  let day = null;
  const rest = [];

  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (month === null && w in MONTHS) { month = MONTHS[w]; continue; }
    // Unambiguous day tokens may appear before OR after the month, so a date said
    // day-first ("the third of April") is read as the 3rd, not as the 19th grabbed
    // off the year. "twenty eighth" is a tens word plus an ORDINAL, which the bare
    // "tens + ONES" test below missed, so it recorded the 8th.
    if (day === null) {
      if (w in TENS && list[i + 1] in ORDINALS) { day = TENS[w] + ORDINALS[list[++i]]; continue; }
      if (w in ORDINALS) { day = ORDINALS[w]; continue; }
      if (/^\d{1,2}(st|nd|rd|th)$/.test(w)) { day = parseInt(w, 10); continue; }
    }
    // Bare cardinal day words are only read after the month, so the year's leading
    // word ("nineteen ninety") is never mistaken for the nineteenth.
    if (month !== null && day === null) {
      if (/^\d{1,2}$/.test(w) && Number(w) >= 1 && Number(w) <= 31) { day = Number(w); continue; }
      if (w in TENS && list[i + 1] in ONES) { day = TENS[w] + ONES[list[++i]]; continue; }
      if (w in TEENS) { day = TEENS[w]; continue; }
      if (w in ONES) { day = ONES[w]; continue; }
    }
    if (month !== null && day !== null) rest.push(w);
  }

  if (month !== null && day !== null) {
    // Take only the year words out of what follows, so a trailing hedge ("...nineteen
    // ninety four, I think") does not poison spokenYear, which bails on the first word
    // it cannot read. Leading filler is skipped; the year run ends at the next non-year
    // word.
    const yearTokens = [];
    let started = false;
    for (const w of rest) {
      const isYear = /^\d+$/.test(w) || w === 'thousand' || w === 'hundred' || w in TEENS || w in TENS || w in ONES;
      if (isYear) { yearTokens.push(w); started = true; }
      else if (started) break;
    }
    const year = spokenYear(yearTokens);
    return year ? isoDate(year, month, day) : null;
  }

  // Bare numbers, each its own token, no month name: "3 4 94", "12 4 1994",
  // "7 15 88". The single-digit peel loop below could not read a two-digit month,
  // day, or year token, so these returned null and the caller was re-asked to a
  // dead end. US month-day-year order; isoDate validates the ranges and the year.
  if (month === null && list.length === 3 && list.every((w) => /^\d{1,4}$/.test(w))) {
    const bare = isoDate(Number(list[2]), Number(list[0]), Number(list[1]));
    if (bare) return bare;
  }

  const digits = spokenDigits(raw);
  if (digits.length === 8) {
    return isoDate(Number(digits.slice(4)), Number(digits.slice(0, 2)), Number(digits.slice(2, 4)));
  }
  if (digits.length === 6) {
    return isoDate(Number(digits.slice(4)), Number(digits.slice(0, 2)), Number(digits.slice(2, 4)));
  }

  // "oh three oh four nineteen ninety four": peel month and day off a digit at a time,
  // then read whatever is left as a year.
  let md = '';
  let i = 0;
  for (; i < list.length && md.length < 4; i++) {
    const d = spokenDigits(list[i]);
    if (!d) return null;
    md += d;
  }
  if (md.length !== 4) return null;
  const year = spokenYear(list.slice(i));
  return year ? isoDate(year, Number(md.slice(0, 2)), Number(md.slice(2))) : null;
}

function ageOn(isoBirth, asOf) {
  const [y, m, d] = isoBirth.split('-').map(Number);
  const now = asOf || new Date();
  let age = now.getUTCFullYear() - y;
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  if (md < m * 100 + d) age -= 1;
  return age;
}

// ---------- yes / no ----------

// Someone who will not answer a question has not answered it in the negative.
// "I prefer not to say" on the assistance question is not a no, and recording it as
// one settles a reject rule from an answer the caller never gave. This runs before
// anything else for that reason: an earlier version put the leading-word scan first,
// where the "not" in "prefer not to say" matched and returned false, which made the
// whole refusal list below unreachable.
const REFUSAL =
  /\b(rather not|prefer not|d rather|decline to|declining to|not comfortable|none of your|not saying|no comment|not answering|dont want to say|do not want to say|dont wanna say|why do you need|do i have to|is that required|skip that|skip this|pass on that|next question)\b/;

// Answers whose only affirmative word is an auxiliary verb: "I do", "I am",
// "I have". Those words cannot go in the YES set, because a sentence that merely
// starts with one ("I have no comment", "I am not sure") would read as a yes.
// Present tense only: the knockout questions ask "right now", so a past-tense answer
// ("I was deployed years ago", "I did two tours but I'm out now") is a NO, not a yes.
// "i was" and "i did" are dropped here and caught by the past-experience guard below.
const AFFIRMATIVE_PHRASE = /\b(i do|i am|i m|i have|i is|that i am|we do|yes i (do|am|have))\b/;

// What people actually say to a read-back. "Right" cannot go in the YES set on its
// own, because it is also filler and the knockout questions themselves say "right
// now", so "right, no I'm not deployed" would read as a yes. Bound to the phrase
// instead: "that's right" confirms, a leading "no" still wins over it, and "that's
// not right" is caught by the negation check above this.
// Without these, answering the name read-back with "that's right" fell through to
// the correction path and wrote the phrase in as the caller's surname.
const CONFIRMATION_PHRASE =
  /\b(thats right|that is right|thats correct|that is correct|thats it|thats the one|thats me|thats mine|you got it|got it right|sounds right|sounds good|looks right|uh huh|uh hu|mm hmm|mm hm|m hm|all right|thats what i said)\b/;

// Past or finished-experience phrasing on a present-tense question. A veteran
// describing prior service is not currently deployed, so this forces a re-ask rather
// than reading "I was in the service" as a yes.
const PAST_EXPERIENCE = /\b(was|were|used to|years ago|a while back|back then|before|former|formerly|veteran|vet|out now|no longer|retired from|had been|have been)\b/;

// Returns true, false, or null when the answer was neither. A null is a re-ask,
// never a default.
function parseYesNo(text) {
  const cleaned = String(text == null ? '' : text).replace(/['‘’]/g, '');
  const list = words(cleaned);
  if (!list.length) return null;
  const joined = list.join(' ');

  if (REFUSAL.test(joined)) return null;

  // A leading "no" or "yes" wins over anything later in the sentence:
  // "no, I'm not on any assistance" is a no.
  for (const w of list.slice(0, 3)) {
    if (NO.has(w)) return false;
    if (YES.has(w)) return true;
  }

  if (/\bnot\b|\bnt\b/.test(joined)) return false;
  // Prior service described in the past ("I was deployed years ago") answers a
  // present-tense knockout in the negative, so it re-asks rather than reading the
  // auxiliary "i was"/"i have been" as a yes. A present-tense cue overrides it.
  if (PAST_EXPERIENCE.test(joined) && !/\b(i am|i m|currently|right now|still|these days|presently)\b/.test(joined)) {
    return null;
  }
  if (CONFIRMATION_PHRASE.test(joined)) return true;
  if (AFFIRMATIVE_PHRASE.test(joined)) return true;

  for (const w of list) {
    if (NO.has(w)) return false;
    if (YES.has(w)) return true;
  }
  return null;
}

// Asking to stop, as opposed to answering "no" to a question. The model has an
// end_call tool and it reached for it on a bare "no" during a live test, hanging up
// on an applicant who was answering the deployed-military question. The server
// checks the caller's own words against this before it lets the call end, because a
// wrongly ended call loses an application and a wrongly refused one costs the caller
// a hangup they were about to do anyway.
const STOP_REQUEST = [
  /\b(hang up|hangup)\b/,
  /\b(stop|end|cancel|quit) (the |this )?(call|application|thing|process)\b/,
  /\b(stop|quit) (calling|asking|talking)\b/,
  /\b(call|try) (me )?back\b/,
  /\b(not|no longer) interested\b/,
  /\b(speak|talk) (to|with) (a |an |someone|somebody)?(person|human|agent|representative|rep|operator|someone|somebody)\b/,
  /\b(transfer|connect|put) me\b/,
  /\b(real|actual|live) (person|human)\b/,
  /\bi(?: a?m| will be)? (done|finished|out)\b/,
  /\b(dont|do not) want to (continue|keep going|do this|go on)\b/,
  /\b(take me off|remove me|unsubscribe)\b/,
  /\b(never mind|nevermind|forget it|forget this)\b/,
  /\b(another time|some other time|maybe later|later today|call later)\b/,
  /\b(good ?bye|bye bye)\b/,
];

function saysStop(text) {
  const raw = words(String(text == null ? '' : text).replace(/['‘’]/g, '')).join(' ');
  if (!raw) return false;
  if (/^(stop|quit|cancel|goodbye|bye)$/.test(raw)) return true;
  // "Am I talking to a real person?" is a question about the bot, not a request to
  // leave it. It matched the "real person" stop pattern and could end the call. An
  // identity question (are you / is this / am i talking to ... person|human|ai|bot)
  // with no transfer verb is answered, not acted on.
  if (
    /\b(are you|is this|is it|are we|am i (talking|speaking|on)|is there)\b/.test(raw) &&
    /\b(person|human|robot|machine|ai|automated|bot|recording|computer)\b/.test(raw) &&
    !/\b(speak|talk|transfer|connect|put me|get me)\b/.test(raw)
  ) {
    return false;
  }
  return STOP_REQUEST.some((re) => re.test(raw));
}

// "I don't have one" is an answer to an optional question, not a failure to answer
// it. Without this the bot writes the sentence into the field: an hourly worker with
// no department ends up with "I don't have one" as their department.
// `maxWords` bounds the fallback, and it is load-bearing on any field whose answer
// is free text. "Not-For-Profit Services" is a real department and parseYesNo reads
// it as a no, so without the bound the department gets thrown away. A genuine "I
// don't have one" is short; a department name that happens to start with a negation
// is not. The explicit phrases below are not bounded, since "I do not have a
// department" is long and unambiguous.
function saysNone(text, opts = {}) {
  // Apostrophes go first, not last. words() turns "don't" into "don t", so a
  // pattern written as "dont have" never matches unless the apostrophe is removed
  // before the split rather than by it.
  const list = words(String(text == null ? '' : text).replace(/['‘’]/g, ''));
  const raw = list.join(' ');
  if (!raw) return false;
  if (
    /\b(none|no department|no unit|no apartment|dont have|do not have|dont got|havent got|not applicable|n a|nope|nothing|not really|no idea|doesnt apply|does not apply|not sure|skip it|just skip|rather not|prefer not|rather keep|dont want to|do not want to)\b/.test(
      raw,
    )
  ) {
    return true;
  }
  if (opts.maxWords && list.length > opts.maxWords) return false;
  return parseYesNo(text) === false;
}

// ---------- money ----------

// "twenty five hundred" -> 2500, "3k" -> 3000, "three grand" -> 3000,
// "$1,850.50" -> 1850.5, "about two thousand" -> 2000. Returns null if no amount.
function parseAmount(text) {
  let raw = String(text == null ? '' : text).toLowerCase();

  // "a few / several grand" is too vague to bank an income on — re-ask. "a couple"
  // is a firm two, so "a couple grand" reads as 2,000 instead of defaulting the
  // missing number to one and recording 1,000.
  if (/\b(a few|few|several|handful|bunch)\b/.test(raw)) return null;
  raw = raw.replace(/\ba couple of\b|\bcouple of\b|\ba couple\b|\bcouple\b/g, 'two');

  // Two incomes split across jobs ("fifteen hundred from each") can't be totalled
  // without knowing how many, and summing the stray "two" from "two jobs" invented a
  // 1,502. Re-ask for one total instead of recording a wrong figure. "each month" is
  // a pay period, not a split, so it is left alone.
  if (/\bfrom each\b|\beach job\b|\bapiece\b|\bper job\b|\ba piece\b|\beach\b(?!\s+(month|week|paycheck|pay period|year|day|check))/.test(raw)) {
    return null;
  }

  // A spoken decimal ("two point five k") used to come out as 5002. If it isn't
  // already a clean numeric decimal, re-ask rather than fabricate a number.
  if (/\bpoint\b/.test(raw) && !/\d+\.\d+/.test(raw)) return null;

  // "and a half" after a thousands word is +500: "two and a half grand" is 2,500,
  // not 2,000 (which, at exactly the line, was a wrong decline).
  const halfPending = /\b(and a half|a half|and half)\b/.test(raw);

  // A range is not a figure. "Between fifteen hundred and four thousand" was summed
  // into 5,500 — a number the caller never said, on the wrong side of the line.
  // Return null so the bot asks for one number instead of inventing one.
  const scaleWords = (raw.match(/\b(hundred|thousand|million|billion|lakh|crore|k|grand)\b/g) || []).length;
  if (/\bbetween\b/.test(raw)) return null;
  if (scaleWords >= 2 && /\b(to|through|or)\b/.test(raw)) return null;

  const numeric = raw.replace(/[$,]/g, '').match(/(\d+(?:\.\d+)?)\s*(k|grand)?/);
  if (numeric && /\d/.test(numeric[1])) {
    let n = Number(numeric[1]);
    if (numeric[2]) n *= 1000;
    // "1.5k" and "2 k" are thousands; a bare "2" next to "thousand" is handled below
    if (!numeric[2] && /\bthousand\b/.test(raw) && n < 100) n *= 1000;
    if (/\bmillion\b/.test(raw) && n < 1000000) n *= 1000000;
    if (/\bbillion\b/.test(raw) && n < 1000000000) n *= 1000000000;
    if (n > 0) return n;
  }

  // Spoken amounts come in groups, each below a hundred: "twenty four" is one group,
  // "twenty four fifty" is two. Two groups with no "hundred" or "thousand" between
  // them is how people say a four figure amount out loud, so "twenty four fifty" is
  // 2,450 and "four eighty" is 480. An earlier version added the groups instead of
  // placing them, which turned 2,450 into 470 and declined the caller.
  const list = words(raw);
  const groups = [];
  let current = null;
  let total = 0;
  let scaled = false;
  let saw = false;

  const closeGroup = () => {
    if (current !== null) groups.push(current);
    current = null;
  };

  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (w in TENS) {
      closeGroup();
      current = TENS[w];
      if (list[i + 1] in ONES && ONES[list[i + 1]] > 0) current += ONES[list[++i]];
      saw = true;
      continue;
    }
    if (w in TEENS) { closeGroup(); current = TEENS[w]; saw = true; continue; }
    if (w in ONES) { closeGroup(); current = ONES[w]; saw = true; continue; }
    if (w === 'hundred') { current = (current === null ? 1 : current) * 100; scaled = true; saw = true; continue; }
    if (w === 'thousand' || w === 'grand' || w === 'k') {
      total += (current === null ? 1 : current) * 1000;
      current = null;
      scaled = true;
      saw = true;
      continue;
    }
    if (w === 'million' || w === 'billion') {
      // Spoken "million" collapsed to the leading "one" and recorded a 1-dollar
      // income, which auto-declined the applicant. Scale it, and let the income
      // validator's upper guard reject a figure this large as a mis-hear.
      total += (current === null ? 1 : current) * (w === 'million' ? 1000000 : 1000000000);
      current = null;
      scaled = true;
      saw = true;
      continue;
    }
    if (w === 'lakh' || w === 'lac' || w === 'crore') {
      // South-Asian scale words, same collapse-to-one bug as million: "two lakh"
      // recorded 2 and knocked out a qualified earner.
      total += (current === null ? 1 : current) * (w === 'crore' ? 10000000 : 100000);
      current = null;
      scaled = true;
      saw = true;
      continue;
    }
  }
  closeGroup();

  if (!scaled && groups.length === 2 && groups[0] >= 1 && groups[1] < 100) {
    total = groups[0] * 100 + groups[1];
  } else {
    total += groups.reduce((sum, g) => sum + g, 0);
  }
  if (halfPending && saw) {
    if (/\bmillion\b/.test(raw)) total += 500000;
    else if (/\b(thousand|grand|k)\b/.test(raw)) total += 500;
  }
  // Zero is a real answer, not a missing one. "Zero dollars" from a student with no
  // income used to fail the > 0 test and re-ask forever; it should record 0 and let
  // the income rule decline. `saw` still guards against no number at all.
  return saw ? total : null;
}

// "twelve hundred a paycheck" states a period without naming one monthlyMultiplier
// knows. The period is whatever the applicant's pay frequency is, which is why the
// call asks how often they are paid before it asks how much.
const PER_PAYCHECK =
  /\b(a|per|each|every|one)\s+(pay\s?check|check|pay\s?period|pay)\b|\bpaycheck\b|\bper\s?check\b/;

function perPaycheck(text) {
  return PER_PAYCHECK.test(String(text == null ? '' : text).toLowerCase());
}

const PERIOD_TO_MONTHLY = {
  hour: null, // needs hours worked; treated as unknown on purpose
  week: 52 / 12,
  weekly: 52 / 12,
  biweekly: 26 / 12,
  fortnight: 26 / 12,
  semimonthly: 2,
  month: 1,
  monthly: 1,
  year: 1 / 12,
  annual: 1 / 12,
  yearly: 1 / 12,
};

// Reads the period out of "twelve hundred every two weeks" so an amount can be
// compared against a monthly threshold. Returns a multiplier or null.
function monthlyMultiplier(text) {
  const raw = String(text == null ? '' : text).toLowerCase();
  if (/\bevery\s+two\s+weeks?\b|\bbi[\s-]?weekly\b|\bevery\s+other\s+week\b/.test(raw)) return 26 / 12;
  if (/\btwice\s+a\s+month\b|\bsemi[\s-]?monthly\b|\btwice\s+monthly\b/.test(raw)) return 2;
  if (/\bper\s+week\b|\ba\s+week\b|\bevery\s+week\b|\beach\s+week\b|\bweekly\b/.test(raw)) return 52 / 12;
  if (/\bper\s+month\b|\ba\s+month\b|\bevery\s+month\b|\beach\s+month\b|\bmonthly\b/.test(raw)) return 1;
  if (/\bper\s+year\b|\ba\s+year\b|\beach\s+year\b|\bannually\b|\bannual\b|\byearly\b/.test(raw)) return 1 / 12;
  if (/\bper\s+hour\b|\ban\s+hour\b|\bhourly\b/.test(raw)) return null;
  return undefined; // no period stated
}

// ---------- email ----------

// People say email addresses. "j chung 2003 at gmail dot com" has to become
// jchung2003@gmail.com, and "underscore" and "dash" have to survive.
// Fillers that show up in front of a spoken address and would otherwise be glued
// onto the front of it: "uh, gabriel dot kim at finosu dot com" became
// uhgabriel.kim@finosu.com, which validates cleanly and is the wrong address.
// Only a leading run is dropped, so a real handle containing one of these words
// survives.
const EMAIL_FILLERS = new Set([
  // "oh" is deliberately absent: it is also how people say a zero.
  'uh', 'um', 'umm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'mm', 'okay', 'ok', 'so',
  'well', 'yeah', 'yes', 'sure', 'like', 'its', 'it', 'my', 'the', 'email', 'address',
  'is', 'sorry', 'lets', 'let', 'see', 'sec', 'hold', 'on', 'that', 'would', 'be',
  'you', 'can', 'reach', 'me', 'at',
  // Correction lead-ins, so "yeah, actually it's nathan at gmail dot com" strips to
  // the address instead of gluing "actuallyitis" onto the front. The separator guard
  // in stripLeadingFillers still protects a real "no dot reply at ..." address.
  'actually', 'wait', 'no', 'not', 'nope', 'meant', 'should', 'make', 'change', 'correction',
]);

const EMAIL_SEPARATORS = new Set(['.', '_', '-', '+', '@']);

function stripLeadingFillers(tokens) {
  let i = 0;
  while (
    i < tokens.length - 1 &&
    tokens[i] !== '@' &&
    EMAIL_FILLERS.has(tokens[i]) &&
    // A filler word sitting directly in front of a separator is not a filler, it is
    // the start of the address: "so dot me at mail dot com" is so.me@mail.com.
    !EMAIL_SEPARATORS.has(tokens[i + 1])
  ) {
    i += 1;
  }
  return tokens.slice(i);
}

// A number said the way a year is said, starting at words[i]. Returns the value and
// how many words it ate, or null. Handles "two thousand three", "nineteen ninety
// four", "twenty twenty five", and the plain "two thousand". Kept apart from
// spokenYear above, which reads a whole list and belongs to the date parser.
function yearWordsAt(words_, i) {
  const w = words_[i];
  const n1 = words_[i + 1];
  const n2 = words_[i + 2];

  if (w in ONES && n1 === 'thousand') {
    const base = ONES[w] * 1000;
    if (n2 in ONES) return { value: base + ONES[n2], used: 3 };
    if (n2 in TEENS) return { value: base + TEENS[n2], used: 3 };
    if (n2 in TENS) {
      const n3 = words_[i + 3];
      if (n3 in ONES) return { value: base + TENS[n2] + ONES[n3], used: 4 };
      return { value: base + TENS[n2], used: 3 };
    }
    return { value: base, used: 2 };
  }

  // nineteen ninety four -> 1994, twenty twenty five -> 2025
  const lead = w in TEENS ? TEENS[w] : w in TENS ? TENS[w] : null;
  if (lead !== null && lead >= 10 && n1 in TENS) {
    const n3 = words_[i + 2];
    if (n3 in ONES) return { value: lead * 100 + TENS[n1] + ONES[n3], used: 3 };
    return { value: lead * 100 + TENS[n1], used: 2 };
  }

  return null;
}

function parseEmail(text) {
  let s = String(text == null ? '' : text).toLowerCase().trim();

  // An answer arrives as a sentence and a sentence ends in a full stop, so what the
  // model hands over is "gabriel at finosu dot com." No address ends in punctuation,
  // and leaving it on made the final "com." fail the shape test on every live call.
  s = s.replace(/[.!?;:,\s]+$/, '');

  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(s)) return s;

  s = s
    .replace(/\bmy email (address )?is\b/g, ' ')
    .replace(/\bit'?s\b/g, ' ')
    .replace(/\bat sign\b|\bat symbol\b|\batsign\b/g, ' @ ')
    .replace(/\s+at\s+/g, ' @ ')
    .replace(/\s+dot\s+|\s+period\s+|\s+point\s+/g, ' . ')
    .replace(/\s+underscore\s+|\s+under score\s+/g, ' _ ')
    .replace(/\s+dash\s+|\s+hyphen\s+|\s+minus\s+/g, ' - ')
    .replace(/\s+plus\s+/g, ' + ')
    .replace(/\bgmail\b/g, 'gmail')
    .replace(/[,]/g, ' ');

  // Spelled-out digits inside a handle. Two traps, both found on a live call:
  //
  // "o" means the letter, not a zero. ONES maps it to 0 for phone numbers, where
  // people do say "five oh five", but somebody spelling "jaewoo" letter by letter
  // gets jaew00 out of it, which is the one case where spelling was meant to help.
  //
  // A year comes out of a mouth as "two thousand three", not as four digits, and
  // mapping word by word produced "2thousand3".
  const words_ = stripLeadingFillers(s.trim().split(/\s+/).filter(Boolean));
  const tokens = [];
  for (let i = 0; i < words_.length; i++) {
    const w = words_[i];
    // two thousand three, nineteen ninety four, twenty twenty five
    const year = yearWordsAt(words_, i);
    if (year) {
      tokens.push(String(year.value));
      i += year.used - 1;
      continue;
    }
    if (w in ONES && w !== 'o') tokens.push(String(ONES[w]));
    else if (w in TEENS) tokens.push(String(TEENS[w]));
    else tokens.push(w);
  }

  const collapsed = tokens.join('').replace(/[.!?;:,]+$/, '');
  if (/^[^@]+@[^@]+\.[a-z]{2,}$/.test(collapsed)) return collapsed;
  return null;
}

// ---------- small enums ----------

function parseState(text) {
  const raw = String(text == null ? '' : text).trim();
  const upper = raw.toUpperCase().replace(/[^A-Z\s]/g, '').trim();
  if (/^[A-Z]{2}$/.test(upper) && STATE_CODES.has(upper)) return upper;
  // "V A" spelled out
  const letters = upper.replace(/\s+/g, '');
  if (/^[A-Z]{2}$/.test(letters) && STATE_CODES.has(letters)) return letters;
  const key = raw.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  if (key in STATES) return STATES[key];
  // Longest name first, so "it's West Virginia" matches "west virginia" and not the
  // "virginia" sitting inside it, and "Washington DC" beats "washington". The old
  // first-hit loop recorded WV callers as VA and DC callers as WA.
  let best = null;
  for (const [name, code] of Object.entries(STATES)) {
    if (key.includes(name) && (!best || name.length > best.name.length)) best = { name, code };
  }
  return best ? best.code : null;
}

function parseWeekday(text) {
  for (const w of words(text)) if (w in WEEKDAYS) return WEEKDAYS[w];
  return null;
}

// "the fifteenth and the last day" -> "15 and last"; "the first" -> "1"
function parseDayOfMonth(text) {
  const raw = String(text == null ? '' : text).toLowerCase();
  const days = [];
  const list = words(raw);
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    let n = null;
    if (/^\d{1,2}(st|nd|rd|th)?$/.test(w)) n = parseInt(w, 10);
    else if (w in ORDINALS) n = ORDINALS[w];
    else if (w in TENS && list[i + 1] in ORDINALS) { n = TENS[w] + ORDINALS[list[++i]]; }
    if (n !== null && n >= 1 && n <= 31 && !days.includes(String(n))) days.push(String(n));
  }
  // "the fifteenth and the last day" keeps the spoken order; last day of the month
  // is always the later one.
  if (/\blast\b|\bend of the month\b|\beom\b/.test(raw)) days.push('last');
  return days.length ? days.join(' and ') : null;
}

// Matches free speech against an enum. Returns the canonical option, or null when
// the answer is empty or names more than one option. A caller who echoes the
// question ("checking or savings? ... checking") names both, so the substring
// synonym 'saving' inside "savings" no longer decides it: synonyms match on whole
// words, and when two distinct options both appear the answer is ambiguous and the
// bot re-asks rather than banking a guess (a false savings decline before this).
function parseEnum(text, options, synonyms = {}) {
  const raw = words(text).join(' ');
  if (!raw) return null;

  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // A word the caller ruled out is not the word they chose. "I'm not employed" named
  // Employed and nothing else, so the plain scan recorded Employed and the
  // NOT_EMPLOYED knockout never fired; "not monthly, every Friday" recorded Monthly
  // and declined a weekly earner on a converted figure they never gave.
  //
  // Bare "no" is deliberately not a negator here. "No, checking" and "no, monthly" are
  // ordinary answers where the no belongs to something else, and treating that leading
  // no as a negation would re-ask a caller who answered the question properly. Only
  // the not/n't family and "never" rule an option out.
  const NEGATOR = /\b(not|nt|cannot|isnt|arent|aint|dont|doesnt|didnt|wasnt|werent|never)\b/;
  const negated = (phrase) => {
    // Up to two words of lead-in, so "I am not employed" is caught and "I am employed"
    // is not. A negator inside the phrase itself ("not working", a real synonym for
    // Unemployed) never appears in the window, so those keep working.
    const m = raw.match(new RegExp(`((?:\\b[a-z0-9]+\\b ){0,2})\\b${esc(phrase)}\\b`));
    return !!m && NEGATOR.test(m[1]);
  };
  const hasWord = (phrase) => new RegExp(`\\b${esc(phrase)}\\b`).test(raw) && !negated(phrase);

  // Synonyms first, because a multi-word synonym often contains a bare option word:
  // "bi weekly" holds "weekly", "semi monthly" holds "monthly", "share draft" is a
  // checking account. Read as the contained option they recorded the wrong value; as
  // a synonym they map correctly.
  for (const [phrase, option] of Object.entries(synonyms)) {
    if (hasWord(phrase)) return option;
  }

  // Options actually named, keeping only the most specific: "self employed" contains
  // the word "employed", so Employed is dropped in favor of Self-employed rather than
  // counted as a second, conflicting option. Two distinct options named ("checking or
  // savings? checking") is ambiguous and re-asks.
  const present = options.filter((o) => hasWord(words(o).join(' ')));
  const maximal = present.filter((o) => {
    const k = ` ${words(o).join(' ')} `;
    return !present.some((o2) => o2 !== o && ` ${words(o2).join(' ')} `.includes(k));
  });
  if (maximal.length > 1) return null;
  if (maximal.length === 1) return maximal[0];
  return null;
}

// A person's name, cleaned of the lead-in. Returns null on an empty result.
// A caller who has just heard their name back wrong spells it, and what arrives is
// "j a e w o o, c h u n g". Joined blindly that is one word; left alone it is nine
// one-letter names. A run of two or more single letters is a spelled word, and the
// comma or the pause between first and last is what separates them. A lone initial
// ("J Robert Smith") is not a run, so it survives.
function joinSpelledRuns(text) {
  return String(text)
    .split(/[,;]|\band\b/i)
    .map((chunk) => {
      const parts = chunk.trim().split(/\s+/).filter(Boolean);
      const out = [];
      let run = [];
      const flush = () => {
        // Three or more single letters is someone spelling a name out
        // ("j a e w o o"). Two is a pair of initials ("J R" for J.R.), which must
        // stay apart or it joins to "Jr" and reads as the suffix Junior.
        if (run.length >= 3) out.push(run.join(''));
        else out.push(...run);
        run = [];
      };
      for (const p of parts) {
        if (/^[A-Za-z]$/.test(p)) run.push(p);
        else {
          flush();
          out.push(p);
        }
      }
      flush();
      return out.join(' ');
    })
    .join(' ');
}

function parseName(text) {
  const stripped = joinSpelledRuns(String(text == null ? '' : text))
    // Transcription writes a name in its native spelling — "María", "Álvarez".
    // NFD splits an accented letter into base letter plus mark; dropping the marks
    // keeps the letter. Without this the ASCII filter below turned í into a space
    // and María reached the record as "Mar A".
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // The filler at the end is not politeness, it is the whole answer sometimes:
    // asked for a first name, a caller who has stopped listening says "mmm", and a
    // three letter word with no meaning passed every length check a name has.
    .replace(
      /\b(my name is|my name's|this is|i'?m|it'?s|name'?s|speaking|full name is|umm*|uhh*|err*|ahh*|hmm+|mmm+|yeah|okay|ok)\b/gi,
      ' ',
    )
    .replace(/[^A-Za-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  return stripped.split(' ').map((w, i) => titleCaseName(w, i === 0)).join(' ');
}

// Title-case one name token without flattening the shapes real names carry. The old
// version lowercased everything after the first letter, which turned "III" into
// "Iii", "O'Brien" into "O'brien", "Smith-Jones" into "Smith-jones" and "McDonald"
// into "Mcdonald". A generational suffix stays upper; a letter after an apostrophe
// or a hyphen is capitalized; a token that already carries an internal capital is
// left as the caller said it.
function titleCaseName(w, isFirst) {
  if (!w) return w;
  // A generational suffix (III, IV) is only a suffix when it trails another name
  // word. Standing at the front it is an ordinary short name — "Vi", "Iv" — and must
  // title-case normally, not shout "VI".
  if (!isFirst && /^(?:ii|iii|iv|v|vi|vii|viii|ix|x)$/i.test(w)) return w.toUpperCase();
  const base = /[a-z][A-Z]/.test(w) ? w : w.toLowerCase();
  return base.replace(/(^|['’-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

module.exports = {
  words,
  spokenDigits,
  parseDate,
  ageOn,
  parseYesNo,
  saysStop,
  saysNone,
  parseAmount,
  perPaycheck,
  monthlyMultiplier,
  parseEmail,
  parseState,
  parseWeekday,
  parseDayOfMonth,
  parseEnum,
  parseName,
  STATE_CODES,
  PERIOD_TO_MONTHLY,
};
