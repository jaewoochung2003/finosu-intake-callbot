# Decisions

One entry for every call where I had a real alternative, with the reason I took the one I
took and what it costs. Where a decision reads against the brief, I say so. Where I
reversed myself, the old decision stays in the log with the reason it did not survive,
since the reversals are the part that is hard to reconstruct later.

Entries are grouped by area and numbered inside it, so a new one appends without
renumbering anything. Each carries the date I settled it and the file it lives in.
Status is **standing**, **reversed** or **open**.

Timeline: I built an outbound bot first (7 Aug), started this inbound intake bot on
12 Aug, ran live calls through it on 12 and 13 Aug, ran six adversarial rounds against
the offline harness on the morning of 13 Aug, then took the voice off the model on the
evening of 13 Aug after a run of live calls none of which could be finished. Counts as of
13 Aug: 399 checks, 20 canned scripts, 30 ordinary calls end to end.

---

## A. Architecture

**A1. I keep the lending rules and the field order out of the model.** *12 Aug,
standing, `intake.js` / `decision.js`.*
The model never holds the field list, never holds the five reject rules and never sees the
2,000 threshold. A caller can argue a model out of a rule it holds, while a model holding
the field order can drop a field with nothing behind it to catch the gap. The cost is a
round trip through the server for every question, so the bot cannot improvise a follow-up.
This is also why prompt injection has nothing to reach: there is no tool that sets a
decision, a destination or a field. A10 took the rest away as well.

**A2. The model has three tools and only one of them writes to the form.** *12 Aug,
reversed 13 Aug by A10, `agent.js`.*
`save_answer` writes. `redo_previous` steps back. `end_call` hangs up. Both of the other
two now require the caller's own words as an argument, for the reason in G4.

**A3. I run the call speech to speech rather than speech to text to model to speech.**
*12 Aug, reversed 13 Aug by A10, `bridge.js`.*
A three-stage pipeline gives a transcript for free and a slower call; the delay
compounds on every one of 24 turns. The split between voice and application is one
function, so a per-field deterministic flow could replace the model on the digit
questions without touching anything else. What it costs shows up in G1 and in R1: the
model files an answer the moment it hears the audio, before any transcript of that audio
exists.

**A4. Audio crosses untouched.** *12 Aug, reversed 13 Aug by A12, `bridge.js`.*
The carrier streams G.711 u-law at 8 kHz and the Realtime API takes and returns the same,
so I copy bytes in both directions with no resampling and no transcoding. Fewer parts,
less delay. The cost is that there is no text transcript unless I ask for one separately,
which I have not stored (see O6).

**A5. I play only the lines I wrote.** *13 Aug, superseded 13 Aug by A10, `bridge.js`.*
Server VAD creates a response on its own when the caller stops talking. The tool call
rides inside it, while the model also says whatever it likes in that response because
nobody has handed it a line yet. Then the tool result comes back and `speak()` creates a
second response carrying the line I actually wrote, so the caller heard two bot turns
back to back, the second answering a question the first had already moved past. The
automatic response cannot be turned off. Its audio simply is not played: `speak()` claims
the next response id and only audio carrying a claimed id reaches the carrier. Every
muted line is counted and logged so it is visible rather than mysterious. An event with no
response id still passes, which is what the fake sockets in the tests drive. The first
version of this gate also passed everything through while no response was being tracked,
which I added as a hedge for the tests; a response id leaves the tracked set the moment
that response finishes, so the automatic response landed squarely in the gap between one
line ending and the next being asked for. That hedge is gone. All of this defends against a model that has a turn, which A10 took
away a few hours later; the gate is still in the older bridge and nothing needs it now.

**A6. I use one dependency, `ws`, with no web framework.** *12 Aug, standing, `package.json`.*
Node 18 or newer serves the three routes and the WebSocket upgrade without help. Nothing
here needs a router.

**A7. The carrier is swappable, so I ran the live calls on SignalWire.**
*13 Aug, standing, `server.js` / `tools/signalwire-setup.js`.*
A Twilio trial account strips `<Stream>`, so a trial number fetches the TwiML and then
hangs up before the audio socket opens; the caller hears that the verb is not available
and the line goes dead. The two carriers disagree about two markup attributes and nothing
else, so `CARRIER` in `.env` covers the difference and `carrier.test.js` covers both
shapes.

**A8. I send the finished application through the Gmail API rather than SMTP.** *12 Aug,
standing, `email.js`.*
An OAuth refresh token with a send scope, checked by `npm run preflight`.

