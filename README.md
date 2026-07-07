# JobPilot ✈️

Job application autopilot: find best-fit jobs → tailored ATS CV + email per job (fact-checked, no invented claims) → email them in bulk from your own Gmail with the CV attached as PDF → automatic follow-ups (day 3, 5, 10) → inbox sync that classifies replies (confirmation / rejection / interview / real reply) → AI improvement reports. Kanban dashboard with stage & date filters, multiple profiles, and a per-run cost ledger.

**Two apply paths, routed automatically:**
- **Email path** — when a recruiter address is found in the posting, JobPilot emails the application directly (CV attached as PDF) and tracks follow-ups.
- **Your action ✋ path** — when a job needs applying on the platform (career page, LinkedIn, Naukri), the card moves to the *Your action* column with the tailored CV & message ready to copy in; you apply, click *"I applied"*, and tracking starts.

## Install — one command

Requires [Node.js LTS](https://nodejs.org) (the script tells you if it's missing).

```bash
git clone https://github.com/jawa-zaidi/job-pilot.git
cd job-pilot
bash setup.sh        # macOS / Linux
setup.bat            # Windows (or just double-click it)
```

That installs everything, starts the app, and opens http://localhost:4310.

**First run:** the app sees there's no data yet and opens the setup screen automatically — pick your AI provider (Groq free / OpenAI), paste a key, optionally add Gmail, choose job sources, close, upload your CV.

**Updating:** quit the app (Ctrl+C) and run the setup command again — it pulls the latest version and restarts. Your data is never touched by updates.

**Your data** lives in one portable folder: `~/JobPilotData` (shown in Settings). To move to a new device: copy that folder to the same place on the new computer, run setup there — the app opens with all your profiles, applications and history intact.

## Daily use — two buttons

1. **The big button** — its label follows the state of your run:
   `🔍 Find jobs` → fetches unrepeated, well-matched jobs (poor fits auto-filtered) →
   `⚡ Generate CVs & emails` → tailors every job on the board (remove bad picks with ✕ first) →
   `📧 Send N applications` → one confirm, everything goes out. Then it cycles back to Find jobs.
2. **🔄 Sync** — sends every follow-up that has come due (they also go out automatically while the app runs), reads your Gmail inbox for recruiter replies, and refreshes the whole dashboard.

**Auto mode** runs the entire cycle unattended on a schedule (default every 6h) and emails you a report after each run.

**Teach the AI** box: type feedback like "avoid agency jobs" or "shorter emails" at any point — it's saved to the custom system prompt (editable in Settings) and applied to all future scoring, CVs, emails and follow-ups.

**Improvement reports:** every 50 applications (configurable) and after each auto run, the app analyzes your results — reply rates by match score and source, gaps, what's working — and emails you concrete improvement points. Also viewable via the 📊 button.

**Multiple profiles:** the dropdown at the top of the sidebar — each profile has its own CV, applications and history. Everything you do applies to the selected profile.

## Follow-up logic

Timestamps for every apply and follow-up are stored, so schedules survive restarts and device moves (real clock, no tricks). Follow-ups stop the moment a reply is detected; 3 days after the final (day-10) follow-up with no reply, the application auto-closes as "no response".

## Job sources

- **Company career pages (best quality, free)** — list company board names in Settings and JobPilot pulls openings straight from their public Greenhouse / Lever / Ashby / SmartRecruiters APIs: fresher than any job board, near-zero dead listings, links go to the real application form.
- **Free boards** — Remotive, RemoteOK, Arbeitnow (on by default).
- **Adzuna** — free API credentials, broad coverage incl. India (set your country code).
- **LinkedIn & Naukri** — via Apify token (beta).

## Quality guardrails

- **Ranking** — LLM match score + boosts for freshness (<48h), a direct recruiter email, and career-page sources; duplicates/reposts across boards are skipped (canonical company+title identity), and companies you applied to recently are cooled down (default 14 days).
- **Fact-check** — every tailored CV & email passes a second AI review that removes invented skills/claims before anything goes out.
- **Liveness check** — each posting is re-fetched right before sending; expired jobs are closed, not applied to.
- **Auto-mode threshold** — autopilot only sends matches above your threshold (default 70%); weaker fits wait on the board for your review.

## Run log & costs

One **run** = one find → generate → send cycle (manual or auto). Every run is logged on the dashboard with what happened (found / tailored / emailed / queued for you / expired) and its real cost — AI tokens and paid source APIs separately.

### What do 100 applications cost?

Rule of thumb: to **apply** to 100 jobs, JobPilot **finds and scores ~200** (you remove weak fits, some expire), tailors + fact-checks ~120, sends the rest, then runs follow-ups and inbox syncs for weeks. All of that together is roughly **1.3M input + 0.4M output AI tokens**, plus source-API fees. Sending email and follow-ups via Gmail is free.

| Setup | AI cost | Source cost | Total / 100 applications |
|---|---|---|---|
| Free boards + career pages + Adzuna, Groq free tier | $0 | $0 | **$0** (slow — daily token limits) |
| Same sources, Groq `llama-3.1-8b-instant` paid | ~$0.10 | $0 | **≈ $0.10** |
| \+ LinkedIn & Naukri via Apify | ~$0.10–1 | ~$1.50–3 | **≈ $2–4** |
| OpenAI `gpt-4o-mini` + all sources | ~$0.50 | ~$1.50–3 | **≈ $2–4** |
| Groq `llama-3.3-70b` + all sources | ~$1.10 | ~$1.50–3 | **≈ $3–5** |
| Claude Haiku (best quality/$) + all sources | ~$3.30 | ~$1.50–3 | **≈ $5–7** |

Follow-ups and inbox syncs are ~15–20% of the AI total (already included). The Run log shows your real numbers — these are planning estimates.

## Architecture

- `server/index.js` — Express API + static frontend (port 4310)
- `server/llm.js` — LLM layer: Groq/OpenAI, scoring, tailoring, fact-check, inbox classification, mock fallbacks
- `server/discovery.js` — job discovery, dedup/cooldown, ranking + auto-search scheduler
- `server/batch.js` — pipeline (fetch / approve / generate / send / auto cycle) with apply-path routing
- `server/jobs.js` — source orchestration, canonical job identity, recruiter-email extraction
- `server/sources/` — ATS career pages (Greenhouse/Lever/Ashby/SmartRecruiters), Adzuna, Naukri (Apify)
- `server/verify.js` — just-in-time posting liveness check
- `server/pdf.js` — tailored CV → PDF attachment
- `server/runs.js` — per-run outcome + cost ledger
- `server/followups.js` — follow-up scheduler + no-response auto-close (email path only)
- `server/email.js` — Gmail SMTP sending with attachments (from your name)
- `server/inbox.js` — Gmail IMAP + AI reply classification (confirmation / rejection / interview / human reply)
- `server/insights.js` — auto feedback: pipeline analysis + improvement report emails
- `server/db.js` — multi-profile JSON store in the portable data folder
- `public/` — vanilla-JS dashboard, no build step

## Roadmap

Direct form-fill for Greenhouse/Lever applications (Playwright), LinkedIn hiring-post mining for recruiter contacts, browser extension for assisted Easy Apply/Naukri applies on your own session, PDF CV export from the drawer, packaged desktop app, deploy-to-server for 24/7 operation.
