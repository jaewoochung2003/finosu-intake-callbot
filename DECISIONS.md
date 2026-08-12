# Decisions

Every call that had a real alternative, and the reason for the one taken. Where a
decision reads against the brief, that is said plainly.

---

## Architecture

**The model has one tool and no lending rules.** It calls `save_answer` with what it
heard and gets the next question back. It never holds the field list, never holds
the five reject rules, and never sees a threshold. A model that holds the rules can
be argued out of them by a caller, and a model that holds the field order can drop a
field and never be caught doing it. The cost: every question is a round trip through
the server, so the bot cannot improvise a follow-up.

**Audio crosses untouched.** Twilio streams G.711 u-law at 8 kHz and OpenAI's
Realtime API takes and returns the same, so `bridge.js` copies bytes in both
directions with no resampling and no transcoding. Fewer parts, less delay. The cost:
there is no text transcript unless one is asked for separately, and nothing stores
that yet.

**Speech to speech rather than speech to text to model to speech.** A three-stage
pipeline gives a transcript for free and a slower call. For a form with 24 questions
the delay compounds on every turn. Reversible: the split between voice and
application is one function, `save_answer`, so a per-field deterministic flow could
replace the model for the digit questions without touching anything else.

---

## The screening block

**All five screening questions are asked, even after one has already failed.**
Stopping at the first bad answer would leave a declined application with four empty
screening fields. Two declines then have different shapes and cannot be compared to
each other, which makes the reject set look like data without being usable as data.
The cost: about twenty seconds of call time for an applicant who is already
declined.

**None of the five is acted on until all five have landed.** The block sits ahead of
the social security digits, the routing number and the account number, so an
applicant who will be declined never reads any of them down the phone. A lender
holding bank credentials for people it already turned down is a problem that has
nothing to do with this exercise and everything to do with running a lender.

**`EARLY_KNOCKOUT=0` asks all 24 questions and decides at the end.** That is the
literal reading of the brief and it is one environment variable. The decision is
identical either way; both paths are tested.

---

## Capture

**Income is asked as a figure and the brief's yes/no is computed from it.** The
brief's field is "if salary is over 2000 dollars a month". Storing the answer to
that and nothing else records today's threshold rather than the applicant's income,
and the day the threshold moves every stored application has to be collected again.
`INCOME_THRESHOLD` lives in `decision.js`; move it and every stored record re-decides
from the number it already holds. A caller who will not name a figure is asked the
yes/no after three tries, because a threshold answer beats an empty field.

**Amounts are converted to monthly before the comparison.** People answer in the
period they are paid in. Four hundred a week is 1,733 a month, not 1,600. At 480 a
week the two ways of working it out land on opposite sides of the line the brief
draws.

**The pay cycle is asked before the income figure, out of the brief's order.**
"Twelve hundred a paycheck" cannot be converted without knowing what a paycheck is.
Asking the cycle twelve questions later meant 1,200 every two weeks was recorded as
1,200 a month and the caller was declined at 2,600 a month. A figure with no period
stated is read as monthly, since that is what the question asked; converting an
unqualified answer by the pay cycle is the same bug in the other direction.

**The email address and the two bank numbers are read back before the next
question.** Fields carry a `confirm` flag which reaches the model as `read_back` in
the tool result. The flag existed for a while with nothing reading it, which meant
the read-back the design assumed was never happening.

**Exactly 2,000 declines.** The brief's field says "over 2000" and its rule says
reject "less than 2000". Those disagree at exactly 2,000. This follows the field.
One comparison in `decision.js` flips it. Worth confirming which was meant.

**The raw words are kept next to the normalized value.** "March fourth nineteen
ninety four" sits beside `1994-03-04`. A parse found to be wrong later can be re-run
against the raw string. A normalized value cannot be un-normalized. On the three
sensitive fields neither half is kept, only the digit count, since the application
record already holds the number once.

**Time per field, retry counts and the field the call stopped on are recorded during
the call.** They cannot be backfilled afterwards. Without them a drop-off cannot be
traced to the question that caused it.

**A revised answer keeps the original.** Someone who changes their income after
hearing the question a second time is a different applicant from someone who said it
once, and the final value alone does not carry that. `undoLast` writes the old value
to a correction log rather than dropping it, masked if the field was sensitive.

---

## Verification

**The routing number is checked three ways and the third is the one that matters.**
Nine digits with an issued prefix, then the ABA check digit, then a lookup against
the 18,198 routing numbers in the FedACH participant file. The check digit alone
passes nine random digits one time in ten, which is why a made-up number needs the
directory to catch it: `310000185` has a clean check digit and belongs to no bank.

