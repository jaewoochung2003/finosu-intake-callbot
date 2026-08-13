# Finosu intake call bot

An inbound phone number you can call. It takes a loan application over the phone,
decides on it against the five rules, and emails the filled form.

The audio path is speech to speech: the carrier streams the call to OpenAI's
Realtime API and streams the reply back, both in G.711 u-law at 8 kHz, so nothing is
resampled or transcoded in between. Twilio and SignalWire both work, and the code
that differs between them is two attributes on one line of markup. The model does the talking and nothing else.
It holds no form, no field order and no lending rule. It has one tool,
`save_answer`, and the server tells it what to ask next.

That split is the whole design. Speech is a model problem. Underwriting is not.

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

No accounts, no keys, works right now:

```
npm install
node tools/simulate.js
```

That is the same field order, the same validators, the same knockout checks and the
same decision a real call runs. Only the audio is missing. Canned calls:

```
node tools/simulate.js --list
node tools/simulate.js --script approved
node tools/simulate.js --script savings          # declines after the screening block
node tools/simulate.js --script fake-routing     # made-up routing number, refused
node tools/simulate.js --script multi-reject     # three reject reasons on one call
node tools/simulate.js --script approved --email # actually sends the email
```

Tests:

```
npm test        # 259 checks
```

---

## Run it on a phone

Three things: an OpenAI key, a Twilio number, and a public URL. About ten minutes.

**1. OpenAI key.** platform.openai.com → API keys. Put it in `.env` as
`OPENAI_API_KEY`. Realtime audio is billed by the minute, see Cost below.

**1b. Prove the pipeline before buying a phone number.**

```
npm run preflight
```

Everything between the caller and the email has tests except one link: the
WebSocket to OpenAI's Realtime API. The session shape, the audio format object and
the event names are written from the documentation and are the only part of this
project that can be wrong in a way nothing here would catch. Preflight opens that
socket for real, sends the same `session.update` the bot sends, asks for one spoken
line, and reports whether audio came back on the event `bridge.js` listens for. It
tries each known model name and tells you which one worked. Fifteen seconds, a few
cents.

It also checks the keys, the Gmail token and the routing directory, so a live call
is not the place you discover one of those is missing.

**2. Start the server.**

```
cp .env.example .env      # then fill in OPENAI_API_KEY
npm start                 # listens on :5050
```

**3. Public URL.** Twilio needs to reach your laptop over HTTPS. Cloudflare's quick
tunnel needs no account:

```
cloudflared tunnel --url http://localhost:5050
```

It prints something like `https://random-words-here.trycloudflare.com`. `ngrok http
5050` works the same way.

**4. A number.** Either carrier works, and the code is the same on both.

*SignalWire* (`CARRIER=signalwire` in `.env`). Sign up, then Dashboard → API →
create a token; the space is the host in the dashboard URL. Put `SIGNALWIRE_SPACE`,
`SIGNALWIRE_PROJECT_ID` and `SIGNALWIRE_API_TOKEN` in `.env` with your tunnel URL as
`PUBLIC_WEBHOOK_URL`, then:

```
node tools/signalwire-setup.js --search 703     # what is for sale
node tools/signalwire-setup.js --buy +1...      # buy it, pointed at the tunnel
node tools/signalwire-setup.js --check          # what the number points at now
```

*Twilio* (`CARRIER=twilio`, the default). console.twilio.com → Phone Numbers → Buy a
number (US local, Voice). Open it, and under **A call comes in** set:

```
Webhook   POST   https://<your-tunnel-host>/incoming-call
```

`node tools/twilio-setup.js --check` does the same from the terminal.

Save. Call the number.

Two carrier notes worth knowing before you spend an evening on either:

- **A Twilio trial cannot run this bot at all.** `<Stream>` is one of the verbs
  Twilio strips on a trial account. The number fetches the markup, reads out "the
  Stream verb is not available on trial accounts", and hangs up, which looks exactly
  like a bug in this repo and is not one. The account has to be upgraded.