**A9. I built an outbound identity-gate bot first and superseded it.** *7 Aug, superseded
12 Aug, `../outbound-callbot-superseded/`.*
That one placed a call, matched name, date of birth and last four of social against a
record and only then read a message about a missed payment. The payload string lived in
`verify.js` and was returned by one function that gave back null until all three fields
matched, so no prompt, no model context and no speech call ever saw the string early: a
model that gets talked into saying it cannot, because it was never handed it. That is the
same principle as A1 and it is what carried over. **I have not written down why the
exercise moved from outbound to inbound.** Fill that in here.

---

**A10. I took the voice off the model. It listens; I speak.** *13 Aug, standing,
`voice.js` / `bridge-voice.js`.*
This reverses A2 and A3 and is the largest thing in the log. Under A3 the model spoke the
lines I wrote and filed answers through a tool. Over an evening of live calls it
reworded lines, dropped the question off the end of a read-back so the caller was never
asked anything, said sentences I had not written, skipped a question and left the caller
in silence, then answered its own yes-or-no question before the caller had made a sound.
I fenced off each one and the next appeared. None of them was disobedience: a model
handed a turn produces a plausible continuation of the conversation; after "is that
right?" the plausible continuation is "yes", so from inside the turn there is no
difference between hearing an answer and an answer belonging there. No wording in the
prompt separates those two, which is why the fences kept failing somewhere new.

So the model gets no turn. Its session carries no tools, no voice and
`create_response: false`, which is the line that stops the API opening a turn for it every
time the caller stops talking. A transcript comes back, I run it through `intake.submit`
and I turn the next line into audio myself. Four things stop being possible rather than
being defended against: a line cannot be reworded or cut short, a question cannot be
skipped, an answer cannot be invented because no tool exists to invent one with, then the
turn cannot be taken early because the microphone stays shut until the carrier reports the
last frame played.

It costs the transcript round trip A3 was avoiding, about half a second before each line,
and barge-in. The old bridge is still in the tree behind `KEYPAD=on` because it is the
only path that takes touch tones.

**A11. The two kinds of line go to different speech models.** *13 Aug, standing,
`voice.js`.*
`tts-1` reads text quickly and takes no instruction about how, which is right for a
question and wrong for a read-back: given "j o e" it reads three characters at the speed
it reads any others, while turning the speed down stretches each letter rather than pushing
them apart. `gpt-4o-mini-tts` takes an instruction, so I can tell it the line is a
spelling, so the same line runs 9.15 seconds against 4.96. The characters are separated
by commas, since a comma is punctuation a speech model interprets rather than punctuation
it might read out loud. I tried three dots first and they are worse than either.

**A12. I convert the speech to the telephone's format myself.** *13 Aug, standing,
`voice.js`.*
The speech endpoint returns 24 kHz signed 16-bit samples and a phone line carries 8 kHz
G.711 u-law in 20 ms frames, so a filter and a rate change sit between them. Averaging
every three samples was the first version and it left the 4 to 8 kHz band in place to
fold back down into speech as a hiss, so it is a 48-tap windowed sinc at 3.4 kHz now.
Frames go to the carrier 400 ms at a time; one frame per message with a mark behind each
is a hundred messages a second and the carrier stutters on the bookkeeping. The streaming
resampler keeps every leftover sample across chunk boundaries, which it did not at first,
and the test that catches that feeds it deliberately ragged pieces and requires the output
to match processing the whole buffer byte for byte.

## B. The call script

**B1. I ask the brief's 24 fields in a different order from the one it lists them in.**
*12 Aug, standing, `fields.js` (`FIELDS` for the asking order, `FORM_ORDER` for the
printed one).*
The order I ask in is who is calling, then the five screening questions plus the pay
cycle, then the three sensitive numbers, then everything that sits on the form without
feeding a rule. The printed form stays in the brief's order and wording, because the two
orders answer different questions and neither should bend to the other.

**B2. I ask all five screening questions before acting on any of them.** *12 Aug,
standing, `intake.js`.*
Stopping at the first bad answer leaves a declined application with four empty screening
fields, so two declines come out with different shapes and cannot be compared against
each other. The cost is about twenty seconds of call time for somebody who is already
declined.

**B3. The whole screening block runs ahead of every sensitive field.** *12 Aug, standing,
`fields.js`.*
An applicant who is going to be declined never reads a social security number or a bank
account down the phone. Holding bank credentials for people I already turned down is
worth avoiding whatever the brief says.

**B4. `EARLY_KNOCKOUT=0` asks all 24 questions and decides at the end.** *12 Aug,
standing, `.env`.*
That is the literal reading of the brief and it is one environment variable. Both paths
are tested and the decision is identical either way.

**B5. I ask the pay cycle before the income figure, out of the brief's order.** *12 Aug,
standing, `fields.js`.*
"Twelve hundred a paycheck" cannot be converted without knowing what a paycheck is. When
the cycle sat twelve questions later, 1,200 every two weeks went in as 1,200 a month and
a caller earning 2,600 a month was declined.

