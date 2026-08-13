# JobPilot ✈️

JobPilot is a job-application autopilot that runs on your own computer. It finds jobs that
actually fit you, rewrites your CV for each one, writes the email that goes with it, sends it
from your own Gmail, chases it up on days 3, 5 and 10, reads the replies, and tells you what's
working. Everything stays on your machine.

You do not need to be technical to use it. There is nothing to type into a terminal, and the
setup questions never ask you for an API key.

The public landing page that explains all this to a newcomer lives in [`site/`](site/) and deploys
to Netlify as a static folder — see [`site/README.md`](site/README.md).

**Two ways an application goes out. You choose which**, in the welcome questions or at any
time in Settings → *Sending applications*:

- **You send them** *(the default)* — JobPilot writes everything and hands it to you. Each one
  lands in **Needs you** with the tailored CV and the message ready to copy, plus a prefilled
  email if there is an address. You send it, press *"I've sent it — start tracking it"*, and
  tracking starts from there. JobPilot never puts mail on the wire in this mode, and never
  chases anyone in your name — it reminds *you* on days 3, 5 and 10 instead.
- **JobPilot sends them** — where the posting gives us a recruiter address, JobPilot emails the
  application with your tailored CV attached as a PDF and chases the follow-ups itself. Jobs
  with no address (or that can only be applied for on the company's own site, LinkedIn or
  Naukri) still come to you under **Needs you**.

Changing your answer re-routes everything already written, both ways, straight away.

---

## Install — double-click, no terminal

