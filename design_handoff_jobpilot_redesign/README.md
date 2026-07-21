# Handoff: JobPilot Dashboard Redesign

## Overview
A visual + IA redesign of **JobPilot** — a localhost job-application autopilot (Kanban dashboard that finds jobs, generates tailored CVs/emails, sends them from the user's Gmail, and tracks follow-ups & replies). The redesign keeps every existing feature but re-skins the app in the warm **Organic** design system (replacing the original dark GitHub-style theme) and improves three things the current UI handles poorly:

1. **First-run onboarding** — a dedicated welcome screen with a 4-step checklist + a large CV drop zone, instead of dumping new users onto an empty board.
2. **The "two-button" flow** — the core Find → Generate → Send cycle is now an explicit "flight plan" strip with the current stage highlighted and the big CTA sitting under it, so the app's rhythm is legible at a glance.
3. **Information hierarchy** — cleaner stat cards, a calmer board, grouped sidebar, and the "Teach the AI" input turned into a single inline pill.

Scope covered: main dashboard (populated + first-run states), job detail drawer, settings modal, profile editor modal, improvement reports modal.

## About the Design Files
The files in this bundle are **design references created in HTML** — a prototype showing intended look and behavior, not production code to copy directly. `JobPilot.dc.html` is a "Design Component" (a streaming HTML format); its `<x-dc>` template + logic class encode the layout and sample data. **The task is to recreate these designs in JobPilot's existing frontend environment** — which is **vanilla JS + a single `public/styles.css`, no build step** (`server/index.js` serves `public/`). So: port the visual language into `public/styles.css` and adjust `public/index.html` / `public/app.js` markup accordingly. Do **not** introduce a framework — match the existing vanilla setup.

The original files being replaced/updated:
- `public/styles.css` — all styling (the big change)
- `public/index.html` — static shell (sidebar, topbar, modals)
- `public/app.js` — renders the board, cards, drawer, stats (structure stays; class names/markup may shift to match new CSS)

## Fidelity
**High-fidelity.** Final colors, typography, spacing, radii, and shadows are all specified below and come from the Organic design tokens (`organic-styles.css`, included). Recreate pixel-close. Behavior/logic is unchanged from the current app — only presentation and the two IA additions (onboarding screen, flight-plan strip) are new.

---

## Design Tokens (Organic system)
Full source in `organic-styles.css`. Key values:

**Color**
- Ground `--color-bg` `#f5ead8` (warm cream) — replaces the old `#0d1117`
- Surface `--color-surface` `#ebddc5` — cards / inputs
- Text `--color-text` `#201e1d`
- Accent (terracotta) `--color-accent` `#c67139`; ramp `-100 #fff2eb … -600 #b2622d -700 #8c491a -800 #643312`
- Accent-2 (sage) `--color-accent-2` `#7a8a5e`; ramp `-100 #f0fae1 … -500 #8fa073 -600 #728157 -700 #56633f -800 #3d472b`
- Neutral ramp `-100 #f9f4ed -200 #eee7db -300 #dcd3c4 -400 #c0b6a5 -500 #a19786 -600 #82796a -700 #645c50`
- Divider `color-mix(in srgb, #201e1d 16%, transparent)`

**Type** — `--font-heading` "Caprasimo" (display, weight 400, used for h1–h6, card titles, stat numbers, buttons), `--font-body` "Figtree" (400/600/700). Google Fonts import is at the top of `organic-styles.css`.

**Radius** — `--radius-sm 8px`, `--radius-md 16px`, `--radius-lg 28px`. Note: the system overrides `.btn, .tag, .seg, .input` to `border-radius: 999px` (fully pill). Cards/dialogs use `~32px`.

**Shadow** — `--shadow-sm 0 1px 2px`, `--shadow-md 0 3px 10px`, `--shadow-lg 0 12px 32px`, all `color-mix` ink-tinted (see file).

**Spacing** — `--space-1 4.4 · -2 8.8 · -3 13.2 · -4 17.6 · -6 26.4 · -8 35.2` (px).

**Icons** — Lucide (https://lucide.dev), stroke-width **2.75**. Inline SVGs used: paper-plane (brand), search, gear, bar-chart, refresh-cw, sparkles, arrow-right, check, chevron-down, upload, mail.

---

## Screens / Views

### 1. Dashboard shell (all states)
- **Layout**: `display:flex; min-height:100vh`. Sidebar **284px** fixed, `sticky top:0 height:100vh`, `background:--color-neutral-100`, right border = divider, `padding:24px 20px`, vertical flex `gap:26px`. Main = `flex:1; padding:26px 30px`.
- **Topbar**: left = `<h1>Dashboard</h1>` (Caprasimo 34px) + muted 13.5px subtitle "Your applications, from discovery to interview." Right = a **segmented control** ("Sample data" / "First run") using `.seg`/`.seg-opt` on `--color-neutral-100`. (This toggle is a demo affordance; in production it's simply whichever real state applies — do not ship the toggle.)

### 2. Sidebar
- **Brand**: 40px terracotta circle (`--color-accent`) with white paper-plane icon + "JobPilot" (Caprasimo 22px) + "Application autopilot" caption (11px, `--color-accent-700`).
- **Profile section**: h6 label "Profile"; a pill profile-switcher button (surface bg, chevron-down); then either the filled profile card (name 700/15px, "Backend Engineer · 6 yrs" muted, skill chips as `.tag.tag-accent-2` 10.5px, "Edit profile" / "Re-upload CV" underlined 12px links) OR the empty prompt card (`--color-accent-100` bg, copy + "Upload CV" primary block button).
- **Find jobs manually**: h6; search input (`.input`, flex:1) + "Search" primary button; then source list — 5 rows, each `dot (8px circle) + name + right-aligned note`. Dot = sage `--color-accent-2-500` when on, `--color-neutral-300` when off.
- **Tools**: two full-width `.btn.btn-secondary` left-aligned with icon+label ("Improvement report", "Settings & API keys"); email-status line (sage 11.5px with check icon).
- **Footer** (`margin-top:auto`, top divider): `.tag.tag-accent-2` "AI: Claude Haiku" + "Reset profile" underlined link.

### 3. Dashboard — populated state (main)
- **Stats row**: `grid-template-columns: repeat(5,1fr) 1.5fr; gap:14px`. Each stat card = surface bg, `radius-md`, `padding:16px 18px`, `shadow-sm`; big number in Caprasimo 30px (color varies: text / sage-700 / accent-600), label 11.5px muted. 6th cell = **Pipeline funnel**: 9 vertical bars (`align-items:flex-end; height:36px; gap:5px`), each bar colored by its column, height = share of max, `border-radius:4px 4px 0 0`.
  Sample values: Jobs found **68**, Applied **31** (sage-700), Follow-ups sent **18** (accent-600), Replies ⭐ **5** (accent-600), Interviews **2** (sage-700).
- **Flight plan panel** (the key IA piece): `--color-neutral-100` bg, `radius-lg`, `padding:20px 22px`, `shadow-sm`.
  - Top row: 3 step chips separated by arrow icons, then "then repeats ↻" (11px muted). Each chip = pill with `24px` numbered circle + title (13px/700) + sub (11px muted). The **active** step (Send) gets `--color-accent-2-100` bg, `--color-accent-2-300` border, sage-800 title; completed steps get a sage-500 filled number; future steps get neutral-300. Steps & subs: **1 Find jobs / 68 on board**, **2 Generate / 2 tailored**, **3 Send / 2 ready now** (active).
  - Action row: primary CTA **"Email 2 applications"** — a solid **sage** button (`background:--color-accent-2-600; color:--color-bg`, 15px, `padding:13px 26px`, mail icon). The send state uses sage; find/generate states would use terracotta `.btn-primary` (mirror the original `renderSmartButton` logic — label & color follow pipeline counts). Beside it: **"Sync — follow-ups & inbox"** `.btn.btn-secondary` with refresh icon. Then a Mode `.seg` (Manual/Auto). Far right: cost line — "last send: $0.04" (sage-700) · "API cost so far: **$1.18**".
- **Teach-the-AI pill**: single row, `--color-accent-100` bg, `radius:999px`, `padding:6px 8px 6px 16px`. "✦ Teach the AI" bold accent-800 label + sparkles icon, a small pill `<select>` (Email/CV/Finding jobs), a flex-1 pill input (placeholder `e.g. "avoid agency jobs", "make emails shorter"`), and a "Save instruction" primary button.
- **Filter bar**: flex-wrap, 12px muted. Pill `<select>` "All stages", two pill date inputs ("Applied from" / "to"), "Clear filters" underlined accent link.
- **Kanban board**: horizontal scroll (`display:flex; gap:14px; overflow-x:auto`). 9 columns, each `min-width:224px; flex:1 0 224px`, `--color-neutral-100` bg, `radius-md`, `padding:12px`, `min-height:260px`, `shadow-sm`. Column head = 9px colored dot + label (13px/700) + right-aligned count pill (surface bg). Columns & dot colors:
  `Discovered` neutral-500 · `Approved` sage-400 · `CV Ready` accent-400 · `Your action ✋` accent-600 · `Applied` sage-600 · `Follow-up` accent-500 · `Replied ⭐` accent-500 · `Interview` sage-700 · `Closed` neutral-400.
  (These map to the original `COLUMNS` array in `app.js` — statuses unchanged: discovered, approved, ready, action, applied, followup, replied, interview/offer, closed/rejected.)
  - **Card**: surface bg, `radius-md`, `padding:12px`, `shadow-sm`, `border:1px solid transparent`; **hover** → `border-color:--color-accent; box-shadow:--shadow-md`. Title 13px/700, "Company · Location" 12px muted. Meta row (`margin-top:9px`, flex-wrap): **score pill** — `>=75` sage (accent-2-200 bg / -800 text), `55–74` terracotta (accent-200 / -800), `<55` neutral (200/700); optional badges (pills 10px): "CV ✓", "@ direct", "rcvd ✓", "Reply ⭐", "Interview 🎉" as sage done-badges; "✋ apply on platform" as terracotta warn-badge. For applied cards, a right-aligned row of 3 **follow-up pips** (7px circles) — sent = accent-500, pending = neutral-300 (days 3/5/10). Cards in Discovered/Approved show a ✕ remove button on hover (top-right).
- **Run log + Activity**: two-column grid (`gap:24px; margin-top:26px`). Each = h4 (Caprasimo 18px) + list of surface `radius-sm` rows (`padding:10px 14px`, 12.5px) with a muted timestamp + text.

### 4. Dashboard — first-run / empty state
Replaces stats+board with a centered `max-width:760px` column:
- Header: 72px accent-100 circle + plane icon, `<h2>` "Welcome aboard, let's get you flying" (34px), muted lead paragraph.
- **4-step checklist**: each = surface `radius-lg` card, `padding:18px 22px`, `shadow-sm`, flex row: 40px numbered circle (step 1 & 4 = filled accent-600/white "required"; 2 = accent-200; 3 = accent-2-200) + title (700/15px) with a small muted tag ("required"/"recommended"/"optional") + sub (13px muted) + a right CTA button (`btn-primary` for required, `btn-secondary` otherwise). Steps: **1 Add an AI key**, **2 Set job preferences**, **3 Connect Gmail**, **4 Upload your CV**. Steps 1–3 open Settings; step 4 opens the file picker.
- **CV drop zone**: `2px dashed --color-neutral-400`, `radius-lg`, `--color-neutral-100` bg, `padding:36px`, centered: upload icon, "Drop your CV to begin" (Caprasimo 20px), format note, "Upload CV" primary button.

### 5. Job detail drawer
Slides from right: `width:min(680px,94vw)`, full-height, `--color-bg` bg, `overflow-y:auto`, `padding:30px 34px`, `shadow-lg`, over a scrim `color-mix(neutral-900 45%)`. Close = 34px circle top-right. Contents top→bottom:
- `<h2>` job title (26px) + "Company · Location · via Source · view posting ↗" (13.5px muted).
- **Match panel**: `--color-accent-2-100` bg, `radius-md`. "Match score: 88%" bold + " · stage: fresh applied" + bullet list of match reasons (accent-2 body).
- **Recruiter email** row: label + `.input` (flex:1).
- **Action buttons** row: "↻ Regenerate" secondary sm, "⬇ CV PDF" secondary, "📧 Send application" sage button, "Remove" pushed right (accent-700 text).
- **Fix box**: `--color-accent-100` bg, `radius-md` — "Not happy with this draft?" + input + "Ask AI to fix" primary.
- **Application email** + **Tailored ATS CV**: h6 labels (CV shows "— keywords: …"); content in `<pre>` blocks — `--color-neutral-100` bg, `radius-md`, `padding:16px`, monospace 12.5px/1.6, CV pre capped `max-height:280px; overflow-y:auto`.
- **Follow-up schedule**: h6 + vertical timeline (`border-left:2px solid divider`, 12px dot per node — sent = accent-500, pending = neutral-300), head 13px/700 + sub 12px muted.
- **Job description**: h6 + scrollable neutral-100 box (`max-height:180px`).

### 6. Settings modal
Centered dialog `width:min(500px,96vw)`, `max-height:90vh` scroll, `--color-bg` bg, `radius-lg`, `padding:28px 30px`, `shadow-lg`, over neutral-900 50% scrim. h2 "Settings" + local-storage note. Sections (each preceded by an h6 uppercase muted label): **Job sources** (checkbox rows — surface `radius-md` cards, `accent-color:--color-accent`; "beta" as `.tag.tag-outline`), **Company career pages** (textarea), **Job preferences** (preferred titles + locations inputs), **AI provider & model** (2-col provider select + model input, then API key password field), **Email — Gmail** (from-name + gmail inputs). Footer: "Save settings" primary + "Send test email to myself" secondary. (Full field list matches original `index.html` settings modal — sources, ATS companies, Adzuna keys, prompts per step, auto-search, guardrails, insights, dev-feedback, SMTP.)

### 7. Profile editor modal
Same dialog chrome. h2 "Edit your profile" + note. 2-col grid: Name / Email / Current title / Years. Then full-width textareas: Skills (comma), Roles (comma), Short summary, Top achievements (one per line). Footer: "Save profile" primary + "Re-upload CV instead" secondary.

### 8. Improvement reports modal
Same dialog chrome. h2 "📊 Improvement reports" + config note ("every 50 applications…"). "Generate report now" primary sm. Then a list of report cards (surface `radius-md`): subject (700/13.5px), meta ("date · trigger: …" 11.5px muted), summary (12.5px). Original uses collapsible `<details>` with the full report `<pre>` — keep that.

---

## Interactions & Behavior
Behavior is **unchanged from the current app** — this redesign only alters presentation + adds the onboarding screen and flight-plan strip. Preserve all existing `app.js` logic:
- **Big CTA button** relabels & recolors by pipeline state (`renderSmartButton`): `Find jobs` (terracotta) → `Generate N CVs & emails` (terracotta) → `Email N applications` (sage). Reflect the active stage in the flight-plan strip too.
- **Sync** button: sends due follow-ups + reads Gmail inbox, then refreshes.
- **Board**: cards are draggable between columns (drop → PATCH status); click opens the drawer; ✕ deletes (discovered/approved only); "✓ all applied" bulk action in the "Your action" column head.
- **Mode** Manual/Auto toggle (auto confirms via dialog).
- **Filters**: stage select + date range filter the board client-side.
- **Drawer**: Regenerate/Ask-AI-to-fix (POST tailor), Send application (POST apply), recipient-email PATCH, mark-rejected, remove, per-day "✓ Mark done" for platform follow-ups.
- **Overlays** close on true backdrop click (mousedown+mouseup on backdrop) or the ✕.
- **Sidebar** collapse toggle persists in `localStorage` (`jp_nav`).
- **Hover**: cards raise + accent border; buttons follow Organic states (primary → accent-600 hover / -700 active; secondary → ink tint; ghost → accent tint). Keyboard focus = `2px solid --color-accent` outline, offset 2px (already in `organic-styles.css`).

## State Management
Client state mirrors the current app: `state = { applications, stats, settings, openId, currentRun, lastRunCost }`, `filters = { stage, from, to }`. Data comes from the Express API (`/api/applications`, `/api/stats`, `/api/settings`, `/api/profiles`, `/api/runs`, `/api/insights`). The new **first-run detection**: show the onboarding screen when there is no profile/CV yet (the current app already opens Settings automatically on first run — extend that to the dedicated onboarding view). No new backend needed.

## Assets
- **Icons**: Lucide inline SVGs, stroke-width 2.75 (paper-plane, search, gear, bar-chart, refresh-cw, sparkles, arrow-right, check, chevron-down, upload, mail). No image assets.
- **Fonts**: Caprasimo + Figtree via the Google Fonts `@import` at the top of `organic-styles.css`.
- Emoji in labels (✋ ⭐ 🎉 📊 ✈️) are retained from the original copy.

## Files
- `JobPilot.dc.html` — the full interactive redesign prototype (all screens + both states + working overlays). Open in a browser to explore; toggle "Sample data" / "First run" top-right; click any card to open the drawer; sidebar buttons open Settings/Reports/Profile.
- `organic-styles.css` — the Organic design-system stylesheet (source of truth for every token, ramp, and component class). Port these values into `public/styles.css`.