**B6. The pay-day question sits next to the cadence question, not in the employer block.**
*13 Aug, standing, `fields.js`.*
It used to follow "are you in a particular department?" and ask "which day does that land
on?", with nothing in earshot for "that" to mean. A caller asked what it meant. The
cadence answer also decides which of the two pay-day questions applies, so they belong
together.

**B7. The bot speaks like a person: a greeting, contractions, varied acknowledgements,
varied retry lines.** *13 Aug, standing, `fields.js` / `agent.js`.*
The first script read like a form being filled in and callers treated it like one.

---

## C. What I capture and how

**C1. Four questions take the keypad and nothing else.** *13 Aug, standing, supersedes
C2, `fields.js`.*
Speech recognition on a phone line turns a nine digit routing number into a different
bank; every parser I wrote to rescue digits out of words has been a source of wrong
records. So the last four of social, the routing number, the account number and the zip
take the keypad only. The question says so outright: "Type the nine digit routing
number on your keypad." A spoken answer on one of these is not parsed at all; it comes
back with "I need that on the keypad" and the question again. The read-back after the
number is still spoken, since a yes is a word.

**C2. Keypad entry is offered on every digit field, with voice still available.**
*12 Aug, reversed 13 Aug by C1.*
The reasoning was that forcing the keypad turns a voice bot into a phone tree. Six rounds
of adversarial testing and 22 live calls said the trade runs the other way on the four
fields where a misheard digit is a wrong bank account rather than a typo. Voice still
works on every other digit field, including the phone numbers and the date of birth.

**C3. The date of birth takes eight keypad digits as the escape from a bad line.**
*13 Aug, standing, `fields.js`.*
06281990. Every spoken form that worked before still works.

**C4. I ask for the whole date of birth every time rather than keeping the half I got.**
*13 Aug, standing, `fields.js` / `parse.js`.*
The question used to take whatever arrived and ask for the missing piece, so each attempt
depended on the one before it while nothing carried between them. On a live call that
cost three turns and still lost a date the caller had said correctly twice. An attempt
now stands on its own, so a bad turn costs one turn.

**C5. After three attempts I leave the field empty.** *12 Aug, standing, `intake.js`
(`MAX_ATTEMPTS = 3`).*
Writing a guess makes the record wrong in a way nothing downstream can detect. An empty
field makes the outcome Incomplete, which is recoverable.

**C6. I keep the raw words next to the normalized value, except on the sensitive
fields.** *12 Aug, standing, `intake.js`.*
"March fourth nineteen ninety four" sits beside `1994-03-04`, so a parse I find to be
wrong later can be re-run against the raw string, while a normalized value cannot be
un-normalized. On the three sensitive fields I keep neither half, only the digit count,
since the application record already holds the number once.

**C7. I record time per field, retry counts and the field the call stopped on during the
call.** *12 Aug, standing, `intake.js`.*
None of it can be backfilled afterwards; without it a drop-off cannot be traced to
the question that caused it.

**C8. A revised answer keeps the original.** *12 Aug, standing, `intake.js`.*
Somebody who changes their income after hearing the question a second time is a different
applicant from somebody who said it once; the final value alone does not carry that.
The old value goes to a correction log, masked if the field was sensitive. Both the
`redo_previous` path and the read-back correction path write to it; for a while only the
first did, which meant the audit trail missed its most common path.

**C9. The email address, both bank numbers, the name, the date of birth and the income
figure are read back before the next question.** *12 Aug, extended 13 Aug, standing,
`fields.js` (`confirm`) / `bridge.js`.*
The `confirm` flag existed from the first commit with nothing reading it, so the read-back
the design assumed was never happening. The income read-back matters most: a misheard
3,000 declined a caller at the exact-2,000 boundary with no way for them to hear it.

**C10. An answer given at a read-back only ever goes to `save_answer`.** *13 Aug,
standing, `agent.js` / `intake.js`.*
I know which question is open and which fields it covered; the model does not. A
read-back answer that is not a recognized yes or no used to be taken as the new value, so
"is that right?" could overwrite the thing it was asking about; "bingo", "aye" and
"that's spelled right" all became surnames. Widening the list of agreement phrases does
not close that. A field whose validator accepts almost any words now needs the caller to
have said no or marked a correction; a bare name at a two-part read-back rewinds to
the spelling question rather than guessing which half it belonged to.

