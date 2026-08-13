# Finosu intake call bot

This is a phone number you can call. The bot takes a loan application over the phone,
runs the five reject rules against the answers and emails the filled form.

The audio path is speech to speech: the carrier streams the call to OpenAI's Realtime
API and streams the reply back, both in G.711 u-law at 8 kHz, so in `bridge.js` I copy
bytes in both directions with no resampling and no transcoding. Twilio and SignalWire
both work and only two attributes on one line of markup differ between them.

The model talks and does nothing else. It holds no form, no field order and no lending
rule. Its one tool is `save_answer` and the next question comes back to it in the tool
result. I kept the rules out of the model because a caller can argue a model out of a
rule it holds, while a model holding the field order can drop a field with nothing to
catch it. The cost is that every question is a round trip through the server, so the bot
cannot improvise a follow-up.

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

## Run it without a phone

You need no accounts and no keys:

```
npm install
node tools/simulate.js
```

The field order, the validators, the knockout checks and the decision are the same as on
a real call, with only the audio missing.

```
node tools/simulate.js --list
node tools/simulate.js --script approved
node tools/simulate.js --script savings          # declines after the screening block
node tools/simulate.js --script fake-routing     # made-up routing number, refused
node tools/simulate.js --script multi-reject     # three reject reasons on one call
node tools/simulate.js --script approved --email # actually sends the email

npm test                                         # 332 checks
```

---

## Run it on a phone

Setting this up takes an OpenAI key, a number, a public URL and about ten minutes.

```
cp .env.example .env      # fill in OPENAI_API_KEY
npm run preflight         # checks the credentials and the Realtime socket
npm start                 # listens on :5050
cloudflared tunnel --url http://localhost:5050
```

Everything between the caller and the email has tests except the WebSocket to the
Realtime API, which I wrote from the documentation, so preflight opens that socket for
real and prints whether audio came back on the event `bridge.js` listens for. It costs a
few cents and is worth running before you buy a number.

Point a number at `https://<your-tunnel-host>/incoming-call`. For SignalWire, put the
space, project id and token in `.env` with `CARRIER=signalwire`, then `node
tools/signalwire-setup.js --search 703`, `--buy +1...` and `--check` will find a number,
buy it and point it here. For Twilio it is console.twilio.com → Phone Numbers → the
number → **A call comes in** → POST to that URL. A Twilio trial account cannot run this
bot at all, since Twilio strips `<Stream>` on a trial and the call hangs up after reading
out that the verb is not available.

---

## The 24 questions and the order I ask them in

| # | Field | Why here |
|---|---|---|
| 1–4 | Name, email, birthday, SMS number | Who is calling. A declined application still has a record. |
| 5–10 | Employment status, pay frequency, monthly income, deployed military, financial assistance, checking or savings | These are the five knockouts plus the pay cycle. Every reject rule in the brief can be settled from them. |
| 11–13 | Last four of social, routing number, account number | An applicant who is going to be declined never reaches these. |
| 14–18 | Address | |
| 19–24 | Employer, department, pay day, employer address and phone | |

All five screening questions get asked even after one has already failed, so two
declines can be compared against each other instead of arriving with four empty fields
each. Nothing is acted on until all five have landed. Since the block runs ahead of every
sensitive field, an applicant who is going to be declined never reads a social security
number or a bank account down the phone. With `EARLY_KNOCKOUT=0` all 24
questions get asked and the decision comes at the end, which is the literal reading of
the brief; the decision is identical either way and both paths are tested.

---

## The five rules

In `src/decision.js` the five rules are pure functions over the record with no model
involved:

| Code | Fires when |
|---|---|
| `BANK_ROUTING_INVALID` | Routing number missing, malformed, bad check digit, or absent from FedACH |
| `BANK_ACCOUNT_INVALID` | Account number is not a usable account number |
| `ACCOUNT_TYPE_SAVINGS` | Savings rather than checking |
| `NOT_EMPLOYED` | Employment status is Unemployed |
| `INCOME_BELOW_2000` | Monthly income figure is below 2,000 dollars, or the yes/no backstop said no |
| `DEPLOYED_MILITARY` | Deployed active duty or a dependent |
| `FINANCIAL_ASSISTANCE` | Receiving government assistance |

