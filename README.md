# JobPilot ✈️

Job application autopilot: find best-fit jobs → tailored ATS CV + email per job → send in bulk from your own Gmail → automatic follow-ups (day 3, 5, 10) → inbox sync for reply detection → AI improvement reports emailed to you. Kanban dashboard with stage & date filters, multiple profiles.

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

## Architecture

- `server/index.js` — Express API + static frontend (port 4310)
- `server/llm.js` — LLM layer: Groq/OpenAI, model override, custom system prompt, mock fallbacks
- `server/discovery.js` — job discovery + auto-search scheduler
- `server/batch.js` — pipeline (fetch / approve / generate / send / auto cycle)
- `server/jobs.js` — job sources (Remotive live; LinkedIn via Apify token; Naukri soon)
- `server/followups.js` — follow-up scheduler + no-response auto-close
- `server/email.js` — Gmail SMTP sending (from your name)
- `server/inbox.js` — Gmail IMAP reply detection
- `server/insights.js` — auto feedback: pipeline analysis + improvement report emails
- `server/db.js` — multi-profile JSON store in the portable data folder
- `public/` — vanilla-JS dashboard, no build step

## Roadmap

Naukri source, Playwright for no-API boards, recruiter-email auto-extraction from postings, PDF CV export, packaged desktop app (no Node install needed), deploy-to-server for 24/7 operation.
