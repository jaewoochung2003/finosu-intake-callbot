# Finosu intake call bot

This is a phone number you can call. The bot takes a loan application over the phone,
runs the reject rules against the answers and emails the filled form.

The model listens and does nothing else. It has no tools, no voice and no way to start a
turn of its own, so what comes back from it is a transcript and nothing more. I take the
transcript, run it through the form, then turn the next line into audio myself and send
that to the carrier. The lending rules and the field order live in plain functions, since
a caller can argue a model out of a rule it holds while a model holding the field order
can drop a field with nothing to catch it.

I built it the other way first, with the model speaking the lines I wrote and filing the
answers through a tool. Over an evening of live calls it reworded lines, dropped the
question off the end of a read-back so the caller was never asked anything, said
sentences I had not written, skipped a question and left the caller in silence, then
answered its own yes-or-no question before the caller had made a sound. None of that was
disobedience. A model handed a turn produces a plausible continuation of the
conversation; after "is that right?" the plausible continuation is "yes", so from
inside the turn there is no difference between hearing an answer and an answer belonging
there. Taking the turn away removes the whole set at once. A line cannot be reworded or
cut short because I build the audio from the string and nothing reads it in between; a
question cannot be skipped because I send the frames and count them; an answer cannot be
invented because there is no tool to invent one with; and the turn cannot be taken early
because I hold the microphone shut until the carrier reports the last frame played. It
costs about half a second before each line and the caller cannot interrupt mid-sentence.

```
                    ┌──── u-law frames ──── voice.js ◀── OpenAI speech
                    ▼                          ▲
caller ──phone──▶ carrier ──ws (u-law)──▶ bridge-voice.js ──ws──▶ OpenAI Realtime
                                               │                  (transcription only)
                                               │  ◀── "four eight two one"
                                               ▼
                                  intake.js ─▶ validate.js ─▶ decision.js
                                               │
                                               ▼
                                     email.js ─▶ your inbox
```

---

## Without a phone

You need no accounts and no keys:

```
npm install
node tools/simulate.js
```

It runs the same path as a real call, with only the audio missing.

```
node tools/simulate.js --list
node tools/simulate.js --script approved
node tools/simulate.js --script savings          # declines after the screening block
node tools/simulate.js --script fake-routing     # a made-up routing number gets refused
node tools/simulate.js --script multi-reject     # three reject reasons on one call
node tools/simulate.js --script approved --email # actually sends the email

npm run paths                                    # every branch of the call, with what each one decided
npm test                                         # 399 checks
```

---

## With a phone

Setting this up takes an OpenAI key, a number, a public URL and about ten minutes.

```
cp .env.example .env      # fill in OPENAI_API_KEY
npm run preflight         # says a line, hears it back, checks every credential
npm start                 # listens on :5050
cloudflared tunnel --url http://localhost:5050
```

Everything between the caller and the email has tests except the two sockets to OpenAI,
which I wrote from the documentation. In preflight I say a line through the same speech
endpoint the bot speaks with, feed those frames into the same Realtime session the bot
listens with, then print the words that came back. A wrong model name, or a session shape
the API no longer accepts, fails there rather than on a live call.

Point a number at `https://<your-tunnel-host>/incoming-call` and set `CARRIER` in `.env`
to whoever sold it to you. For SignalWire, run `node tools/signalwire-setup.js --search
703` to find a number, `--buy +1...` to buy it and `--check` to confirm where it points;
`tools/twilio-setup.js` does the same over Twilio's API. A Twilio trial account cannot
run this bot, since Twilio strips `<Stream>` on a trial: the caller hears that the verb
is not available before the line goes dead.

---

## Questions

| # | Field | Why here |
|---|---|---|
| 1–4 | Name, email, birthday, SMS number | Who is calling. A declined application still has a record. |
| 5–10 | Employment status, pay frequency, monthly income, deployed military, financial assistance, checking or savings | These are the five knockouts plus the pay cycle. Every reject rule in the brief can be settled from them. |
| 11–13 | Last four of social, routing number, account number | What the fraud check runs on. |
| 14–24 | Address, employer, department, pay day, employer address and phone | These sit on the form without feeding any rule. |

All five screening questions get asked even after one has already failed, so two declines
can be compared against each other instead of arriving with four empty fields each. None
of the five gets acted on until all five have landed. Since the block runs ahead of every
sensitive field, an applicant who is going to be declined never reads a social security
number or a bank account down the phone. With `EARLY_KNOCKOUT=0` all 24 questions get
asked and the decision comes at the end, which is the literal reading of the brief; both
paths are tested and the decision is identical either way.

