// The Terminal window as a status display.
//
// The launcher tells people "leave this window open — it is what keeps JobPilot
// running", so to them it IS the app's status display. Everything the server
// used to print into it — `ATS board error:`, `scoreJobs failed:`, ten-frame
// stack traces — reads to a non-technical person as their app breaking.
//
// Nothing is thrown away. `console.error` and `console.warn` keep writing the
// whole thing, stacks included, to a plain text file in the data folder; the
// window itself gets at most one calm sentence every few minutes saying that
// something in the background didn't work and JobPilot carried on.
//
// `console.log` is left alone on purpose: it is what the start-up lines and the
// launcher's own copy use, and both are already written for a person to read.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;   // one file, rolled once — never unbounded
const QUIET_MS = 5 * 60 * 1000;  // at most one notice in the window per 5 min

let logFile = '';
let lastNotice = 0;
let installed = false;

function textOf(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function roll() {
  try {
    if (fs.statSync(logFile).size < MAX_BYTES) return;
    fs.renameSync(logFile, logFile + '.previous');
  } catch { /* no file yet, or the rename lost a race — either is fine */ }
}

function write(args) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${args.map(textOf).join(' ')}\n`);
    roll();
  } catch { /* logging must never be the thing that breaks the app */ }
}

// One sentence, rarely, and only for things that actually went wrong. A person
// who sees it should know they lost nothing and need do nothing.
function notice() {
  const at = Date.now();
  if (at - lastNotice < QUIET_MS) return;
  lastNotice = at;
  console.log("Something we do in the background didn't work just then. JobPilot carried on and nothing is lost.");
}

function install(dataDir) {
  if (installed) return;
  installed = true;
  const dir = dataDir || process.env.JOBPILOT_DATA ||
    path.join(require('os').homedir(), 'JobPilotData');
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'jobpilot-log.txt');
  } catch { logFile = ''; }

  // Developing on JobPilot itself? JOBPILOT_VERBOSE=1 puts everything back on
  // screen. Nobody using the app ever sets it.
  if (process.env.JOBPILOT_VERBOSE === '1') return;
  console.error = (...args) => { write(args); notice(); };
  console.warn = (...args) => { write(args); };
}

// Told to the person once, at start-up, so the detail is findable when they ask
// somebody for help.
function where() {
  return logFile
    ? `If something ever looks wrong, the details are written to ${logFile}.`
    : 'If something ever looks wrong, close this window and start JobPilot again.';
}

module.exports = { install, where, file: () => logFile };
