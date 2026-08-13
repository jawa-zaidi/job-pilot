#!/usr/bin/env node
'use strict';

// JobPilot launcher — the shared brain behind every way of starting the app.
//
//   macOS    JobPilot.command / JobPilot.app  -> install/preflight.sh -> here
//   Windows  JobPilot.bat                     -> install\preflight.bat -> here
//   Anyone   npm run launch                   -> here
//
// It installs dependencies quietly, makes sure the data folder exists, starts
// the server in the foreground, and opens the app in a Chrome app-style window
// so it can be installed as a PWA in one click.
//
// Node built-ins only. No dependencies, no build step.

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// A copy downloaded from the website has a Node runtime in runtime/ and its
// dependencies already in place, so there is nothing to fetch and no npm to
// fetch it with. A `git clone` has neither, and takes the original path.
const BUNDLED = fs.existsSync(path.join(ROOT, 'runtime'))
  && fs.existsSync(path.join(ROOT, 'node_modules'));

// Anything we start should find the same Node we are running on, not whatever
// else happens to be installed.
process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`;

// The .app bundle runs us with no visible console, so it wants desktop
// notifications instead of console lines.
const NOTIFY = process.env.JOBPILOT_NOTIFY === '1' && IS_MAC;

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function notify(message) {
  if (!NOTIFY) return;
  try {
    spawnSync('/usr/bin/osascript', [
      '-e',
      `display notification ${JSON.stringify(message)} with title "JobPilot"`,
    ], { stdio: 'ignore', timeout: 5000 });
  } catch { /* a missing notification is never worth failing over */ }
}

// ---------------------------------------------------------------- port / url

function resolvePort() {
  if (process.env.PORT && /^\d+$/.test(process.env.PORT)) return process.env.PORT;
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const match = env.match(/^[ \t]*PORT[ \t]*=[ \t]*(\d+)[ \t]*$/m);
    if (match) return match[1];
  } catch { /* no .env yet — that's the normal first-run case */ }
  return '4310';
}

// Both can change before the server starts, if the preferred port turns out to
// be taken by something else.
let PORT = resolvePort();
let URL = `http://localhost:${PORT}`;

// Can we actually bind this port? A plain "nothing answered" check isn't
// enough — a socket can be unbindable while refusing connections.
function canBind(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(Number(port), '127.0.0.1');
  });
}

async function findFreePort(from, attempts = 12) {
  for (let port = Number(from); port < Number(from) + attempts; port += 1) {
    if (await canBind(port)) return String(port);
  }
  return null;
}

function portInUse(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host: '127.0.0.1' });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// Is the thing already on this port actually JobPilot, or some unrelated app?
function looksLikeJobPilot(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: Number(port), path: '/api/health', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk.slice(0, 500); });
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 && JSON.parse(body).ok === true);
          } catch { resolve(false); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitForServer(port, maxMs = 90000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await looksLikeJobPilot(port, 1000)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ------------------------------------------------------------ opening Chrome

// A Chrome window opened with `--app=` has no tabs and no address bar, which is
// exactly what we want — but the page inside it reports
// `display-mode: standalone`, the same thing a genuinely installed app reports.
// Without a hint, JobPilot would think it was already installed and would hide
// its own "keep me in your Dock" offer, so the launcher would quietly stop
// people from ever installing it. This flag is that hint: it says "a launcher
// opened this window", nothing more. It is never added to the address the user
// is told to visit, and an installed app starts at plain "/" without it.
function appWindowUrl() {
  return `${URL}/?opened-by=launcher`;
}

function openInChrome() {
  // Escape hatch for headless machines, remote boxes and automated checks.
  if (process.env.JOBPILOT_NO_BROWSER === '1') return null;

  if (IS_MAC) {
    // -n forces the arguments through even when Chrome is already running;
    // Chrome hands the command line to the existing instance, which opens a
    // clean app window. A non-zero exit means Chrome isn't installed.
    const result = spawnSync('open', ['-na', 'Google Chrome', '--args', `--app=${appWindowUrl()}`], {
      stdio: 'ignore',
      timeout: 15000,
    });
    if (result.status === 0) return 'Google Chrome';

    spawnSync('open', [URL], { stdio: 'ignore', timeout: 15000 });
    return null;
  }

  if (IS_WIN) {
    const chrome = findChromeWindows();
    if (chrome) {
      spawn(chrome, [`--app=${appWindowUrl()}`], { detached: true, stdio: 'ignore' }).unref();
      return 'Google Chrome';
    }
    // `start` with an empty title argument, so a quoted path is never mistaken
    // for the window title.
    spawn('cmd', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore' }).unref();
    return null;
  }

  // Linux / other unix
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    if (spawnSync('command', ['-v', bin], { shell: true, stdio: 'ignore' }).status === 0) {
      spawn(bin, [`--app=${appWindowUrl()}`], { detached: true, stdio: 'ignore' }).unref();
      return 'Chrome';
    }
  }
  spawnSync('xdg-open', [URL], { stdio: 'ignore', timeout: 15000 });
  return null;
}

function findChromeWindows() {
  const suffix = path.join('Google', 'Chrome', 'Application', 'chrome.exe');
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);

  for (const base of roots) {
    const candidate = path.join(base, suffix);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not there — try the next one */ }
  }

  // Last resort: ask the registry where Chrome installed itself.
  try {
    const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe';
    const out = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 8000 });
    const match = (out.stdout || '').match(/REG_SZ\s+(.+chrome\.exe)/i);
    if (match) {
      const found = match[1].trim().replace(/^"|"$/g, '');
      if (fs.existsSync(found)) return found;
    }
  } catch { /* registry lookup is a bonus, never a requirement */ }

  return null;
}