There are three outcomes rather than two. Approved means every rule was reachable and
none fired, Declined means at least one fired and Incomplete means the call ended before
the rules could be settled, since a routing number nobody could capture leaves the record
short and reporting a bad phone line as fraud would be worse. Approved also needs the
identity and address fields, because the five rules only cover seven of the 24 and a
caller who cleared them and then hung up used to come out Approved over blank lines.
Every firing rule is kept rather than only the first. Each decision also carries a
`policy_version`, so an old application can be re-read against the rules it actually
faced.

The caller hears the outcome and not the reason, with the reason codes going in the
record, since reading a decline reason down the phone is a decision for whoever owns
compliance. Retired and Student do not trip `NOT_EMPLOYED`: the brief says "unemployed",
so a retiree with a pension over 2,000 a month is approved. If that reading is wrong it
is one line.

---

## The fraud check

I check the routing number three ways: nine digits with a prefix that was actually issued
(00–12, 21–32, 61–72, 80), then the ABA check digit `3(d1+d4+d7) + 7(d2+d5+d8) +
(d3+d6+d9)` ending in 0, then a lookup against the 18,198 routing numbers in the Federal
Reserve's FedACH participant file. Nine random digits pass the check digit alone one time
in ten, so a made-up number fails only at the directory lookup: `310000185` has a clean
check digit and belongs to no bank. Run `node tools/simulate.js --script fake-routing` to
watch that happen. The directory is also where the bank's name comes from, which the bot
reads back ("got it, that's Chase"), since two real routing numbers differing by a
transposition are both valid and only the caller knows which one is theirs.

An account number cannot be verified on a phone call at all, since it carries no check
digit and only the bank can settle it. What I refuse here are the shapes that are never
accounts: wrong length, one digit repeated, a straight run, the routing number said
twice, the social security digits said again.

---

## Digits

Digits are where a voice bot fails and a misheard routing digit is a wrong bank rather
than a typo. Both carriers deliver touch-tone presses as `dtmf` events on the same socket
as the audio, so on every digit field typed digits go straight into the record without
passing through speech recognition. Voice stays available anyway, because forcing the
keypad turns a voice bot into a phone tree.

Spoken forms are parsed rather than guessed at, so "four eight two one", "forty eight
twenty one" and "4821" all reach `4821`. A value that does not parse comes back with the
actual reason ("that number fails the routing number check digit") rather than the same
sentence twice. After three failures I leave the field empty, since writing a guess makes
the record wrong in a way nothing downstream can detect while an empty field only makes
the outcome Incomplete.

---

## What I record besides the answers

Three things get written that the application has no line for, all chosen because they
cannot be reconstructed afterwards: the raw words next to the normalized value, what each
field cost in seconds and retries, then the old value whenever someone revises an answer.
A normalized value cannot be un-normalized, while someone who changes their income after
hearing the question again is a different applicant from someone who said it once. On the
three sensitive fields I keep only the digit count. All of it lands in `capture` and
`capture_metrics` in the JSON, next to the application rather than inside it.

The email to `REPORT_TO` carries the decision and reason codes, the form as `Label:
value` lines in the brief's own order and wording, then the JSON that would be POSTed to
an underwriting API. The same JSON is on disk at `calls/<callSid>.json` and replays
through `decide()` to the outcome it already holds. Sensitive values are in the email in
full because the email stands in for the API call; in production it would carry an
application id instead.

---

## Where I read the brief rather than followed it

