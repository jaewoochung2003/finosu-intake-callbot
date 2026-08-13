# Decisions

Every call that had a real alternative, with the reason for the one I took. Where a
decision reads against the brief, I say so.

---

## Architecture

**The model has one tool and no lending rules.** It calls `save_answer` with what it
heard and gets the next question back in the tool result. It never holds the field list,
never holds the five reject rules and never sees a threshold. A caller can argue a model
out of a rule it holds; a model holding the field order can drop a field with nothing to
catch it. The cost is that every question is a round trip through the server, so the bot
cannot improvise a follow-up.

**Audio crosses untouched.** The carrier streams G.711 u-law at 8 kHz and the Realtime
API takes and returns the same, so `bridge.js` copies bytes in both directions with no
resampling and no transcoding, which is fewer parts and less delay. The cost is that
there is no text transcript unless one is asked for separately and nothing stores that
yet.

**Speech to speech rather than speech to text to model to speech.** A three-stage
pipeline gives a transcript for free and a slower call. For a form with 24 questions the
delay compounds on every turn. This is reversible, since the split between voice and
application is one function: a per-field deterministic flow could replace the model for
the digit questions without touching anything else.

---

## The screening block

**All five screening questions get asked, even after one has already failed.** Stopping
at the first bad answer leaves a declined application with four empty screening fields,
so two declines come out with different shapes and cannot be compared against each
other. The cost is about twenty seconds of call time for an applicant who is already
declined.

**None of the five gets acted on until all five have landed.** The block runs ahead of
the social security digits, the routing number and the account number, so an applicant
who will be declined never reads any of them down the phone. Holding bank credentials
for people you already turned down is a problem worth avoiding whatever the brief says.

**`EARLY_KNOCKOUT=0` asks all 24 questions and decides at the end.** That is the literal
reading of the brief and it is one environment variable. The decision is identical
either way and both paths are tested.

---

## Capture

**Income is asked as a figure and the brief's yes/no is computed from it.** The brief's
field is "if salary is over 2000 dollars a month". Storing the answer to that and
nothing else records today's threshold rather than the applicant's income, so the day
the threshold moves every stored application has to be collected again.
`INCOME_THRESHOLD` lives in `decision.js`; move it and every stored record re-decides
from the number it already holds. A caller who will not name a figure gets the yes/no
after three tries, since a threshold answer beats an empty field.

**Amounts are converted to monthly before the comparison.** People answer in the period
they are paid in. Four hundred a week is 1,733 a month rather than 1,600. At 480 a week
the two ways of working it out land on opposite sides of the line the brief draws.

**The pay cycle is asked before the income figure, out of the brief's order.** "Twelve
hundred a paycheck" cannot be converted without knowing what a paycheck is. Asking the
cycle twelve questions later recorded 1,200 every two weeks as 1,200 a month and
declined a caller earning 2,600 a month. A figure with no period stated is read as
monthly, since that is what the question asked. Converting an unqualified answer by the
pay cycle is the same bug in the other direction.

**The email address and the two bank numbers are read back before the next question.**
Fields carry a `confirm` flag which reaches the model as `read_back` in the tool result.
The flag existed for a while with nothing reading it, so the read-back the design
assumed was never happening.

**Exactly 2,000 approves.** The brief's field says "over 2000" and its rule says reject
"less than 2000", which disagree at exactly 2,000. I followed the reject rule, since
2,000 is not less than 2,000 and refusing someone the reject rule does not name is the
error you cannot defend to them. One comparison in `decision.js` (`<` to `<=`) flips it
to follow the field instead.

**The raw words are kept next to the normalized value.** "March fourth nineteen ninety
four" sits beside `1994-03-04`, so a parse found to be wrong later can be re-run against
the raw string while a normalized value cannot be un-normalized. On the three sensitive
fields I keep neither half, only the digit count, since the application record already
holds the number once.

**Time per field, retry counts and the field the call stopped on are recorded during the
call**, because they cannot be backfilled afterwards. Without them a drop-off cannot be
traced to the question that caused it.

**A revised answer keeps the original.** Someone who changes their income after hearing
the question a second time is a different applicant from someone who said it once and
the final value alone does not carry that, so I write the old value to a correction log
rather than dropping it, masked if the field was sensitive.

---

## Verification

**The routing number is checked three ways.** Nine digits with an issued prefix, then
the ABA check digit, then a lookup against the 18,198 routing numbers in the FedACH
participant file. The check digit alone passes nine random digits one time in ten, which
is why a made-up number needs the directory lookup to refuse it: `310000185` has a clean
check digit and belongs to no bank.