**C11. A closed question takes one of its own answers and nothing else.** *13 Aug,
standing, supersedes C12, `parse.js` (`parseEnum`).*
Past the synonym table, any answer carrying a negative is re-asked with the choices
named. Every negative answer I do accept is written down by hand in the synonym table,
which `parseEnum` reads first: "not working", "not employed", "no longer employed" and
"out of work" all mean Unemployed because the table says so, not because anything infers
it. Adding one is a line in a list. The cost is a turn for "no, checking", which now
re-asks. That is the trade: a closed question can cost an extra turn and can no
longer record the opposite of what the caller said.

**C12. `parseEnum` worked out which option a negation ruled out.** *12 Aug, reversed
13 Aug by C11.*
It used a two-word window before the option word. Every version of it was wrong
somewhere. "I'm not employed" was caught; "I am no longer employed" recorded Employed, so
`NOT_EMPLOYED` never fired and the caller was approved. "I do not have a savings account"
recorded Savings and declined a caller who only has checking. Widening the window trades
one wrong answer for another, because the caller is not choosing an option in either
sentence.

**C13. A free-text answer made only of conversation words is a re-ask.** *13 Aug,
standing, `validate.js`.*
"Who do you work for?" got "What?" back and wrote it in as the employer, because any two
characters clear the length check. Nobody works for "What", lives in "Huh" or is in the
"Sorry" department.

**C14. A bare yes to a question that wants a value asks for the value.** *13 Aug,
standing, `validate.js`.*
Four questions have this shape. "Do you want texts going to a different number?" is a
yes/no question, so the caller answered yes. The bot came back with "I need a phone
number, ten digits" against a question that had never asked for one. On the free-text
ones the bare yes validated, so "yes" was written in as the apartment number. Bare is the
point: "yes, 240 278 6143" carries the number and goes to the real validator untouched.

**C15. "I don't know" is not a No.** *13 Aug, standing, `parse.js`.*
It carries a negation word, so the leading-word scan settled a screening rule from an
answer the caller never gave. A hedged no ("probably not") is still a no; not being able
to answer re-asks.

**C16. I convert every amount to monthly before comparing and read a period-less figure
as monthly.** *12 Aug, standing, `parse.js`.*
People answer in the period they are paid in. Four hundred a week is 1,733 a month rather
than 1,600; at 480 a week the two ways of working it out land on opposite sides of
the line the brief draws. A figure with no period stated is read as monthly because that
is what the question asked; converting an unqualified answer by the pay cycle is the same
bug in the other direction.

**C17. An hourly or daily rate re-asks instead of being converted.** *13 Aug, standing,
`parse.js`.*
The form never asks how many hours anyone works; 200 a day is 4,340 a month on work
days against 6,000 on calendar days. Before this, an hourly rate with any other period
word attached took that period's multiplier and applied it to the rate, so "twenty
dollars an hour a week" was recorded as 87 dollars a month.

**C18. Anything I cannot convert without inventing a number re-asks.** *13 Aug, standing,
`parse.js`.*
A range ("between 1500 and 4000") used to sum to a figure nobody said. "A few grand"
defaulted to 1,000. Lakh, crore, million and billion collapsed to their leading digit.
Distributive phrasing ("two jobs, 1500 from each") recorded 1502. A spoken "point"
decimal fabricated a figure. Each of those now re-asks, except the scale words, which are
in the table.

---

## D. Rules and outcomes

**D1. Each reject rule is a function of the record with no model in it.** *12 Aug,
standing, `decision.js`.*
`decide()` reads the stored record and nothing else. It does read the FedACH file, so it
is not free of I/O, but there is no network call and no model.

**D2. There are three outcomes, not two.** *12 Aug, standing, `decision.js`.*
Approved means every rule was reachable and none fired. Declined means at least one
fired. Incomplete means the call ended before the rules could be settled. A routing
number nobody could capture leaves the record short; collapsing that into Declined
reports a bad phone line as fraud.

**D3. Approved also requires the identity and address fields.** *13 Aug, standing,
`decision.js` (`REQUIRED_FIELDS`).*
The rules cover seven of the 24 fields, so a caller who cleared them and hung up before
the address block used to come out Approved over blank lines with an empty "not captured"
line beneath it, so nothing on the form said anything was missing. A missing name, email,
birthday, social or address field now forces Incomplete. The name is checked as a joined
pair, since giving up on the first name left the surname standing and that is a value.
Employer name and address are in the set too, carrying "N/A" for an unemployed applicant
so that path decides the same way.

**D4. I keep every firing rule rather than only the first.** *12 Aug, standing,
`decision.js`.*
An applicant who is unemployed, under the income line and on assistance failed for three
reasons.

**D5. Every decision carries a `policy_version`.** *12 Aug, standing, `decision.js`.*
Without it there is no way to tell later which rules an old application actually faced,
so "would this decline still be a decline" has no answer. Two records in `calls/` predate
the current version and replay to today's answer, which is what the stamp is for. It pins
the rules by label only; no rule snapshot is stored.