You need [Node.js](https://nodejs.org) on the computer. If it isn't there, JobPilot opens the
download page for you and tells you what to do — you never have to go looking.

### macOS

1. Download the JobPilot ZIP from GitHub: open
   [the project page](https://github.com/jawa-zaidi/job-pilot), press the green **Code**
   button, choose **Download ZIP**.
2. Double-click the downloaded ZIP to unpack it, then open the `job-pilot` folder inside.
3. **Right-click `JobPilot.command` → Open → Open.**

   > Do not just double-click it the first time. macOS will say *"cannot be opened because it
   > is from an unidentified developer"* and refuse — it looks like the app is broken, and it
   > isn't. Right-click → Open is the way past it, and you only ever have to do it **once**.
   > (There is no way around this without a paid Apple signing certificate, which this
   > project doesn't have.)
4. A Terminal window appears and does everything itself: gets the parts it needs (about a
   minute, first time only) and opens JobPilot in its own Chrome window. **Leave that window
   open** — it is the app running. Ctrl+C in it quits JobPilot.
5. From then on there is a **`JobPilot.app`** in the same folder, created automatically on
   that first run. Double-click that instead and there's no Terminal window at all. You can
   drag it into your Applications folder.

### Windows

> Honest warning: this path has been written carefully but **has never been run on a real
> Windows machine**. See *Status / known gaps* at the bottom.

1. Download the ZIP the same way, right-click it → **Extract All**.
2. Open the extracted folder.
3. Double-click **`JobPilot.bat`**.
4. A window appears and does the rest: gets what it needs, then opens JobPilot in its own
   Chrome window. Leave the window open; Ctrl+C quits.
5. On that first successful run it also puts a **JobPilot** shortcut on your Desktop and in
   the Start Menu. Use those from then on. (`install\create-shortcuts.bat` makes them again
   if you ever delete them.)

### If something is in the way

- **Port already busy** — JobPilot moves to the next free port by itself and tells you which
  one it used. No error to decipher.
- **Already running** — double-clicking again just brings the existing one to the front.
- **No Chrome** — it opens in your normal browser instead. Everything works; you just don't
  get the tidy app window, and you can't install it as an app (see below).

### The developer route

Still supported, still the same behaviour — it just isn't the headline any more:

```bash
git clone https://github.com/jawa-zaidi/job-pilot.git
cd job-pilot
bash setup.sh        # macOS / Linux
setup.bat            # Windows
```

`setup.sh` / `setup.bat` are now thin wrappers around the same launcher the double-click files
use (`install/preflight.sh` → `install/launch.js`), so all three routes do exactly the same
thing. `npm run launch` works too. Useful switches: `PORT=…`, `JOBPILOT_NO_BROWSER=1`
(don't open a browser), `JOBPILOT_NO_APP=1` (don't generate `JobPilot.app`).

**Updating:** quit JobPilot (Ctrl+C, or close the window) and start it again. If you installed
with `git clone`, it pulls the latest version on the way up. Your data is never touched by an
update.

**Your data** lives in one portable folder: `~/JobPilotData` (the exact path is in
Settings → Advanced → *Where your data lives*, with a Copy button). To move to a new computer:
copy that folder over, start JobPilot there, and everything — profiles, applications, history
— is back.

> **Runs on this computer only, by default.** The server binds to `127.0.0.1`, so nothing else
> on your network can reach it. To open it to other devices (run it on one machine, use it
> from another), start it with `HOST=0.0.0.0` or `JOBPILOT_LAN=1`; a warning is logged
> whenever LAN mode is on. Only do this on a network you trust — anyone who can reach the app
> can read your CV, change your settings and send email from your Gmail.

## Install it as an app (optional)

JobPilot is a proper installable web app. Installing it gives you a Dock/Taskbar icon and a
standalone window with no address bar and no tabs — same app, same data, same computer.

1. Start JobPilot however you normally do — the double-click launcher, or
   `http://localhost:4310` in an ordinary Chrome tab. Either works.
2. JobPilot shows a small bar at the top of Home: *"Keep JobPilot in your Dock"* → press
   **Install it**. (In a normal tab you can also use Chrome's own menu: ⋮ → *Cast, save and
   share* → *Install page as app…*.)
3. Confirm Chrome's *"Install app?"* dialog. Afterwards you launch JobPilot from the Dock /
   Start menu like any other app.

> **The launcher window counts too.** The double-click launcher opens JobPilot in a Chrome
> *app-style* window, which Chrome reports as "standalone" even though nothing is installed
> yet — so the launcher tells JobPilot it opened that window (`?opened-by=launcher`) and the
> install offer still appears. An app you have genuinely installed, opened from the Dock,
> starts at plain `/` with no such marker and is never asked again.
>
> **Installing does not remove the need for the server.** JobPilot's data lives on this
> computer and is served by the JobPilot process, so keep starting it the usual way; the
> installed icon is the window, not the engine.

Once installed, the shell also loads offline — you land in JobPilot rather than on Chrome's
dinosaur, with a plain notice saying the live data is paused and nothing is lost. Live data is
never cached; it always comes from the server.

Safari doesn't offer this prompt. *Share → Add to Home Screen* on iOS still produces a
standalone app with the right icon.

## First run — five questions, no key

A brand-new install opens straight into the welcome questions. The header disappears and you
get one question at a time, with your answers stacking above as a conversation:

1. **What should we call you?** — the name companies will see.
2. **Your CV** — drag one file in (PDF, Word or plain text). JobPilot reads it and shows you
   what it understood, so you can catch it being wrong before anything else happens. You can
   skip this and do it later.
3. **What kind of job are you after?** — tap the suggestions it read out of your CV, or type
   your own.
4. **Where would you like to work?** — "anywhere I can work from home", a city, or both.
5. **Who presses send?** — JobPilot emails applications for you, or it writes everything and
   you send them yourself. Both are complete answers; nothing is worse for picking the second.

**It never asks for an API key, an account, or a password.** That is the point. There is a
**Skip** link on every question, and if you close the tab halfway through you come back to the
question you were on.

The two things it genuinely needs, it asks for **later, at the moment it needs them**:

- **An AI writer** — asked the first time a run needs to read a job advert. If you have a
  Claude subscription signed in on the machine, that option is offered first and there is
  nothing to paste. Otherwise it offers a free Groq key, with the link and a paste box. You
  can also say *"carry on without one for now"* — JobPilot will still go and find you real
  jobs, it just can't read them closely or write your applications yet.
- **Your Gmail details** — asked the first time you press send, and only if you chose
  "JobPilot sends them for me". If you chose to send them yourself, you are never asked.

Existing installs are not dragged through any of this.

## The app — five screens

The header has four places to go, plus **You** on the right, and a light/dark toggle. It
starts light and follows your computer's setting until you choose. (The welcome questions are
a sixth screen, but you only ever see it once.)

- **Home** — the one screen you look at. A greeting, three numbers (waiting to hear back,
  interviews booked, sent in total), anything that **needs you** right now, and a timeline of
  what JobPilot has been doing, written as sentences rather than log lines. The big button
  lives here and moves to wherever the next thing to do is. Under *"More things you can do"*:
  search for one particular job, let JobPilot run on its own, teach it a rule as you go, switch
  between searches, replay the setup questions, start over.
- **My jobs** — every job, in four groups: **Needs you**, **Good news**, **We're waiting**,
  **Closed**. No percentages — a job is a *strong fit*, a *good fit* or a *weak fit*. Click any
  row and a panel slides over with the whole story: why it fits, the CV written for it, the
  message, what happens next, and every action (send it, write it again, rewrite it with an
  instruction, download the PDF, copy the text, "they said no", "not interested").
- **How it's going** — a one-minute read. One sentence summarising where you are, which
  sources your replies actually come from, one or two concrete things worth changing, what
  it has cost you so far (with the per-run breakdown folded away), and the longer AI-written
  write-up if you want it.
- **Settings** — four cards and one shut *Advanced*: **Your CV and details**, **What you're
  looking for**, **Sending applications**, **The writer**. Each card says its current state in
  plain words and saves itself. Advanced holds the things most people never need: extra job
  boards and their keys, your own instructions to the writer, quality checks, progress
  reports, usage sharing, where your data lives, who can reach JobPilot.
- **You** (the avatar, top right) — your name, CV and the details companies see, plus
  "More than one search" for keeping separate profiles, each with its own CV, jobs and history.

## Daily use — two buttons

1. **The big button on Home** — its label tells you what pressing it will do next:
   `Find my first jobs` / `Find more jobs` → `Write N applications`, then back round again. If
   you asked JobPilot to send for you, a third step appears — `Send N applications`. If you
   send them yourself the button never offers to send, because it never will: the written
   applications go to **Needs you** instead.
2. **Check for replies** — reads your Gmail for recruiter replies and classifies them, deals
   with any follow-ups that have come due, and refreshes everything. On the applications
   JobPilot emailed, a due follow-up is sent (they also go out automatically while the app is
   running). On the ones you sent yourself, or that were applied for on a company's own site,
   nothing is emailed in your name — a reminder to nudge them appears on the timeline instead.

**Let JobPilot run on its own** (Home → *More things you can do* → *Who starts each round?*)
runs the whole cycle unattended on a schedule (default every 6 hours) and emails you a report
after each round. It only sends matches above your threshold (default 70%); weaker fits wait
for you.

**Teach the writer:** Settings → Advanced → *Your own instructions to the writer*. Three boxes
— one for choosing which jobs to go for, one for your CV, one for the message. Anything you
put there applies to all future scoring, CVs, emails and follow-ups.

**Progress reports:** every 50 applications (configurable) and after each unattended round,
JobPilot analyses your results — reply rates by match score and source, gaps, what's working —
and emails you concrete improvement points. Readable on *How it's going*.

## Follow-up logic

Timestamps for every apply and follow-up are stored, so schedules survive restarts and moves to
a new computer (real clock, no tricks). Follow-ups stop the moment a reply is detected; 3 days
after the final (day-10) follow-up with no reply, the application closes itself as "no
response".

That automatic close applies to applications JobPilot emailed itself. The ones you sent — and
the ones applied for on a company's own site — are yours to close, because JobPilot has no way
of knowing what happened to them. It reminds you on the same day 3 / 5 / 10 cadence.

## The AI writer

JobPilot uses an AI service for four things: scoring how well a job fits you, writing the
tailored CV and email, fact-checking what it wrote against your real CV, and classifying the
replies that come back. Pick one in **Settings → The writer**. With no writer connected the app
runs in **mock mode** — it still finds you real jobs, but the CV and message it produces are
rough placeholders, not something you'd want a company to read.

### Claude subscription (no API key)

If you already pay for **Claude Pro or Max**, JobPilot can use that instead of a key.

- **What it needs:** the [Claude Code](https://claude.com/code) CLI installed on this computer
  and signed in (`claude login`, once). JobPilot detects it and shows a live green/amber line
  in Settings under the option.
- **No API key. Nothing to paste. No per-token bill.** The run log shows `$0.00` for AI on
  these runs and your lifetime cost total does not move.
- **The honest caveat:** it is not free, it's *included*. It spends your **subscription usage
  allowance** — the same allowance you use when you talk to Claude yourself. A big batch run
  can eat through a Pro plan's allowance quickly. That is exactly why the default model here is
  `claude-haiku-4-5`: it's the lightest on usage limits, not the cheapest in dollars. Put
  `claude-sonnet-5` in the model box for better CVs at no extra charge — but it will use your
  allowance faster.
- Nothing about your Claude account is stored or logged. JobPilot reads only whether you're
  signed in and which plan you're on, and it runs the CLI with no tools and a neutral working
  folder, so it can't touch your files.
- If the CLI isn't there, or isn't signed in, this behaves exactly like a missing API key: a
  plain message saying what to do, and mock output — never a crash.

### API-key providers

- **Groq** — free tier, fast, two minutes to set up; default `llama-3.3-70b-versatile`. This is
  the one to pick if you don't have a Claude subscription.
- **OpenAI (ChatGPT)** — default `gpt-4o-mini`.
- **Anthropic (Claude) API key** — default `claude-haiku-4-5-20251001`. Pay-per-token; if you
  have a Pro/Max subscription, the option above costs you nothing extra instead.

Keys can also come from `GROQ_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in `.env`, but
you never have to touch a file — pasting them in Settings is the normal way.

## Job sources

Set **the kinds of job you want** in Settings → *What you're looking for* — they are searched
first (before roles guessed from your CV) and matching jobs rank higher.

- **Company career pages (best quality, free)** — list company board names in Settings →
  *What you're looking for* → *Companies you'd like to work for*, and JobPilot pulls openings
  straight from their public Greenhouse / Lever / Ashby / SmartRecruiters / Recruitee /
  Workable APIs: fresher than any job board, near-zero dead listings, links go to the real
  application form. No key, no account, and the highest reply rate of any source.
- **Free boards** — Remotive, RemoteOK, Arbeitnow (on by default, nothing to set up).
- **Adzuna** — free API credentials, broad coverage incl. India (set your country code).
- **LinkedIn & Naukri** — via an Apify token. Off by default.

> ⚠️ **LinkedIn & Naukri — the risk is yours.** These two sites do not allow other tools to read
> their listings, so reading them through Apify may go against those sites' own terms. That is why
> they start off. Turn them on only if you accept that. The free boards and company career pages
> carry no such question, and career pages tend to get the best replies anyway.
>
> The same note is shown in the app, next to the two switches (Settings → *Advanced* →
> *Extra job boards*).

### Gmail sending limits

Application emails and follow-ups send from your own Gmail over SMTP, using a Google app
password (not your normal password — it only works for sending and reading mail, it stays on
this computer, and you can cancel it any time). Gmail caps a regular account at roughly
**500 recipients/day** (~2,000 for Google Workspace), and bursts of near-identical mail can
trip spam heuristics. JobPilot already spaces out real sends, but keep the number of jobs per
round sensible (the default is 50) and expect occasional throttling if you push high volumes.

## Quality guardrails

- **Ranking** — AI match score plus boosts for freshness (<48h), a direct recruiter email,
  career-page sources, and jobs matching the titles you asked for; duplicates and reposts
  across boards are skipped (canonical company+title identity), and companies you applied to
  recently are cooled down (default 14 days).
- **Fact-check** — every tailored CV and email passes a second AI review that strips invented
  skills and claims before anything goes out. When it corrects something, the job's panel says
  so.
- **Liveness check** — each posting is re-fetched right before sending; expired jobs are
  closed, not applied to.
- **Threshold for unattended rounds** — JobPilot only sends matches above your threshold
  (default 70%) on its own; weaker fits wait for your review.

## What it costs

One **round** = one find → write → send cycle, whether you pressed the button or JobPilot ran
it on its own. Every round is logged with what happened and what it really cost — AI tokens and
paid source APIs counted separately. *How it's going* shows the total and the breakdown.

Rule of thumb: to **apply** to 100 jobs, JobPilot **finds and scores ~200** (you drop weak fits,
some expire), writes and fact-checks ~120, sends the rest, then runs follow-ups and inbox
checks for weeks. All of that together is roughly **1.3M input + 0.4M output AI tokens**, plus
source-API fees. Sending email and follow-ups via Gmail is free.

| Setup | AI cost | Source cost | Total / 100 applications |
|---|---|---|---|
| Any sources + **Claude subscription** | $0 | $0 (free sources) | **$0 in money** — spends your Pro/Max usage allowance instead |
| Free boards + career pages + Adzuna, Groq free tier | $0 | $0 | **$0** (slow — daily token limits) |
| Same sources, Groq `llama-3.1-8b-instant` paid | ~$0.10 | $0 | **≈ $0.10** |
| \+ LinkedIn & Naukri via Apify | ~$0.10–1 | ~$1.50–3 | **≈ $2–4** |
| OpenAI `gpt-4o-mini` + all sources | ~$0.50 | ~$1.50–3 | **≈ $2–4** |
| Groq `llama-3.3-70b` + all sources | ~$1.10 | ~$1.50–3 | **≈ $3–5** |
| Claude Haiku API key (best quality/$) + all sources | ~$3.30 | ~$1.50–3 | **≈ $5–7** |

Follow-ups and inbox checks are ~15–20% of the AI total (already included). The subscription row
costs nothing in dollars but is **not** unlimited — see the caveat above. Your real numbers are
in *How it's going*; these are planning estimates.

## Privacy & telemetry

JobPilot stores everything locally in `~/JobPilotData` and talks only to the services you
configure (your AI provider, your Gmail, the job sources you turned on). Nothing goes to the
JobPilot developer unless you opt in. The typefaces are bundled with the app, so it doesn't
even call out to a font CDN on launch.

**Developer usage feedback — OFF by default (opt-in).** If you turn on *"Sharing usage numbers
with the developer"* in Settings → Advanced, then roughly every 6 days the app emails the
developer an **aggregate, no-PII** report: counts of jobs found and applied to, which sources
were used, error categories, run costs, and your AI provider/model. It never includes names,
companies, job titles, or the contents of any email. Because the report is sent **from your own
Gmail**, the developer does see the address it arrives from — it is content-anonymous but not
sender-anonymous. Turn it off at any time; it is off until you turn it on.

## Status / known gaps

This is an honest list, not a disclaimer. The work described above is new and has **not** been
fully tested end to end.

- **The Windows install path has never been run on real Windows.** `JobPilot.bat`,
  `install\preflight.bat` and the Desktop / Start Menu shortcut script were written and
  reviewed line by line, but no one has double-clicked them on an actual Windows machine.
  Expect to hit something. The macOS path has been run repeatedly, including from folders with
  spaces and brackets in the name, and with Node.js deliberately missing.
- **No real Gmail send has been done.** Saving your Gmail details, the "send myself a test"
  button and the failure messages have been exercised; an actual application email leaving an
  actual inbox has not. The same code sent mail before this revamp, but treat your first send
  as the test.
- **No working API key has been tested end to end.** Only a deliberately-bad key (to prove the
  error message is honest and the run refuses to start) and the Claude-subscription route,
  which was driven against a real signed-in CLI and did produce real scoring and real profile
  extraction. If you paste a Groq/OpenAI/Anthropic key and something is off, that path is the
  least-travelled one.
- **The Chrome "Install app?" dialog has never been eyeballed on a clean machine.** The offer
  itself is verified — including inside the launcher's app-style window, which reports itself
  as already-standalone and so needs the `?opened-by=launcher` marker described above to be
  offered at all. What nobody has watched is the last step: Chrome's own native dialog, the
  icon landing in the Dock, and the installed chrome-less window opening from it.
- **The new welcome questions were walked with a plain-text CV.** PDF upload had a real bug
  (a pooled-Buffer misread in the PDF parser, which made valid PDFs fail most of the time) and
  it is fixed, but the fix has not been through the welcome flow with a wide range of real
  CVs. If a PDF misreads, that is worth reporting.
- **Dragging a job between columns is gone** along with the old board. Everything you'd
  actually want is still there as a button ("They said no", "I've applied", "Not interested"),
  but there is no longer a way to move a job backwards to an earlier stage by hand.

## Architecture

- `server/index.js` — Express API + static frontend (port 4310, localhost only by default)
- `server/llm.js` — AI layer: Groq / OpenAI / Anthropic / Claude Code CLI, scoring, tailoring,
  fact-check, inbox classification, mock fallbacks
- `server/prompts.js` — the quality-critical system prompts, in one place
- `server/discovery.js` — job discovery, dedup/cooldown, ranking + auto-search scheduler
- `server/batch.js` — pipeline (fetch / approve / generate / send / unattended round);
  `sendPath()` here is the single place that decides who sends an application
- `server/jobs.js` — source orchestration, canonical job identity, recruiter-email extraction,
  LinkedIn via Apify
- `server/sources/` — ATS career pages (Greenhouse/Lever/Ashby/SmartRecruiters/Recruitee/
  Workable), Adzuna, Naukri
- `server/verify.js` — just-in-time posting liveness check
- `server/pdf.js` — tailored CV → PDF attachment
- `server/runs.js` — per-round outcome + cost ledger
- `server/costs.js` — cost ledger, including "included in your subscription" at $0
- `server/followups.js` — follow-up scheduler + no-response auto-close (email path only)
- `server/email.js` — Gmail SMTP sending with attachments
- `server/inbox.js` — Gmail IMAP + AI reply classification
- `server/insights.js` — pipeline analysis + improvement report emails
- `server/devfeedback.js` — the opt-in aggregate usage report
- `server/db.js` — multi-profile JSON store in the portable data folder; also the one place
  that answers "who presses send" and "have they been welcomed"
- `server/log.js` — keeps developer diagnostics off the Terminal window people are told to
  leave open. Stack traces and full errors go to `jobpilot-log.txt` in your data folder
  (rolled at 1 MB); the window gets at most one calm sentence every five minutes. Set
  `JOBPILOT_VERBOSE=1` to put everything back on screen.
- `public/` — vanilla-JS front end, no build step: five screens plus the welcome questions, a
  router, a service worker and a web manifest
- `install/` — the shared launcher (`launch.js`) behind every way of starting the app, the
  Node.js finder, the macOS `.app` generator and the Windows shortcut scripts
- `scripts/` — `generate-icons.js` (every app icon) and `generate-social-card.js` (the 1200×630
  link preview), both from scratch with Node built-ins only, no image library
- `site/` + `netlify.toml` — the public landing page and its Netlify config; `site/` is the
  publish root and makes no external requests
- `test/smoke.test.js` — `npm test`, the mock-mode smoke suite (no keys and no network needed)

Scripts: `npm start` (server only), `npm run launch` (the full launcher), `npm run make-app`
(regenerate `JobPilot.app` on macOS), `npm test`.

## Roadmap

Direct form-fill for Greenhouse/Lever applications (Playwright), LinkedIn hiring-post mining for
recruiter contacts, a browser extension for assisted Easy Apply / Naukri applies on your own
session, a signed macOS build so the right-click-Open step goes away, deploy-to-server for 24/7
operation.