// ---------------------------------------------------------------- setup work

function tryGitUpdate() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return;
  const result = spawnSync('git', ['pull', '--ff-only'], {
    cwd: ROOT,
    stdio: 'ignore',
    timeout: 25000,
  });
  if (result.status === 0) say('  ✓ Up to date');
  else say('  (Couldn\'t check for updates — carrying on with the version you have.)');
}

function needsInstall() {
  // Everything arrived in the download, already installed. Nothing to check,
  // nothing to fetch, and the first run is instant even with no internet.
  if (BUNDLED) return false;

  const modules = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(modules)) return true;

  // npm writes node_modules/.package-lock.json after a successful install, so
  // it is the honest record of "what is on disk right now".
  const stampPath = fs.existsSync(path.join(modules, '.package-lock.json'))
    ? path.join(modules, '.package-lock.json')
    : modules;

  try {
    const stamp = fs.statSync(stampPath).mtimeMs;
    return ['package.json', 'package-lock.json'].some((name) => {
      const file = path.join(ROOT, name);
      return fs.existsSync(file) && fs.statSync(file).mtimeMs > stamp;
    });
  } catch {
    return true;
  }
}

function installDependencies() {
  if (!needsInstall()) return false;

  const firstTime = !fs.existsSync(path.join(ROOT, 'node_modules'));

  // A downloaded copy is meant to arrive complete. If its node_modules folder
  // has gone missing, npm is not the answer — the download does not include
  // npm, because it never needed it.
  if (firstTime && fs.existsSync(path.join(ROOT, 'runtime'))) {
    say('');
    say('  ❌ Some of JobPilot is missing (the "node_modules" folder).');
    say('     Downloading JobPilot again and using the fresh folder is the');
    say('     quickest fix — it comes with everything already in place.');
    say('');
    notify('Some files are missing — please download JobPilot again.');
    process.exit(1);
  }

  say(firstTime
    ? '  📦 Getting JobPilot ready (first time only, about a minute)…'
    : '  📦 Updating a few things…');
  notify(firstTime ? 'Setting up for the first time — about a minute.' : 'Updating…');

  const result = spawnSync(
    IS_WIN ? 'npm.cmd' : 'npm',
    ['install', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: ROOT, stdio: 'inherit', shell: IS_WIN },
  );

  if (result.error && result.error.code === 'ENOENT') {
    say('');
    say('  ❌ JobPilot needs npm to fetch the parts it is missing, and there is');
    say('     no npm on this computer. Installing Node.js from nodejs.org brings');
    say('     npm with it, or download JobPilot again from the website and use');
    say('     the fresh folder — that copy needs nothing at all.');
    say('');
    notify('npm is missing — download JobPilot again, or install Node.js.');
    process.exit(1);
  }

  if (result.status !== 0) {
    say('');
    say('  ❌ Something went wrong while downloading the parts JobPilot needs.');
    say('     This is almost always the internet connection. Check you are online');
    say('     and double-click JobPilot again.');
    say('');
    notify('Setup failed — check your internet connection and try again.');
    process.exit(1);
  }

  // Freshen the stamp npm uses, so the next launch starts instantly instead of
  // reinstalling because of a stray mtime.
  try {
    const stamp = path.join(ROOT, 'node_modules', '.package-lock.json');
    if (fs.existsSync(stamp)) {
      const now = new Date();
      fs.utimesSync(stamp, now, now);
    }
  } catch { /* purely an optimisation */ }

  return firstTime;
}

function ensureDataFolder() {
  const dir = process.env.JOBPILOT_DATA || path.join(os.homedir(), 'JobPilotData');
  // recursive:true creates what's missing and leaves anything already there
  // completely untouched. Nothing in this launcher ever deletes or overwrites.
  fs.mkdirSync(dir, { recursive: true });

  const hasData = ['settings.json', 'db.json', 'profiles'].some((name) =>
    fs.existsSync(path.join(dir, name)));

  return { dir, hasData };
}

// -------------------------------------------------------- desktop convenience

function ensureMacApp() {
  if (!IS_MAC || process.env.JOBPILOT_NO_APP === '1') return;
  try {
    require('./make-macos-app.js').ensureBundle({ quiet: true });
  } catch { /* the .app is a nicety; never block the launch over it */ }
}