**Income is asked as a figure and the brief's yes/no is computed from it.** The brief's
field is "if salary is over 2000 dollars a month". If I store the answer to that and
nothing else, what I have recorded is today's threshold rather than the applicant's
income, so the day the threshold moves every stored application has to be collected
again. Move `INCOME_THRESHOLD` in `decision.js` and every stored record is decided again
from the number it already holds. A caller who will not name a figure gets the yes/no
after three tries.

**The pay cycle is asked before the income figure, out of the brief's order.** People
answer in the period they are paid in and "twelve hundred a paycheck" cannot be converted
without knowing what a paycheck is. When I asked the cycle twelve questions later, 1,200
every two weeks went in as 1,200 a month and a caller earning 2,600 a month was declined.
Four hundred a week is 1,733 a month rather than 1,600, so at 480 a week the two ways of
working it out land on opposite sides of the 2,000 line.

**Exactly 2,000 is approved.** The brief's field says "over 2000" and its rule says
reject "less than 2000", which disagree at exactly 2,000. I followed the reject rule,
since 2,000 is not less than 2,000 and refusing someone the reject rule does not name is
the error you cannot defend to them. To follow the field instead, change one comparison
in `decision.js` from `<` to `<=`.

**"Semiweekly" is converted as twice a month.** The brief's spelling is what gets stored
and a caller saying "twice a month" or "semimonthly" lands on the same value. "Twice a
week" is not one of the brief's four cadences, so it does not fold in here; that mistake
converted a twice-weekly paycheck at half the real figure.

---

## Known gaps

1. **The quiet-line timers are reasoned rather than measured.** After 20 seconds of quiet
   the bot asks "are you still there?"; at 50 it says goodbye and emails the form so far
   as Incomplete. Both numbers are constants in `bridge.js` and should come from a
   percentile of the observed time-to-answer per field in `capture_metrics`, since "what
   is your name" and "read me your account number" are not the same wait.
2. **A caller cannot correct an answer more than one question back.** `redo_previous`
   steps back exactly one field, so a late "actually I make 4,000" gets filed as the
   answer to whatever was just asked.
3. **The account number is never verified against the bank.** Plaid or a micro-deposit
   pair would settle it after the phone hangs up, with the application held pending.
   Everything in `decision.js` is already a pure function of the record, so re-deciding
   when that lands is a re-run rather than a rewrite.
4. **There is no recording, no consent line, no human handoff and no call-back resume.**
   Call recording is a state-by-state consent question. A caller can ask for a person,
   which ends the application through `end_call`, since there is no number to dial.
5. **Live coverage is thin.** Most of the bugs real calls turned up were things no
   stubbed test could reach: the model's exact phrasing, transcription artifacts, a line
   that goes quiet, an accented name. Two paths have still never run live, answering a
   spoken confirmation on the keypad and the give-up path meeting the knockout path.
6. **No transcript is stored.** Transcription is enabled in the session config and
   nothing keeps the output.

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
src/parse.js      spoken words -> values. Every function here is pure and tested.
src/validate.js   is it real? The routing checksum and the FedACH directory live here.
src/fields.js     the call script as data: order, wording and which fields are knockouts.
src/intake.js     one call's state: slot filling, re-asks, giving up, stepping back.
src/decision.js   the five rules, with no model and no I/O.
src/agent.js      the model's instructions and its three tools.
src/bridge.js     carrier <-> OpenAI audio, tool calls, keypad.
src/server.js     the two HTTP endpoints.
src/format.js     the form and the API payload.
src/email.js      Gmail send.
tools/simulate.js  the whole call, typed instead of spoken.
tools/preflight.js opens a real Realtime session and checks every credential.
tools/scripts.js   the canned calls the tests use.
tools/twilio-setup.js buys a number and points it at the tunnel, over the API.
tools/fetch-fedach.js rebuilds the routing directory from the Fed's file.
data/              the FedACH routing directory of 18,198 numbers.
```

There are 332 checks across `test/`, covering the parsers, the routing checksum and
directory, the five rules over whole records, canned calls end to end and the call state
machine driven with fake sockets. `regressions.test.js` holds one case per bug that has
actually shipped here.