**The directory is also read back to the caller.** Two real routing numbers differing by
a transposition are both valid and only the caller knows which one is theirs, so saying
the bank's name back gives them the chance to catch the slip.

**The account number is not verified and the README says so.** Account numbers carry no
check digit, so nothing computed from the digits separates a real account from a
plausible one. Only the bank can, through a micro-deposit pair or an instant
verification provider, which happens after the phone call ends. What runs here refuses
the shapes that are never accounts: wrong length, one digit repeated, a straight run,
the routing number said twice, the social security digits said again.

**Keypad entry is offered on every digit field and skips speech recognition entirely.**
A misheard word in a routing number is a wrong bank account rather than a typo. Voice
stays available because forcing the keypad turns a voice bot into a phone tree.

---

## Outcomes

**There are three outcomes.** Approved means every rule was reachable and none fired,
Declined means at least one fired and Incomplete means the call ended before the rules
could be settled. A routing number nobody could capture leaves the record short and
collapsing that into Declined would report a bad phone line as fraud.

**A field that will not validate after three tries is left empty.** Writing a guess
makes the record wrong in a way nothing downstream can detect, while leaving it empty
makes the outcome Incomplete, which is recoverable.

**Approved also requires the identity and address fields.** The five rules only cover
seven fields, so a caller who cleared them and then hung up before the address block
used to come out Approved over blank lines. A missing name, email, birthday, social or
address field now forces Incomplete instead.

**Every firing rule is kept rather than only the first.** An applicant who is
unemployed, under the income line and on assistance failed for three reasons.

**Every decision carries a `policy_version`.** Without it there is no way to tell later
which rules an old application actually faced, so "would this decline still be a
decline" has no answer.

**The caller is told the outcome and not the reason.** The bot says it cannot move
forward and that an email is coming, with reason codes going in the record. Reading a
decline reason down the phone is a call for whoever owns compliance.

**Retired and Student do not trip `NOT_EMPLOYED`.** The brief says "unemployed", so only
`Unemployed` fires it and a retiree with a pension over 2,000 a month is approved. If
that is wrong it is one line.

---

## Delivery

**The email carries what the API call would carry**: the decision and reason codes, the
form as `Label: value` lines in the brief's own order and wording, then the JSON that
would be POSTed. The same JSON is written to `calls/<callSid>.json`. A stored record
replays through `decide()` to the outcome it already holds.

**The brief's 24 lines stay exactly 24.** Anything captured beyond the form, meaning the
income figure and the matched bank name, prints under a separate heading.

**Sensitive values appear in the email in full.** The brief asked for all the data
filled out and the email stands in for the API call. In production the email would carry
an application id and the numbers would go only to the underwriting endpoint. The
transcript and the capture record already mask them.

---

## Known gaps

These are open rather than decided.

1. **The quiet-line timers are reasoned rather than measured.** The timer itself is in:
   20 seconds of quiet gets one "are you still there?", 50 ends the call with a goodbye
   and emails the form so far as Incomplete. A keypad press counts as activity, so nobody is hung up on mid-entry. What stays open is the numbers, which are constants in
   `bridge.js` (`QUIET_NUDGE_MS`, `QUIET_END_MS`). After a few dozen calls they should
   come from a percentile of the observed time-to-answer per field in `capture_metrics`,
   since "what is your name" and "read me your account number" are not the same wait.
2. **A caller correcting an answer more than one question back cannot be handled.**
   `redo_previous` steps back exactly one field, so a late "actually I make 4,000" gets
   filed as the answer to whatever was just asked. Fixing it needs a field-addressable
   correction tool and a matching instruction to the model.
3. **No human handoff.** The prompt lets a caller ask for a person and `end_call` ends
   the application. There is no `<Dial>` leg because there is no number to dial.
4. **No call-back resume.** A four-minute call that drops at question 20 starts over at
   question 1. There is also no dedup across calls, so the same applicant calling twice
   produces two applications; deduping belongs downstream on name, social and routing
   number, all of which the payload carries.
5. **Live coverage is thin.** Real calls have run end to end and most of the bugs they found were things no stubbed test could reach: the model's exact phrasing,
   transcription artifacts, a line that goes quiet, an accented transcription of a name.
   Two calls at once have run, each keeping its own state with both records written. Two
   paths have still never run against a live session: a caller who answers a spoken
   confirmation by typing on the keypad instead of speaking and the give-up path meeting the knockout path outside the canned scripts.
6. **No transcript is stored.** Transcription is enabled in the session config and nothing
   keeps the output, so there is no record of what the caller actually said next to what
   was captured.