**D6. The caller hears the outcome without the reason.** *12 Aug, standing, `fields.js`.*
The bot says it cannot move forward and that an email is coming. Reason codes go in the
record. Reading a decline reason down the phone is a call for whoever owns compliance.

**D7. Exactly 2,000 is approved.** *12 Aug, standing, `decision.js`.*
The brief's field says "over 2000" and its rule says reject "less than 2000", which
disagree at exactly 2,000. I followed the reject rule, since 2,000 is not less than 2,000
and refusing somebody the reject rule does not name is the error you cannot defend to
them. Following the field instead means moving three comparisons together, `<` to `<=` in
`decision.js` and `>=` to `>` in `fields.js` and `validate.js`, or the emailed form
contradicts the decision at exactly 2,000.

**D8. I ask income as a figure and derive the brief's yes/no from it.** *12 Aug,
standing, `fields.js` / `decision.js`.*
The brief's field is "if salary is over 2000 dollars a month", so storing the answer to
that records today's threshold rather than the applicant's income; the day the
threshold moves every stored application has to be collected again. Move
`INCOME_THRESHOLD` and every stored record is decided again from the number it already
holds. A caller who will not name a figure gets the yes/no after three tries, since a
threshold answer beats an empty field.

**D9. Retired does not trip `NOT_EMPLOYED`. Student is no longer a status.** *12 Aug,
amended 13 Aug, `decision.js` / `fields.js`.*
The brief says "unemployed", so only Unemployed fires it and a retiree with a pension over
2,000 a month is approved. If that is wrong it is one line.

Student came off the list on 13 Aug after a live call. A student has no income and no pay
cycle behind the status, so the four cadences did not fit and the way out was finding the
wording that meant "none". What it produced was Student with an empty cadence and no wage,
which is what Unemployed already means and already handles: the pay, income and employer
questions skip, the income slots fill with zero and the decision is the same either way. A
student with a job answers with the job and lands on Employed, which is the case the
option existed for and is better served by the question than by an option.

**D10. Under-18 is a rule in `decision.js`, not only a check in intake.** *13 Aug,
standing, `decision.js`.*
While the check lived only in intake, `decide()` over the stored record found no rule for
it and returned Incomplete with no reason, on the outcome whose reason is least
negotiable. A future date of birth re-asks as a mis-hear instead of declining a minor.

**D11. Two of the seven reject codes are mine, not the brief's.** *12 Aug, standing,
`decision.js`.*
`BANK_ROUTING_INVALID` and `BANK_ACCOUNT_INVALID` come out of the fraud check. The other
five are the brief's.

**D12. "Semiweekly" is stored as the brief spells it and converted as twice a month.**
*12 Aug, standing, `fields.js`.*
A caller saying "twice a month" or "semimonthly" lands on the same value. "Twice a week"
does not fold in, since that mistake converted a twice-weekly paycheck at half the real
figure.

---

## E. What I verify

**E1. I check the routing number four ways.** *12 Aug, extended 13 Aug, standing,
`validate.js`.*
Nine digits with a prefix that was actually issued, then the ABA check digit, then a
lookup against the 18,198 routing numbers in the Federal Reserve's FedACH participant
file, then the name that comes back. Nine random digits pass the check digit alone one
time in ten, so a made-up number fails only at the directory lookup: `310000185` has a
clean check digit and belongs to no bank. The fourth check refuses a number whose FedACH
name is a Reserve Bank, since the file lists those too and no consumer holds an account
there; the test number `011000015` was being read back as "that's Federal Reserve Bank"
before an Approved.

**E2. The bot reads the bank's name back.** *12 Aug, standing, `bridge.js`.*
Two real routing numbers differing by a transposition are both valid and only the caller
knows which one is theirs.

**E3. A failed read of the FedACH file is not cached.** *13 Aug, standing, `validate.js`.*
One transient unreadable file used to latch the whole process into checksum-only mode,
dropping the directory check silently for every later call. It retries on the next call.

**E4. I do not verify the account number and I say so.** *12 Aug, standing,
`validate.js`.*
An account number carries no check digit, so nothing computed from the digits separates a
real account from a plausible one. Only the bank can settle it, through a micro-deposit
pair or an instant verification provider, which happens after the phone call ends. What I
refuse here are the shapes that are never accounts: wrong length, one digit repeated, a
straight run including the 9-to-0 wrap, the routing number said twice, the social
security digits said again. A grader will try a fabricated account over a real routing
number and it will come out Approved. The answer is that routing is verified against
FedACH and the account can only be verified after the call, so the record carries it and
the decision is approved pending account verification in spirit. Stamping that on the
outcome, or adding `account_verified: false` to the payload, is open (see O3).

