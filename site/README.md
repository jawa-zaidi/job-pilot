# The JobPilot landing page

This folder **is** the website — the public page someone lands on, reads, and
downloads JobPilot from. It is entirely separate from `public/`, which is the
app itself and runs on the user's own computer.

Plain HTML and CSS with one small script. No build step, no framework, no
dependencies, and nothing loaded from another server: the fonts and icons are
copied in here, so the page works as-is when you drag the folder onto Netlify.

```
site/
  index.html      the whole page, and the two constants you may want to edit
  styles.css      the app's own colour tokens, plus a light/dark swap
  favicon.ico
  fonts/          Instrument Sans + Instrument Serif (copied from public/fonts/)
  icons/          favicons, the Apple touch icon, the social-preview image
```

## The two things you will want to change

Both live in one `<script>` block at the top of `index.html`, right after the
`<meta>` tags. Both are a one-line edit.

### 1. Add the YouTube video

Find this line and put the video ID between the quotes:

```js
const VIDEO_ID = "";
```

The ID is the short code after `v=` in a YouTube link — from
`https://www.youtube.com/watch?v=dQw4w9WgXcQ` the ID is `dQw4w9WgXcQ`. Paste
**only that code**, not the whole URL. Save, redeploy, done.

While it is empty the page shows a tidy "the walkthrough is being recorded"
panel and makes no request to YouTube at all. If you paste something that isn't
ID-shaped (a full URL, say) the placeholder stays up rather than the page
building a broken embed — so a slip is visible, not silently black.

### 2. Change the download link

```js
const DOWNLOAD_URL = "https://github.com/jawa-zaidi/job-pilot/archive/refs/heads/main.zip";
```

Both buttons — macOS and Windows — read from this one constant. Today it points
at GitHub's "download the whole project as a ZIP" link, which is a real working
download. When there is a proper tagged release build, swap in its URL, e.g.
`https://github.com/jawa-zaidi/job-pilot/releases/latest/download/JobPilot.zip`.

The same URL is also written into each button's `href` in the markup as a
fallback for anyone with JavaScript turned off; the script overwrites those from
the constant on load, so editing the constant is enough for every normal
visitor. Update the markup too if you care about the no-JS case.

## Deploying to Netlify

Either route works. Both are free.

### Option A — drag and drop (fastest)

1. Go to <https://app.netlify.com/drop>.
2. Drag this `site` folder onto the page.
3. It deploys immediately and gives you a `something-random.netlify.app` URL.

To use your own subdomain: **Site configuration → Domain management → Add a
domain**, enter e.g. `jobpilot.yourdomain.com`, and add the CNAME record Netlify
shows you at your DNS provider. HTTPS is issued automatically.

Redeploying is another drag-and-drop of the folder.

### Option B — connect the repo (auto-deploys on push)

1. **Add new site → Import an existing project**, and pick the GitHub repo.
2. Set:
   - **Build command:** *(leave empty)*
   - **Publish directory:** `site`
   - **Branch:** whichever branch you want live
3. Deploy.

`netlify.toml` at the repo root already sets `publish = "site"` and an empty
build command, so the settings above should be filled in for you. Every push to
that branch redeploys.

## Working on it locally

No tooling needed — open `index.html` in a browser, or serve the folder if you
want the paths to behave exactly as they will in production:

```bash
python3 -m http.server 8765 --directory site
# then open http://localhost:8765
```

## House rules

- **Everything on the page has to be true of the code as it stands.** The claims
  about ports, the data folder, what is off by default and what has and hasn't
  been tested were all checked against `README.md` and the source. If behaviour
  changes, the page has to change with it.
- **Nothing external.** No CDN, no analytics, no web fonts over the network. The
  only outbound request the page can ever make is the YouTube embed, and only
  once a video ID is set.
- **It gets read on phones.** Most people open a link on their phone first. The
  layout is checked at 375px, and the page says plainly that JobPilot needs a Mac
  or Windows computer so a phone visitor knows what to do next.