- SignalWire's trial mode limits *who* may call in rather than what the markup may
  contain, so the stream itself runs.

The two carriers differ by two attributes on one line of markup, in
[`src/server.js`](src/server.js): SignalWire wants the codec named and the stream
paced, Twilio rejects both attributes. Everything past that line is identical, since
both send the same frames: `connected`, `start`, `media`, `dtmf`, `mark`, `stop`,
u-law at 8 kHz, keypad presses on the same socket.

---

## What it asks, and in what order

24 fields. The order the bot asks them in is not the order the brief lists them,
and that is deliberate:

| # | Field | Why here |
|---|---|---|
| 1–4 | Name, email, birthday, SMS number | Who is calling. A declined application still has a record. |
| 5–10 | Employment status, pay frequency, monthly income, deployed military, financial assistance, checking or savings | **The five knockouts**, plus the pay cycle. Every reject rule in the brief can be settled from these. |
| 11–13 | Last four of social, routing number, account number | Only reached by an applicant still in play. |
| 14–18 | Address | |
| 19–24 | Employer, department, pay day, employer address and phone | |

Two rules govern that block, and they pull against each other:

**All five are asked, even after one of them has already failed.** Stopping at the
first bad answer would leave a declined application with four empty screening
fields, and a reject row with four holes in it still looks like a row. Two declines
have to be comparable to each other or the rejects are not data. The extra cost is
about twenty seconds of call.

**None of them is acted on until all five have landed.** The block sits ahead of
every sensitive field, so an applicant who is going to be declined never reads a
social security number or a bank account down the phone.

Set `EARLY_KNOCKOUT=0` to ask all 24 questions and decide at the end, which is the
literal reading of the brief. The decision is identical either way; the tests check
both.

The email prints the form back in the brief's own order and wording.

### Three things in the brief I read rather than followed

**"If salary is over 2000 dollars a month."** The bot asks how much, not whether.
A yes/no is the most lossy way to record an income: it answers today's threshold and
nothing else, and the day the threshold moves to 1,800 every stored application has
to be re-collected. The figure is stored, the brief's boolean is computed from it,
and the form still prints the boolean line the brief asked for. Change
`INCOME_THRESHOLD` in `decision.js` and every stored application re-decides from the
number it already holds.

A caller who will not name a figure is asked the yes/no instead, after three tries.
That answer is worth less but it is worth more than an empty field.

Amounts are converted before the comparison, because people answer in the period
they are paid in. Four hundred a week is 1,733 a month, not 1,600, and those two
numbers sit on opposite sides of nothing here but at 480 a week they sit on opposite
sides of the line the brief draws.

**The pay cycle is asked before the income figure**, out of the brief's order, for
one reason: "twelve hundred a paycheck" cannot be converted without knowing what a
paycheck is. Asking it afterwards recorded 1,200 every two weeks as 1,200 a month
and declined a caller earning 2,600. A figure with no period stated is read as
monthly, because that is what the question asked.

There is one boundary the brief contradicts itself on. The field says "over 2000"
and the rule says reject "less than 2000", which disagree at exactly 2,000. This
follows the field and declines at exactly 2,000. One comparison in `decision.js`
flips it.


**"Semiweekly."** The four standard payroll cycles are weekly, biweekly,
*semimonthly* and monthly, and nobody is paid twice a week. The stored value is
`Semiweekly` exactly as the brief writes it, and "twice a month", "semimonthly" and
"twice a week" all land on it, so a caller saying the real thing is understood
either way. Worth confirming which was meant.

**"Pay Frequency Day" and "Specific Day."** Only one of these applies to any given
applicant: a weekly or biweekly payroll has a day of the week, a semimonthly or
monthly one has a day or days of the month. The bot asks whichever fits and writes
`N/A` in the other. Both keys always appear in the output.

---

## The fraud check

The brief says make sure the routing number and account number are real. They are
not the same problem and it is worth being exact about which one is solved.