---

## F. What I deliver

**F1. The email carries what the API call would carry.** *12 Aug, standing, `format.js` /
`email.js`.*
The decision and reason codes, the form as `Label: value` lines in the brief's own order
and wording, then the JSON that would be POSTed to an underwriting endpoint.

**F2. The same JSON is on disk at `calls/<callSid>.json` and replays through `decide()`.**
*12 Aug, standing, `intake.js` / `decision.js`.*
A stored record reproduces the outcome it holds under the `policy_version` stamped on it.

**F3. `rehydrate()` flattens the stored payload before `decide()` reads it.** *13 Aug,
standing, `decision.js`.*
`decide()` reads flat keys and the stored record is the nested payload, so replaying a
stored call returned Incomplete for every record. That is the exact replay the brief asks
for and it was broken until the last red-team round found it.

**F4. The brief's 24 lines stay exactly 24.** *12 Aug, standing, `format.js`.*
Anything captured beyond the form, meaning the income figure and the matched bank name,
prints under a separate heading.

**F5. Sensitive values appear in the email in full and nowhere else.** *12 Aug,
standing, `format.js` / `bridge.js`.*
The brief asked for all the data filled out and the email stands in for the API call. In
production the email would carry an application id and the numbers would go only to the
underwriting endpoint. The capture record masks them and so does the server log, where
the bot's own spoken line was printing routing and account numbers in the clear.

---

## G. Turn taking, the keypad and the line

**G1. The mic opens 100 ms before the line finishes playing.** *13 Aug, standing,
`bridge.js` (`MIC_LEAD_MS`).*
The mic used to be held shut until the carrier reported the final chunk had played, so it
opened at the exact moment the line ended. People answer on the last syllable; an
answer starting a fraction early was clipped at the front or lost outright, leaving the
caller repeating themselves into a bot that had already moved on. I track
outstanding audio rather than chunks, where 100 ms at 8 kHz u-law is 800 bytes. Raise it
and the bot starts hearing its own tail on a speakerphone; set it to 0 for the old
behaviour. The barge-in guard reads the same queue, so the bot still cannot be
interrupted by its own voice.

**G2. A keypress silences the line in flight rather than cancelling it.** *13 Aug,
standing, `bridge.js`.*
The model treats a cancelled response as being cut off and writes itself a recovery line,
so a caller who started typing before the question finished got a pile-up of three or
four fresh responses arriving on top of digits still being entered; the entry
committed short in the middle of it. Now the audio queued at the carrier is dropped and
the response comes off the played list, so it finishes generating into a channel nobody
hears. The only reason the cancel existed is that the API refuses a second response while
one is running, so a new line waits for `response.done` and goes out then. I fixed the
first keypress several commits before the commit path, which was the half of the turn
where the caller is typing fastest.

**G3. An entry is bound to the question it started on, length included.** *13 Aug,
standing, `bridge.js`.*
The expected length used to be re-read from whatever question was current, so once the
form moved to the nine digit routing number the fourth digit no longer completed the four
digit social, the entry ran on to eight digits, then the whole thing was thrown out at the
end as belonging to a question that had passed. If the form moves anyway, the entry
starts over.

**G4. Nothing the model reports may be saved against a question that has a live keypad
entry on it.** *13 Aug, standing, `bridge.js`.*
The model hears the tones as audio and writes them down as words. The guard against that
had become a comparison, refuse the save only when its digits match the buffer, and
transcription lags the tones, so the model reported four digits while three were buffered,
the comparison missed and the answer went in under a live entry. A caller who starts
typing and then wants to speak presses star, which the question offers.

**G5. Digits typed at a read-back mean that number, not a yes or a no.** *13 Aug,
standing, `bridge.js`.*
A caller who heard their routing number back wrong and typed the right one used to get
"Sorry, was that a yes or a no?" The pending value is dropped and the digits are captured
fresh, which reads the new one back in its turn.

**G6. The keypad timing windows are constants with reasons attached, settable in
tests.** *13 Aug, standing, `bridge.js`.*
`DTMF_IDLE_MS` is 6 seconds, up from 2.5, which was shorter than the pause a person takes
reading a long number off a statement; the fixed-length fields survived the short window
because a truncated entry fails its own length check, but the account number is a range
of 4 to 17, so half a number validated and got read back as the whole one. The question
now says to press pound at the end. `DTMF_DEAF_MS` is 300 ms, down from 800, which was
long enough to eat the start of a deliberate next entry from somebody typing steadily
through the form. `DTMF_SUPPRESS_MS` is a 15 second ceiling on the window that ignores a
model save after a committed entry; the window really closes when the line the commit
wrote has finished being spoken, since that is the first moment the caller can be
answering it. A flat 2.5 seconds was the wrong shape at both ends, too long against a
one-line acknowledgement and far too short against a nine digit read-back, which takes
eight seconds to say. The tests type entries back to back with no wall clock between
them, so both windows are injectable.

