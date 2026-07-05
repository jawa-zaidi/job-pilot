// JSON-file store with multiple profiles (workspaces). All data lives in ONE
// portable folder (~/JobPilotData, override with JOBPILOT_DATA): copy it to a
// new device, run setup, everything comes back.
//
// Each profile has its own CV, applications, activity and reports. Settings
// (keys, sources, mode…) are shared. load()/save() expose a flattened view of
// the ACTIVE profile so the rest of the server doesn't care about profiles.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.JOBPILOT_DATA || path.join(os.homedir(), 'JobPilotData');
const FILE = path.join(DATA_DIR, 'db.json');
const LEGACY_FILE = path.join(__dirname, '..', 'data', 'db.json'); // pre-v2 location

const WORKSPACE_DEFAULTS = {
  profile: null,          // extracted from uploaded CV
  cvText: null,           // raw text of uploaded CV
  applications: [],       // job cards on the kanban
  activity: [],           // event feed
  reports: [],            // improvement reports
  appliedSinceReport: 0   // counter for the every-N-applications report
};

let raw = null;     // full on-disk structure
let cache = null;   // flattened view of the active profile
let firstRun = false;

function newId() { return 'p_' + crypto.randomBytes(4).toString('hex'); }

function loadRaw() {
  if (raw) return raw;
  let flat = null;
  try {
    flat = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    try {
      flat = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
      fs.renameSync(LEGACY_FILE, LEGACY_FILE + '.migrated');
    } catch {
      flat = null;
      firstRun = true;
    }
  }
  if (!flat) {
    const id = newId();
    raw = { activeProfileId: id, profiles: { [id]: { ...WORKSPACE_DEFAULTS } }, settings: {}, lastAutoSearchAt: null };
  } else if (!flat.profiles) {
    // migrate v2 single-profile shape → v3 multi-profile
    const id = newId();
    raw = {
      activeProfileId: id,
      profiles: {
        [id]: {
          profile: flat.profile || null,
          cvText: flat.cvText || null,
          applications: flat.applications || [],
          activity: flat.activity || [],
          reports: flat.reports || [],
          appliedSinceReport: flat.appliedSinceReport || 0
        }
      },
      settings: flat.settings || {},
      lastAutoSearchAt: flat.lastAutoSearchAt || null
    };
    persist();
    console.log('Migrated data to multi-profile format');
  } else {
    raw = flat;
  }
  if (!raw.profiles[raw.activeProfileId]) raw.activeProfileId = Object.keys(raw.profiles)[0];
  return raw;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, FILE);
}

function load() {
  if (cache) return cache;
  const r = loadRaw();
  const ws = { ...WORKSPACE_DEFAULTS, ...r.profiles[r.activeProfileId] };
  cache = {
    profile: ws.profile,
    cvText: ws.cvText,
    applications: ws.applications,
    activity: ws.activity,
    reports: ws.reports,
    appliedSinceReport: ws.appliedSinceReport,
    settings: r.settings,
    lastAutoSearchAt: r.lastAutoSearchAt
  };
  return cache;
}

function save() {
  const r = loadRaw();
  const c = load();
  r.profiles[r.activeProfileId] = {
    profile: c.profile,
    cvText: c.cvText,
    applications: c.applications,
    activity: c.activity,
    reports: c.reports,
    appliedSinceReport: c.appliedSinceReport
  };
  r.settings = c.settings;
  r.lastAutoSearchAt = c.lastAutoSearchAt;
  persist();
  firstRun = false;
}

// ---------- Profiles ----------

function listProfiles() {
  const r = loadRaw();
  if (cache) save(); // make sure the active one reflects latest state
  return Object.entries(r.profiles).map(([id, w]) => ({
    id,
    name: w.profile?.name || 'New profile',
    title: w.profile?.title || 'no CV yet',
    applications: (w.applications || []).length,
    active: id === r.activeProfileId
  }));
}

function createProfile() {
  const r = loadRaw();
  if (cache) save();
  const id = newId();
  r.profiles[id] = { ...WORKSPACE_DEFAULTS };
  r.activeProfileId = id;
  cache = null;
  persist();
  return id;
}

function switchProfile(id) {
  const r = loadRaw();
  if (!r.profiles[id]) throw new Error('No such profile');
  if (cache) save();
  r.activeProfileId = id;
  cache = null;
  persist();
}

function deleteProfile(id) {
  const r = loadRaw();
  if (!r.profiles[id]) throw new Error('No such profile');
  if (Object.keys(r.profiles).length <= 1) throw new Error('Cannot delete the only profile');
  delete r.profiles[id];
  if (r.activeProfileId === id) r.activeProfileId = Object.keys(r.profiles)[0];
  cache = null;
  persist();
}

function isFirstRun() {
  loadRaw();
  return firstRun;
}

// Real laptop time. Applied/follow-up timestamps are stored on each
// application, so the schedule survives restarts and device moves.
function now() {
  return Date.now();
}

function logActivity(text, type = 'info') {
  const db = load();
  db.activity.unshift({ at: now(), text, type });
  db.activity = db.activity.slice(0, 100);
  save();
}

module.exports = {
  load, save, now, logActivity, isFirstRun, DATA_DIR,
  listProfiles, createProfile, switchProfile, deleteProfile
};