Digits are where a voice bot fails. Spoken forms are parsed rather than guessed at, so
"four eight two one", "forty eight twenty one" and "4821" all reach `4821`. A number
read slowly across several turns is added up against the length the field expects instead
of failing at three digits. The social security digits, the routing number and the
account number are each read back one character at a time before the call moves on, since
that is the only read-back a caller can check against the card in their hand. After three
failures I leave the field empty, since writing a guess makes the record wrong in a way
nothing downstream can detect while an empty field only makes the outcome Incomplete. The
JSON also keeps the raw words, the time and retries per field and any value that was
revised.

The keypad is off. `KEYPAD=on` restores it and selects the older bridge, which is the only
one that takes touch tones. Touch tones and a speech model share a turn badly: the model
hears the tones through the same microphone as the caller, writes them down as words and
files them as an answer to the question the keypad has already answered. Every line the
server sends then has to be arranged around an entry that may be half typed. The accuracy
per digit is better and the call finishing at all is worth more.

---

## Rules

In `src/decision.js` each reject rule is a function of the record with no model anywhere
in it. Five of the seven codes come from the brief; the two bank codes come from the
fraud check.

| Code | Fires when |
|---|---|
| `BANK_ROUTING_INVALID` | The routing number is missing, malformed, fails the check digit or is absent from FedACH |
| `BANK_ACCOUNT_INVALID` | The account number is not a usable account number |
| `ACCOUNT_TYPE_SAVINGS` | The account is savings rather than checking |
| `NOT_EMPLOYED` | Employment status is Unemployed |
| `INCOME_BELOW_2000` | The monthly income figure is below 2,000 dollars, or the caller answered no to the yes/no question |
| `DEPLOYED_MILITARY` | The caller is deployed active duty or a dependent |
| `FINANCIAL_ASSISTANCE` | The caller receives government assistance |

There are three outcomes rather than two. The third is Incomplete, which means the call
ended before the rules could be settled, since the record is short whenever nobody could
capture the routing number and reporting a bad phone line as fraud would be worse.
Approved also needs the identity and address fields, because the rules only cover seven
of the 24. Every firing rule is kept rather than only the first and each decision carries
a `policy_version`. The caller hears the outcome without the reason, since reading a
decline reason down the phone is a decision for whoever owns compliance.

The email to `REPORT_TO` carries the decision, the reason codes, the form in the brief's
own order and wording, then the JSON that would be POSTed to an underwriting API. The
same JSON is on disk at `calls/<callSid>.json` and replays through `decide()` to the
outcome it holds under the `policy_version` stamped on it.

---

## Fraud check

I check the routing number four ways: nine digits with a prefix that was actually issued,
then the ABA check digit, then a lookup against the 18,198 routing numbers in the Federal
Reserve's FedACH participant file, then the name that comes back, since the file lists
the Reserve Banks themselves and no consumer holds an account there. Nine random digits
pass the check digit alone one time in ten, so a made-up number fails only at the
directory lookup: `310000185` has a clean check digit and belongs to no bank. The
directory is also where the bank's name comes from, which the bot reads back ("got it,
that's Chase"), since two real routing numbers differing by a transposition are both
valid and only the caller knows which one is theirs.

An account number cannot be verified on a phone call at all, since it carries no check
digit and only the bank can settle it. What I refuse here are the shapes that are never
accounts: wrong length, one digit repeated, a straight run, the routing number said
twice, the social security digits said again.

---

## Against the brief

**Income is asked as a figure and the brief's yes/no is computed from it.** The brief's
field is "if salary is over 2000 dollars a month", so storing the answer to that records
today's threshold rather than the applicant's income. Move `INCOME_THRESHOLD` in
`decision.js` and every stored record is decided again from the number it already holds.

**The pay cycle is asked before the income figure, out of the brief's order.** "Twelve
hundred a paycheck" cannot be converted without knowing what a paycheck is. When I asked
the cycle twelve questions later, 1,200 every two weeks went in as 1,200 a month and a
caller earning 2,600 a month was declined.

**Exactly 2,000 is approved.** The brief's field says "over 2000" and its rule says
reject "less than 2000", which disagree at exactly 2,000. I followed the reject rule,
since refusing someone the reject rule does not name is the error you cannot defend to
them. Following the field instead means moving three comparisons together, `<` to `<=` in
`decision.js` and `>=` to `>` in `fields.js` and `validate.js`, or the emailed form
contradicts the decision at exactly 2,000.