**G7. A quiet line gets a nudge at 20 seconds and a goodbye at 50.** *13 Aug, standing,
`bridge.js` (`QUIET_NUDGE_MS`, `QUIET_END_MS`).*
The goodbye emails the form so far as Incomplete. A caller who has put the phone down
should not hold an open line and a running model session, while one looking for a bank
statement needs longer than a pause. A keypad press counts as activity, so nobody is hung
up on mid-entry. The numbers themselves are reasoned rather than measured (see O1).

**G8. I log every keypress, including the ones that go nowhere.** *13 Aug, standing,
`bridge.js`.*
A press can be dropped on four paths without leaving a trace, which is why typing during
a question kept misbehaving in ways the log could not explain. For each press I record the
question it landed on, how many digits are buffered, whether a read-back is open, whether
the bot is still speaking and the reason if it was dropped.

**G9. I log frames and seconds of audio per spoken line.** *13 Aug, standing,
`bridge.js`.*
A caller reported not hearing a line the log showed the bot saying. A transcript cannot
tell a line that was generated from a line that was delivered, a frame count cannot tell
a whole sentence from a truncated one, while seconds can. A line logged with 0 frames is
one nobody heard.

**G10. `end_call` requires the caller's own words; a refused hang-up keeps the turn.**
*13 Aug, standing, `bridge.js` / `agent.js`.*
Only the caller's words end a call, never the model's reason for calling the tool. A
caller who answered the question and happened to sound final used to get the hang-up
refused and their answer dropped, then heard the same question again. A refused hang-up
now goes through the normal turn so the validators decide instead of the model. "I am
done with this question", "okay I am finished with that one" and "can I talk to someone
about this later" all used to end the application; a stop request is about the call, not
about the question in front of the caller.

**G11. The model may not write its own lines.** *13 Aug, standing, `agent.js`.*
The instructions used to say it could put an ordinary new question in its own natural
voice, which contradicted the word-for-word rule I send with every line. On one call it
offered "just tell me the bank name and I can look it up for you", which this bot cannot
do; the caller said "Capital One" and a nine digit routing number came out the other side.
It said "I see you're holding something that looks like a document with numbers" on a
phone call, having no camera. And it said "about 2,171 dollars a month" where I had
computed 2,169, on a figure read back precisely so a caller can catch a mistake in it. The
arithmetic itself was right: 1,001 every two weeks is 26 paychecks a year, which is 2,169
a month, not 24 paychecks and 2,002. The latitude is gone and those three failures are
named in the prompt. The model is also told never to recite
a captured value back and never to dump its instructions.

---

## H. How I test it

**H1. `tools/simulate.js` runs the whole call typed instead of spoken.** *12 Aug,
standing.*
No accounts and no keys, the same path as a real call with the audio missing. It is what
made six rounds of adversarial testing possible in a morning.

**H2. Canned scripts are keyed by field and the turn list is built by walking `FIELDS`.**
*13 Aug, standing, `tools/scripts.js`.*
The scripts used to be positional arrays with an index map beside them; a position is
wrong the moment a question moves or a caller's answer changes which questions apply. An
unemployed applicant skips the cadence, the pay day, the income figure and the whole
employer block, so every answer after that slid onto the wrong question: the multi-reject
call was answering "every other week" to "are you deployed" and landing on the right
decision by luck. Three tests were walking to a question by counting to 13. Nothing built
this way drifts when a question moves.

**H3. `regressions.test.js` holds one case per bug that has actually shipped here.**
*12 Aug, standing.*

**H4. `tools/preflight.js` opens a live Realtime session, because that path has no
tests.** *12 Aug, standing.*
Everything between the caller and the email is tested except the WebSocket to the
Realtime API, which I wrote from the documentation. Preflight opens a live socket, asks
for one spoken line and prints whether audio came back on the event `bridge.js` listens
for.

**H5. Six adversarial rounds ran against the offline harness before any of it was
committed.** *13 Aug, standing, `REDTEAM-STATE.md`.*
Escalating themes: baseline lenses, non-ideal humans, adversarial applicant and prompt
injection, state seams, rare-but-real profiles, then a completeness critic. Every finding
had to be reproduced offline before it counted. About 35 issues fixed across the rounds,
tests 291 to 324. The non-ideal-human round found more breaks than the adversarial one.