**The directory is also read back to the caller.** Two real routing numbers that
differ by a transposition are both valid, and only the caller knows which one is
theirs. Saying the bank's name is what turns an honest slip into a correction.

**The account number is not verified and the README says so.** Account numbers carry
no check digit. Nothing computed from the digits separates a real account from a
plausible one; only the bank can, through a micro-deposit pair or an instant
verification provider, and that call happens after the phone call ends. What runs
here refuses the shapes that are never accounts: wrong length, one digit repeated, a
straight run, the routing number said twice, the social security digits said again.

**Keypad entry is offered on every digit field and skips speech recognition
entirely.** A misheard word in a routing number is a wrong bank account, not a typo.
Voice remains available because forcing the keypad turns a voice bot into a phone
tree.

---

## Outcomes

**Three outcomes, not two.** Approved means every rule was reachable and none fired.
Declined means at least one fired. Incomplete means the call ended before the rules
could be settled. A routing number nobody could capture leaves the record short, and
failing to hear someone is not the same as catching them; collapsing those two into
Declined would report a bad line as fraud.

**A field that will not validate after three tries is left empty.** Writing a guess
would make the record wrong in a way nothing downstream can detect. Leaving it empty
makes the outcome Incomplete, which is recoverable.

**Every firing rule is kept, not the first one.** An applicant who is unemployed,
under the income line and on assistance failed for three reasons.

**Every decision carries a `policy_version`.** Without it there is no way to tell
later which rules an old application actually faced, so "would this decline still be
a decline" has no answer.

**The caller is told the outcome and not the reason.** The bot says it cannot move
forward and that an email is coming. Reason codes go in the record. Reading a decline
reason down the phone is a call for whoever owns compliance, not for the bot.

**Retired and Student do not trip `NOT_EMPLOYED`.** The brief says "unemployed", so
only `Unemployed` fires it. A retiree with a pension over 2,000 a month is approved.
If that is wrong it is one line.

---

## Delivery

**The email is the API call.** It carries the decision and reason codes, the form as
`Label: value` lines in the brief's own order and wording, and the JSON that would be
POSTed. The same JSON is written to `calls/<callSid>.json`.

**The brief's 24 lines stay exactly 24.** Anything captured beyond the form, the
income figure and the matched bank name, prints under a separate heading.

**Sensitive values appear in the email in full.** The brief asked for all the data
filled out and the email stands in for the API call. In production the email would
carry an application id and the numbers would go only to the underwriting endpoint.
The transcript and the capture record already mask them.

---

## Known gaps

These are open, not decided.

1. **No inactivity timer.** A caller who puts the phone down to find their routing
   number leaves the OpenAI socket open and billing, and hears nothing. Agreed
   design, roughly 25 lines in `bridge.js`: one clock, reset by any sound from
   either side, suspended while a keypad entry is part-typed, started when Twilio
   finishes *playing* the question rather than when the audio is sent.

   Nudge at 10 seconds. Hang up at 45 only if the caller has made no sound at all
   since the nudge; if they made any sound, the deadline moves to 5 minutes. The
   nudge is a test for whether a person is on the line, not a nag: someone hunting
   for a paper statement says "hang on", and that noise buys them the long window.

   **These numbers are not settled and should be tuned against real calls.** They
   are reasoned, not measured. The per-field timings in `capture_metrics` are the
   measurement: after a few dozen calls the threshold should come from a percentile
   of observed time-to-answer per field, since "what is your name" and "read me your
   account number" are not the same wait. Both values live in `.env`
   (`SILENCE_NUDGE_MS`, `SILENCE_HANGUP_MS`) so moving them is not a code change.
2. **No human handoff.** The prompt lets a caller ask for a person and `end_call`
   ends the application. There is no `<Dial>` leg because there is no number to dial.
3. **No call-back resume.** A four-minute call that drops at question 20 starts over
   at question 1.
4. **Nothing has run against a live OpenAI Realtime session.** The session
   configuration, the audio format objects and the function-call event names are
   written from the documentation. `test/bridge.test.js` drives the whole state
   machine with fake sockets carrying the documented message shapes, which covers
   the logic but proves nothing about the shapes themselves. One real call settles
   it.
5. **No transcript is stored.** Transcription is enabled in the session config and
   nothing keeps the output, so there is no record of what the caller actually said
   next to what was captured.