**"Semiweekly" is converted as twice a month.** The brief's spelling is what gets stored
and a caller saying "twice a month" or "semimonthly" lands on the same value. "Twice a
week" does not fold in here, since that mistake converted a twice-weekly paycheck at half
the real figure.

**Student is not one of the employment statuses I offer.** A student has no income and no
pay cycle behind the status, so the four cadences did not fit and the way out was finding
the wording that meant "none". The record it produced said Student with an empty cadence
and no wage, which is what Unemployed already means and already handles. A caller who
says "student", "in school" or "college" is recorded as Unemployed, which skips the pay,
income and employer questions and reaches the same decision either way. A student with a
job answers with the job and lands on Employed.

---

## Gaps

1. **The quiet-line timers are reasoned rather than measured.** After 20 seconds of quiet
   the bot asks whether the caller is still there and asks the open question again; at 50
   it says goodbye and emails the form so far as Incomplete. Both numbers are constants
   in `bridge-voice.js` rather than anything I measured.
2. **A caller cannot correct an answer more than one question back.** Stepping back moves
   exactly one field, so a late "actually I make 4,000" gets filed as the answer to
   whatever was just asked.
3. **The account number is never verified against the bank.** Plaid or a micro-deposit
   pair would settle it after the phone hangs up, with the application held pending.
4. **A caller cannot interrupt a line.** The microphone stays shut until the carrier
   reports the last frame played, which is what stops the bot hearing its own voice on a
   speakerphone and answering itself. Barge-in needs the two told apart some other way.
5. **There is no recording, no consent line, no human handoff and no call-back resume,**
   and no transcript is stored. Most of what live calls turned up was outside anything a
   stubbed test could reach: a name spelled back with the hyphens still in it, a one word
   answer transcribed into another language, an option named in the plural.

---

## Cost

| | |
|---|---|
| Twilio US local number | $1.15 / month |
| Twilio inbound voice | $0.0085 / minute |
| OpenAI Realtime, audio in | ~$0.019 / minute |
| OpenAI speech, out | billed per character rather than per minute |

The speech side changed shape when I stopped having the model talk. A full call is about
2,500 characters of bot speech whatever it takes to say them, so a four-minute call comes
to roughly 15 cents against the 25 it cost before. Less than that in practice, because
the questions are the same on every call and are made once rather than per call.

A line is routed a sentence at a time. Ordinary sentences go to `tts-1`, which reads what
it is handed; the sentence that spells a value out goes to `gpt-4o-mini-tts`, the only
one of the two I can tell what the line is for. It is the only one that spells and it is
also the one that sometimes says something other than the line, so it gets the letters
and nothing else — "Is that right?" on the end of a read-back is a fixed string played
off disk. Both models are one line in `.env`.

The fixed lines live in `data/tts` as finished u-law and are made at startup if the
folder is empty, which takes about 90 seconds and ten cents, once. Delete the folder to
rebuild them after changing the voice or the wording. A warmed line reaches the carrier
in about a millisecond against the 1.2 seconds `tts-1` takes to return its first byte,
which is most of what a caller hears as the bot being slow to answer. The rest of that
wait is the 900 ms of silence the voice detector needs before it will call a turn over,
which is deliberate: at 650 ms one answer came back as two transcripts and the second
landed in the next field.

---

## Layout

```
src/parse.js      turns spoken words into values
src/validate.js   checks a value against the checksum, the FedACH directory and the shape rules
src/fields.js     holds the call script as data: order, wording and which fields are knockouts
src/intake.js     tracks one call's state: slots, re-asks, giving up, stepping back
src/decision.js   runs the reject rules with no model and no network
src/voice.js      turns a line of text into 8 kHz u-law frames the carrier can play
src/bridge-voice.js  runs one call: transcript in, form, line out
src/server.js     serves the health check, the TwiML webhook and the media-stream upgrade
src/format.js     builds the form and the API payload
src/email.js      sends through the Gmail API
src/env.js        reads .env
src/bridge.js     the older bridge, where the model spoke and filed answers through a tool
src/agent.js      that model's instructions and its three tools
tools/simulate.js runs the whole call typed instead of spoken
tools/preflight.js says a line, hears it back and checks every credential
tools/scripts.js  holds the canned calls the tests use
tools/twilio-setup.js buys a number over the API and points it at the tunnel
tools/signalwire-setup.js does the same against SignalWire
tools/fetch-fedach.js rebuilds the routing directory from the Fed's file
data/             the FedACH routing directory
```

`regressions.test.js` holds one case per bug that has actually shipped here. The last two
files are reachable only with `KEYPAD=on`; I kept them because they are the only path that
takes touch tones, so `npm test` runs the suite against both paths.
