# Finosu intake call bot

An inbound number you can call. It takes a loan application over the phone, decides
against the five rules and emails the filled form.

The audio path is speech to speech: the carrier streams the call to OpenAI's Realtime
API and streams the reply back, both in G.711 u-law at 8 kHz, so nothing is resampled or
transcoded in between. Twilio and SignalWire both work and only two attributes on one
line of markup differ between them.

The model talks and does nothing else. It holds no form, no field order and no lending
rule. It has one tool, `save_answer`. The next question comes back to it in the tool
result. I kept the rules out of the model because a caller can argue a model out of a
rule it holds; a model holding the field order can drop a field with nothing to catch
it.

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

Every call I made, including the four that read against the brief, is in
[DECISIONS.md](DECISIONS.md) with the reasoning.

---

## Run it without a phone

No accounts and no keys:

```
npm install
node tools/simulate.js
```

Same field order, same validators, same knockout checks and same decision as a real
call, with only the audio missing.

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

An OpenAI key, a number and a public URL, about ten minutes.

```
cp .env.example .env      # fill in OPENAI_API_KEY
npm run preflight         # checks the credentials and the Realtime socket
npm start                 # listens on :5050
cloudflared tunnel --url http://localhost:5050
```

Preflight is worth running before you buy a number. Everything between the caller and
the email has tests except the WebSocket to the Realtime API. I wrote the session shape,
the audio format object and the event names from the documentation, so it is the one
part here that can be wrong in a way nothing else would catch. It opens the socket for
real, sends the same `session.update` the bot sends, asks for one spoken line and
reports whether audio came back on the event `bridge.js` listens for. Fifteen seconds
and a few cents.

Point a number at `https://<your-tunnel-host>/incoming-call`. For SignalWire, put the
space, project id and token in `.env` with `CARRIER=signalwire`, then `node
tools/signalwire-setup.js --search 703`, `--buy +1...` and `--check` do the rest. For
Twilio it is console.twilio.com → Phone Numbers → the number → **A call comes in** →
POST to that URL, or `node tools/twilio-setup.js --check` from the terminal.

**A Twilio trial cannot run this bot at all**, since `<Stream>` is one of the verbs
Twilio strips on a trial account: the number fetches the markup, reads out "the Stream
verb is not available on trial accounts" and hangs up, which looks like a bug in this
repo without being one. The account has to be upgraded. SignalWire's trial mode instead
limits who may call in, so the stream itself runs.

---

## What it asks, in what order

24 fields, asked in a different order from the one the brief lists them in.

| # | Field | Why here |
|---|---|---|
| 1–4 | Name, email, birthday, SMS number | Who is calling. A declined application still has a record. |
| 5–10 | Employment status, pay frequency, monthly income, deployed military, financial assistance, checking or savings | **The five knockouts**, plus the pay cycle. Every reject rule in the brief can be settled from these. |
| 11–13 | Last four of social, routing number, account number | Only reached by an applicant still in play. |
| 14–18 | Address | |
| 19–24 | Employer, department, pay day, employer address and phone | |

All five screening questions get asked even after one has already failed, so two
declines can be compared against each other instead of arriving with four empty fields
each. None of the five gets acted on until all five have landed. Since the block runs
ahead of every sensitive field, an applicant who is going to be declined never reads a
social security number or a bank account down the phone.

`EARLY_KNOCKOUT=0` asks all 24 questions and decides at the end, which is the literal
reading of the brief. The decision is identical either way and the tests check both. The
email prints the form back in the brief's own order and wording.

Four places I read the brief rather than followed it, argued in
[DECISIONS.md](DECISIONS.md): I ask income as a figure and compute the brief's yes/no
from it, I ask the pay cycle before the figure so a per-paycheck answer can be
converted, I approve at exactly 2,000 where the field and the rule contradict each other
and I treat "Semiweekly" as semimonthly while storing the brief's spelling.

---

## The fraud check

The brief says make sure the routing number and account number are real. Those are two
different problems and only one of them can be solved on a phone call.

**Routing number.** Nine digits with a prefix that was actually issued (00–12, 21–32,
61–72, 80), then the ABA check digit `3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9)` ending in
0, then a lookup against the 18,198 routing numbers in the Federal Reserve's FedACH
participant file. The check digit alone is not enough, since nine random digits pass it
one time in ten: `310000185` has a valid prefix and a clean check digit and belongs to
no bank, so only the directory lookup refuses it. Run `node tools/simulate.js --script
fake-routing` to watch that happen.

The directory is also where the bank's name comes from, which the bot reads back ("got
it, that's Chase") so a transposition gets caught, since two real routing numbers
differing by a transposition are both valid and only the caller knows which one is
theirs. Rebuild the file with `npm run fetch-directory`.

**Account number, which this cannot verify.** Account numbers carry no check digit, so
nothing computed from the digits separates a real account from a plausible one. Only the
bank can, through a micro-deposit pair or an instant verification provider, which is an
API call made after the phone call ends. What runs here refuses the shapes that are
never accounts: wrong length, one digit repeated, a straight run like 123456789, the
routing number said twice, the social security digits said again.

---

## The five rules

`src/decision.js`, pure functions over the record with no model involved:

| Code | Fires when |
|---|---|
| `BANK_ROUTING_INVALID` | Routing number missing, malformed, bad check digit, or absent from FedACH |
| `BANK_ACCOUNT_INVALID` | Account number is not a usable account number |
| `ACCOUNT_TYPE_SAVINGS` | Savings rather than checking |
| `NOT_EMPLOYED` | Employment status is Unemployed |
| `INCOME_BELOW_2000` | Monthly income figure is below 2,000 dollars, or the yes/no backstop said no |
| `DEPLOYED_MILITARY` | Deployed active duty or a dependent |
| `FINANCIAL_ASSISTANCE` | Receiving government assistance |