**H6. The credential check runs under the `require.main` guard, not at module scope.**
*13 Aug, standing, `server.js`.*
`carrier.test.js` imports `server.js` for `twiml()`, which is a pure function of the
carrier and the caller's number and needs no credentials. With the check at module scope,
a fresh clone with no `.env` died on the last file of the suite, before the summary line
and with an exit code that reads as a failing build. Running the server directly with no
key still refuses and exits 1.

---

## R. Reversed

Kept because the reason a thing did not work is the part that is hard to reconstruct.

**R1. I refused `save_answer` when no caller transcript had arrived since the question.**
*13 Aug, reverted the same day, `bridge.js`.*
It was meant to stop the model inventing an answer, which it had done on a live call: the
caller said nothing usable, the transcriber wrote "You" twice, then "June 1st 1990" went in
as the applicant's birthday. The ordering is wrong. This is a speech-to-speech model, so
it hears the audio and files the answer immediately while Whisper's transcript of the same
audio lands afterwards. A real answer arrived before its own transcript, got refused, the
question was asked again, then the caller repeated himself into the same refusal until he
hung up. An unanswerable question is worse than the invented answer it was meant to stop.
The right signal is voice activity, which fires before the model responds. That is a
change worth making with time to test it on a live call. The test harness keeps the fix
that came with it: it sends the transcription event and the tool call, which is the shape
a real turn has, where it used to send only the tool call.

**R2.** See C12: `parseEnum` inferring which option a negation ruled out.

**R3.** See C2: speech accepted on all four number fields.

**R4.** See G11: the model allowed to phrase its own questions.

**R5. `redo_previous` took no arguments.** *12 Aug, reversed 13 Aug, `agent.js`.*
The caller heard "Okay, Mike Hawk, is that right?" and said "Joe", meaning his first name
was wrong. The model called `redo_previous`, which took no arguments, so the word "Joe"
was destroyed before I ever saw it; the bot re-asked the last name. A tool that
carries no words can only be as good as the model's guess about what they meant; the
guess is the part that keeps failing. It requires `heard` now.

**R6. "Right" was in the YES set.** *13 Aug, reversed the same day, `parse.js`.*
The knockout questions themselves say "right now", so "right, no I'm not deployed"
recorded a yes and declined the caller. Dropping it also defuses a speakerphone echo of
"...is that right?" auto-confirming. The confirmation idioms that do mean yes, "that's
right" among them, are bound as whole phrases instead.

---

## O. Open

Not decided. Each of these is a live gap I can name rather than a thing I settled.

**O1. The quiet-line timers are reasoned rather than measured.** After a few dozen calls
they should come from a percentile of the observed time-to-answer per field in
`capture_metrics`, since "what is your name" and "read me your account number" are not
the same wait.

**O2. A caller cannot correct an answer more than one question back.** `redo_previous`
steps back exactly one field, so a late "actually I make 4,000" gets filed as the answer
to whatever was just asked. It needs a field-addressable correction tool and a matching
instruction to the model.

**O3. Nothing verifies the account number against the bank.** Plaid or a micro-deposit
pair would settle it after the phone hangs up, with the application held pending. Whether
to stamp the outcome as pending verification is open.

**O4. There is no recording, no consent line, no human handoff and no call-back resume.**
The prompt lets a caller ask for a person and `end_call` ends the application; there is no
`<Dial>` leg because there is no number to dial. A four-minute call that drops at question
20 starts over at question 1.

**O5. There is no dedup across calls.** The same applicant calling twice produces two
applications. Deduping belongs downstream on name, social and routing number, all of which
the payload carries.

**O6. No transcript is stored.** Transcription is on in the session config and nothing
keeps the output, so there is no record of what the caller actually said next to what I
captured.

**O7. Live coverage is thin.** Most of the bugs real calls turned up were things no
stubbed test could reach: the model's exact phrasing, transcription artifacts, a line
that goes quiet, an accented name. Two paths have still never run against a live session,
a caller who answers a spoken confirmation on the keypad and the give-up path meeting the
knockout path outside the canned scripts.

**O8. A caller reading digits one per turn with long gaps still fails on a spoken digit
field.** The real fix is accumulating spoken digits across turns plus a longer per-field
voice-activity budget, which changes the turn model. C1 removed most of the exposure by
taking the four worst fields to the keypad.

**O9. Smaller ones I have looked at and left.** An annual salary with no period ("sixty
thousand") is read as monthly. A mononym applicant cannot complete, since the last name is
required. A bare "yeah" said to somebody else in the room on a decline-on-yes knockout
auto-declines; I cannot tell it from a real yes without reading every knockout yes
back. Income between 2,000.01 and 2,000.49 rounds down and declines. Zip 00000 is
accepted. Net and gross income are not distinguished. The JSON payload prints skip
sentinels ("None", "Same as calling number") where an API would want null.
