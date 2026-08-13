# Finosu intake call bot

This is a phone number you can call. The bot takes a loan application over the phone,
runs the reject rules against the answers and emails the filled form.

The audio path is speech to speech: the carrier streams the call to OpenAI's Realtime API
and streams the reply back, both in G.711 u-law at 8 kHz, so in `bridge.js` I copy bytes
in both directions with no resampling. The model talks and does nothing else. It holds no
form, no field order and no lending rule. The only tool that puts anything on the form is
`save_answer` and the next question comes back to it in the tool result. I kept the
rules out of the model because a caller can argue a model out of a rule it holds, while a
model holding the field order can drop a field with nothing to catch it.

```
caller ──phone──▶ Twilio ──ws (u-law)──▶ bridge.js ──ws (u-law)──▶ OpenAI Realtime
                    │                        │
                    │  dtmf digits           │  save_answer("four eight two one")
                    └────────────────────────┤
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

npm test                                         # 332 checks
```

---

## With a phone

Setting this up takes an OpenAI key, a number, a public URL and about ten minutes.

```
cp .env.example .env      # fill in OPENAI_API_KEY
npm run preflight         # checks the credentials and the Realtime socket
npm start                 # listens on :5050
cloudflared tunnel --url http://localhost:5050
```

Everything between the caller and the email has tests except the WebSocket to the
Realtime API, which I wrote from the documentation, so preflight opens a live socket,
asks for one spoken line and prints whether audio came back on the event `bridge.js`
listens for.

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

Digits are where a voice bot fails, so on every digit field a caller can type instead of
speak and the presses arrive as `dtmf` events on the same socket as the audio. Spoken
forms are parsed rather than guessed at, so "four eight two one", "forty eight twenty
one" and "4821" all reach `4821`. After three failures I leave the field empty, since
writing a guess makes the record wrong in a way nothing downstream can detect while an
empty field only makes the outcome Incomplete. The JSON also keeps the raw words, the
time and retries per field and any value that was revised.

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

---

## Gaps

1. **The quiet-line timers are reasoned rather than measured.** After 20 seconds of quiet
   the bot asks "are you still there?"; at 50 it says goodbye and emails the form so far
   as Incomplete. Both numbers are constants in `bridge.js` rather than anything measured.
2. **A caller cannot correct an answer more than one question back.** `redo_previous`
   steps back exactly one field, so a late "actually I make 4,000" gets filed as the
   answer to whatever was just asked.
3. **The account number is never verified against the bank.** Plaid or a micro-deposit
   pair would settle it after the phone hangs up, with the application held pending.
4. **There is no recording, no consent line, no human handoff and no call-back resume.**
5. **Live coverage is thin.** Most of the bugs real calls turned up were things no
   stubbed test could reach: the model's exact phrasing, transcription artifacts, a line
   that goes quiet, an accented name. No transcript is stored either.

---

## Cost

| | |
|---|---|
| Twilio US local number | $1.15 / month |
| Twilio inbound voice | $0.0085 / minute |
| OpenAI `gpt-realtime` audio in | ~$0.019 / minute |
| OpenAI `gpt-realtime` audio out | ~$0.077 / minute |

A four-minute call where the bot talks for two of them is about 25 cents.
`gpt-realtime-2.1-mini` is roughly a third of that if the accuracy holds and the model is
one line in `.env`.

---

## Layout

```
src/parse.js      turns spoken words into values
src/validate.js   checks a value against the checksum, the FedACH directory and the shape rules
src/fields.js     holds the call script as data: order, wording and which fields are knockouts
src/intake.js     tracks one call's state: slots, re-asks, giving up, stepping back
src/decision.js   runs the reject rules with no model and no network
src/agent.js      holds the model's instructions and its three tools
src/bridge.js     moves audio between the carrier and OpenAI, with tool calls and keypad
src/server.js     serves the health check, the TwiML webhook and the media-stream upgrade
src/format.js     builds the form and the API payload
src/email.js      sends through the Gmail API
src/env.js        reads .env
tools/simulate.js runs the whole call typed instead of spoken
tools/preflight.js opens a live Realtime session and checks every credential
tools/scripts.js  holds the canned calls the tests use
tools/twilio-setup.js buys a number over the API and points it at the tunnel
tools/signalwire-setup.js does the same against SignalWire
tools/fetch-fedach.js rebuilds the routing directory from the Fed's file
data/             the FedACH routing directory
```

`regressions.test.js` holds one case per bug that has actually shipped here.