function ensureWindowsShortcuts() {
  if (!IS_WIN) return;
  try {
    spawnSync('cscript', ['//nologo', path.join(__dirname, 'create-shortcuts.vbs'), '/quiet'], {
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch { /* shortcuts are a nicety too */ }
}

// ---------------------------------------------------------------------- main

async function main() {
  say('');
  say('  ✈️  JobPilot');
  say('  ──────────');

  if (await portInUse(PORT)) {
    // Already running? Just bring it to the front instead of crashing on a
    // port clash — double-clicking twice is a very normal thing to do.
    if (await looksLikeJobPilot(PORT)) {
      say('');
      say('  JobPilot is already running — opening it for you.');
      openInChrome();
      say('');
      say(`  If nothing appeared, go to  ${URL}  in your browser.`);
      say('');
      return;
    }

    // Something unrelated has the port. Move over quietly rather than letting
    // the server fall down with an error message nobody can act on.
    const free = await findFreePort(Number(PORT) + 1);
    if (!free) {
      say('');
      say(`  ❌ Another program on this computer is using port ${PORT}, and the`);
      say('     next few ports are busy too. Restarting your computer usually');
      say('     clears this up.');
      say('');
      notify(`Port ${PORT} is busy — try restarting your computer.`);
      process.exit(1);
    }
    say('');
    say(`  ℹ️  Another program is using port ${PORT}, so JobPilot will use ${free}.`);
    PORT = free;
    URL = `http://localhost:${PORT}`;
  }

  tryGitUpdate();
  const firstTime = installDependencies();
  ensureMacApp();
  if (firstTime) ensureWindowsShortcuts();

  const { dir, hasData } = ensureDataFolder();

  say('');
  say(`  📁 Your data folder:  ${dir}`);
  say(hasData
    ? '     Existing data found — your dashboard will open ready to use.'
    : '     New install — the app will walk you through setup in the browser.');
  say('     💡 Back this folder up. Copy it to a new device, start JobPilot there,');
  say('        and all your data comes with you.');
  say('');
  say('  🚀 Starting JobPilot…');

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    // PORT is passed explicitly so a port we had to move to actually sticks.
    // dotenv doesn't override real environment variables, so this wins.
    env: { ...process.env, PORT },
  });

  let shuttingDown = false;
  let serverExited = false;

  server.on('error', (err) => {
    say('');
    say(`  ❌ JobPilot couldn't start: ${err.message}`);
    say('');
    process.exit(1);
  });

  server.on('exit', (code, signal) => {
    serverExited = true;
    if (!shuttingDown) {
      say('');
      say('  JobPilot has stopped.');
      say('');
    }
    process.exit(signal ? 0 : (code ?? 0));
  });

  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    say('');
    say('  👋 Shutting JobPilot down. See you next time.');
    say('');
    if (!serverExited) server.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // JobPilot.app has no window to close, so the only way out is Force Quit —
  // which kills the bundle's wrapper script and leaves us re-parented to init,
  // silently running a server nobody can see. Notice that and stop too.
  //
  // Deliberately limited to the .app: in a Terminal the window closing already
  // takes the whole process group with it, and a stray re-parent there (npm,
  // job control, a detached shell) is normal rather than a reason to quit.
  if (NOTIFY) {
    const startedUnder = process.ppid;
    const orphanWatch = setInterval(() => {
      if (process.ppid !== startedUnder && process.ppid <= 1) {
        clearInterval(orphanWatch);
        if (!serverExited) server.kill('SIGTERM');
        setTimeout(() => process.exit(0), 1500).unref();
      }
    }, 2000);
    orphanWatch.unref();
  }

  const ready = await waitForServer(PORT);
  if (serverExited || shuttingDown) return;

  if (!ready) {
    say('');
    say(`  JobPilot is taking longer than usual. Try opening ${URL} yourself.`);
    say('');
    return;
  }

  const browser = openInChrome();

  say('');
  say(browser
    ? '  ✅ JobPilot is open in Google Chrome.'
    : `  ✅ JobPilot is running. If a window didn't open, go to  ${URL}`);
  if (browser) {
    // The window has no address bar, so there is no ⊕ icon in it to point at —
    // JobPilot offers the install itself, at the top of its Home screen.
    say('     Tip: JobPilot offers to put itself in your Dock/Taskbar at the top');
    say('     of its Home screen. Say yes once and it becomes a normal app.');
  }
  say('');
  if (NOTIFY) {
    // Started from JobPilot.app — there is no console window to talk about.
    say('  JobPilot keeps running until you quit it from the Dock.');
  } else {
    say('  ⚠️  Leave this window open — it is what keeps JobPilot running.');
    say(IS_WIN
      ? '     To quit: close this window, or press Ctrl+C.'
      : '     To quit: press Ctrl+C, or just close this window.');
  }
  say('');
  notify('JobPilot is ready. Quit it from the Dock when you are done.');
}

main().catch((err) => {
  say('');
  say(`  ❌ Unexpected problem: ${err && err.message ? err.message : err}`);
  say('     Try double-clicking JobPilot again.');
  say('');
  process.exit(1);
});