There are three outcomes rather than two. **Approved** means every rule was reachable
and none fired, **Declined** means at least one fired and **Incomplete** means the call
ended before the rules could be settled. A routing number nobody could capture leaves
the record short and collapsing that into Declined would report a bad phone line as
fraud; the email says which fields never landed. Every firing rule is kept, so an
applicant who is unemployed, under the income line and on assistance shows all three
reasons. Every decision carries a `policy_version`, so an old application can be re-read
against the rules it actually faced.

Two policy calls I would want confirmed: Retired and Student pass `NOT_EMPLOYED`, since
the brief says "unemployed" and a retiree with a pension over 2,000 a month is approved;
and the caller is told the outcome without the reason, with reason codes going in the
record, because reading a decline reason down the phone is a decision for whoever owns
compliance.

---

## Hearing people correctly

Digits are where a voice bot fails and a misheard routing digit is a wrong bank rather
than a typo.

Both carriers deliver touch-tone presses as `dtmf` events on the same socket as the
audio, so on the social security digits, routing number, account number, zip and phone
numbers, typed digits go straight into the record and skip speech recognition entirely.
`#` submits, `*` clears and the first press stops the bot talking.

Spoken forms are parsed rather than guessed at: "four eight two one", "forty eight
twenty one", "double four two one" and "4821" all reach `4821`, dates arrive as "March
fourth nineteen ninety four" or "oh three oh four ninety four" or "3/4/1994". Email
addresses said out loud get "at" and "dot" and "underscore" put back. A value that does
not parse comes back with the actual reason ("that number fails the routing number check
digit") rather than the same sentence twice. Three failures and I leave the field empty,
so the outcome comes out Incomplete rather than wrong. "I'd rather not say" reads as no
answer rather than as no. The caller can also say the last answer was wrong and the bot
steps back a question.

---

## What the call records besides the answers

Three things get written that the application has no line for, chosen because none of
them can be reconstructed afterwards. The raw words sit next to the normalized value, so
"March fourth nineteen ninety four" is kept beside `1994-03-04` and a parse found to be
wrong later can be re-run against the original. Each field carries what it cost: seconds
spent, tries taken, whether it arrived by voice or keypad and which field the call
stopped on. Corrections keep the old value rather than dropping it, since someone who
revises their income after hearing the question again is a different applicant from
someone who said it once. On the three sensitive fields the raw words are dropped and
only the digit count is kept and a corrected sensitive value is masked in the log.

All of it lands in `capture` and `capture_metrics` in the JSON, next to the application
rather than inside it.

The email to `REPORT_TO` has three parts: the decision and reason codes, the form as
`Label: value` lines in the brief's order and the JSON that would be POSTed to an
underwriting API. The same JSON is on disk at `calls/<callSid>.json` and replays through
`decide()` to the outcome it already holds. The transcript sits next to it with the
social security digits, routing number and account number masked, since those live in
the application record rather than in a log line. Sending uses the Gmail API with a
stored refresh token: `messages.send` first, `drafts.create` plus `drafts.send` if the
token's scope is short. If both are refused the draft is left in the mailbox, so an
application is never lost to an OAuth problem.

---

## Cost

| | |
|---|---|
| Twilio US local number | $1.15 / month |
| Twilio inbound voice | $0.0085 / minute |
| OpenAI `gpt-realtime` audio in | ~$0.019 / minute |
| OpenAI `gpt-realtime` audio out | ~$0.077 / minute |

A four-minute call where the bot talks for two of them is about **25 cents**.
`gpt-realtime-2.1-mini` is roughly a third of that if the accuracy holds and the model
is one line in `.env`.

---

## Layout

```
src/parse.js      spoken words -> values. Pure functions, all tested.
src/validate.js   is it real? Routing checksum + FedACH directory lives here.
src/fields.js     the call script, as data. Order, wording, which fields are knockouts.
src/intake.js     one call's state. Slot filling, re-asks, giving up, stepping back.
src/decision.js   the five rules. No model, no I/O.
src/agent.js      the model's instructions and its three tools.
src/bridge.js     carrier <-> OpenAI audio, tool calls, keypad.
src/server.js     the two HTTP endpoints.
src/format.js     the form and the API payload.
src/email.js      Gmail send.
tools/simulate.js  the call, typed. No accounts needed.
tools/preflight.js opens a real Realtime session and checks every credential.
tools/scripts.js   canned calls, used by the tests.
tools/twilio-setup.js buys a number and points it at the tunnel, over the API.
tools/fetch-fedach.js rebuilds the routing directory from the Fed's file.
data/              FedACH routing directory, 18,198 numbers.
```

332 checks across `test/`: the parsers, the routing checksum and directory, the five
rules over whole records, canned calls end to end, the screening block and capture
metrics, the call state machine driven with fake sockets, the markup each carrier gets
and `regressions.test.js`, which holds one case per bug that has actually shipped here.

---

## What I would do next

1. **Verify the account number for real.** Plaid or a micro-deposit pair, called after
   the phone hangs up with the application held pending. Everything in `decision.js` is
   already a pure function of the record, so re-deciding when the verification lands is a
   re-run rather than a rewrite.
2. **Recordings and a consent line.** Call recording is a state-by-state consent question
   and there is no recording today. The bot does say up front that what it collects is
   used for the loan decision and nothing else.
3. **Let a caller correct an answer more than one question back.** `redo_previous` steps
   back exactly one field, so a late "actually I make 4,000" gets filed as the answer to
   whatever was just asked. This needs a field-addressable correction tool and a matching
   instruction to the model.
4. **Rate limit by calling number.** Nothing stops someone dialling twenty times to probe
   which routing numbers the directory accepts.