**Routing number — solved.** Three checks, and the third is the one that matters:

1. Nine digits, and a prefix that was actually issued (00–12, 21–32, 61–72, 80).
2. The ABA check digit: `3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9)` has to end in 0.
3. It has to appear in `data/routing-directory.json`, which is the 18,198 routing
   numbers in the Federal Reserve's FedACH participant file with the institution
   that owns each one.

Step 2 alone is not enough, and this is the interesting case: nine random digits
pass the check digit one time in ten. `310000185` has a valid prefix and a clean
check digit and is not a routing number. Step 3 catches it. Run
`node tools/simulate.js --script fake-routing` to watch it get refused.

The directory is also what lets the bot read the bank's name back — "got it, that's
Chase" — which is how an honest transposition gets caught. Two real numbers that
differ by a transposition are both valid; only the caller knows which is theirs.

Rebuild the file with `npm run fetch-directory`.

**Account number — not solved, and it cannot be here.** Account numbers carry no
check digit. Nothing computed from the digits distinguishes a real account from a
plausible one; only the bank can, through a micro-deposit pair or an instant
account verification provider, and that is an API call made after the phone call
ends. What this does is refuse the shapes that are never accounts: wrong length,
one digit repeated, a straight run like 123456789, the routing number said twice,
the social security digits said again. Those are what a person inventing a number
under time pressure actually produces. Anything past that needs the bank.

---

## The five rules

`src/decision.js`, pure functions over the record, no model involved:

| Code | Fires when |
|---|---|
| `BANK_ROUTING_INVALID` | Routing number missing, malformed, bad check digit, or absent from FedACH |
| `BANK_ACCOUNT_INVALID` | Account number is not a usable account number |
| `ACCOUNT_TYPE_SAVINGS` | Savings rather than checking |
| `NOT_EMPLOYED` | Employment status is Unemployed |
| `INCOME_BELOW_2000` | Monthly income figure is not above 2,000 dollars, or the yes/no backstop said no |
| `DEPLOYED_MILITARY` | Deployed active duty or a dependent |
| `FINANCIAL_ASSISTANCE` | Receiving government assistance |

Three outcomes, not two. **Approved** means every rule was reachable and none
fired. **Declined** means at least one fired. **Incomplete** means the call ended
before the rules could be settled — a routing number nobody could capture leaves
the record short, and failing to hear someone is not the same as catching them.
The email says which fields never landed.

A record with `employment_status: "Unemployed"` and nothing else is Declined, not
Incomplete: a rule that has already failed beats one that was never reached.

Every firing rule is kept, not the first one. A caller who is unemployed, under the
income line and on assistance failed for three reasons and the record says all three.

Every decision carries a `policy_version`. Without it you cannot tell later which
rules an old application actually faced, which makes "would this decline still be a
decline" unanswerable.

Two policy calls I made and would want confirmed:

- **Retired and Student pass `NOT_EMPLOYED`.** The brief says "unemployed", so only
  `Unemployed` trips it. A retiree with a pension over 2,000 a month is approved.
  If that is wrong the fix is one line.
- **The caller is not told which rule declined them.** The bot says it cannot move
  forward and that an email is coming. The reason codes go in the record. Reading
  a decline reason down the phone is a decision for whoever owns compliance.

---

## Hearing people correctly

Digits are where a voice bot fails, and a misheard routing digit is a wrong bank,
not a typo. Three things:

**The keypad.** Twilio delivers touch-tone presses as `dtmf` events on the same
socket as the audio. For the social security digits, routing number, account
number, zip and phone numbers, typed digits go straight into the record and skip
speech recognition entirely. `#` submits, `*` clears. The first press stops the bot
talking.

**Spoken digit forms.** "four eight two one", "forty eight twenty one", "double four
two one" and "4821" all parse to `4821`. Dates work the same way: "March fourth
nineteen ninety four", "oh three oh four ninety four", "3/4/1994". Email addresses
said out loud get "at" and "dot" and "underscore" put back.

**Nothing is guessed.** A value that does not parse is re-asked with the actual
reason ("that number fails the routing number check digit"), not the same sentence
twice. Three failures and the field is left empty rather than written as a guess,
which is what makes the outcome Incomplete instead of wrong. "I'd rather not say"
reads as no answer, not as no.

The caller can also say the last answer was wrong and the bot steps back a question.

---

## What the call records besides the answers

A call is an instrument as well as a form. Three kinds of thing get written that the
application itself has no line for, chosen because none of them can be reconstructed
afterwards.

**The raw words next to the value.** "March fourth nineteen ninety four" is kept
beside `1994-03-04`. If that parse is ever found to be wrong, the raw string can be
re-parsed; the normalized value alone cannot be un-normalized. On the three
sensitive fields neither half is kept, only the digit count, since the application
record already holds the number once.

**What each answer cost.** Seconds on the field, how many tries it took, whether it
arrived by voice or keypad, and which field the call stopped on. A drop-off you
cannot see is a drop-off you cannot fix, and the field-level view is what says
whether the problem is the question or the caller. Timings cannot be backfilled;
they are recorded during the call or they never exist.

**Corrections.** Someone who revises their income after hearing the question again
is a different applicant from someone who said it once, and the final value alone
does not carry that. `undoLast` writes the old value to a correction log instead of
dropping it. On a sensitive field the old value is masked.

All of it lands in `capture` and `capture_metrics` in the JSON, next to the
application rather than inside it.

An email to `REPORT_TO` with three parts: the decision and the reason codes, the
form as `Label: value` lines in the brief's order, and the JSON that would be POSTed
to an underwriting API. Same thing on disk at `calls/<callSid>.json`.

```
Name: Gabriel Kim
Email: gabriel@finosu.com
Birthday: 1994-03-04
...
```

The transcript is kept next to it with the social security digits, routing number
and account number masked — they live in the application record, not in a log line.

Sending uses the Gmail API with a stored refresh token. `messages.send` first,
`drafts.create` + `drafts.send` if the token's scope is short, and if both are
refused the draft is left in the mailbox so an application is never lost to an
OAuth problem.

---

## Cost

| | |
|---|---|
| Twilio US local number | $1.15 / month |
| Twilio inbound voice | $0.0085 / minute |
| OpenAI `gpt-realtime` audio in | ~$0.019 / minute |
| OpenAI `gpt-realtime` audio out | ~$0.077 / minute |

A four-minute call where the bot talks for two of them is about **25 cents**.
`gpt-realtime-2.1-mini` is roughly a third of that if the accuracy holds; the model
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
src/bridge.js     Twilio <-> OpenAI audio, tool calls, keypad.
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

Tests, 259 checks:

```
test/parse.test.js       spoken words -> values
test/validate.test.js    routing checksum, directory, every other field
test/decision.test.js    the five rules over whole records
test/intake.test.js      canned calls end to end
test/changes.test.js     the screening block, income as a figure, capture metrics
test/regressions.test.js one per bug that has actually shipped here
test/bridge.test.js      the call state machine, driven with fake sockets
```

---

## What I would do next

1. **Verify the account number for real.** Plaid or a micro-deposit pair, called
   after the phone hangs up, with the application held pending. Everything in
   `decision.js` is already a pure function of the record, so re-deciding when the
   verification lands is a re-run, not a rewrite.
2. **Recordings and a consent line.** Call recording is a state-by-state consent
   question and there is no recording today. The bot does say up front that what it
   collects is used for the loan decision and nothing else.
3. **Take the same tool contract to a second model.** `save_answer` is the entire
   interface between the voice layer and the application, so swapping in a
   deterministic prompt-per-field flow for the digit questions is a change to
   `bridge.js` alone.
4. **Rate limit by calling number.** Nothing stops someone dialling twenty times to
   probe which routing numbers the directory accepts.
