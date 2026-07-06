// File store with one portable data folder and a separate subfolder per
// profile — copy ~/JobPilotData to a new device, run setup, everything's back.
//
// Layout:
//   <DATA_DIR>/settings.json          global settings + active profile id
//   <DATA_DIR>/profiles/<id>/data.json    profile, applications, activity, reports
//   <DATA_DIR>/profiles/<id>/cv-original.*  the uploaded CV file as-is
//
// load()/save() expose a flattened view of the ACTIVE profile so the rest of
// the server doesn't care about profiles.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.JOBPILOT_DATA || path.join(os.homedir(), 'JobPilotData');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const OLD_FILE = path.join(DATA_DIR, 'db.json');                    // v2/v3 single file
const LEGACY_FILE = path.join(__dirname, '..', 'data', 'db.json');  // v1 in-app location

const WORKSPACE_DEFAULTS = {
  profile: null,          // extracted from uploaded CV
  cvText: null,           // raw text of uploaded CV
  cvFileName: null,       // original CV file stored alongside data.json
  applications: [],       // job cards on the kanban
  activity: [],           // event feed
  reports: [],            // improvement reports
  appliedSinceReport: 0   // counter for the every-N-applications report
};

let raw = null;     // { activeProfileId, profiles: {id: workspace}, settings, lastAutoSearchAt }
let cache = null;   // flattened view of the active profile
let firstRun = false;

function newId() { return 'p_' + crypto.randomBytes(4).toString('hex'); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function persist() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  writeAtomic(SETTINGS_FILE, {
    activeProfileId: raw.activeProfileId,
    settings: raw.settings,
    lastAutoSearchAt: raw.lastAutoSearchAt
  });
  for (const [id, ws] of Object.entries(raw.profiles)) {
    const dir = path.join(PROFILES_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(path.join(dir, 'data.json'), ws);
  }
}

function loadRaw() {
  if (raw) return raw;

  // 1) Current layout: settings.json + profiles/<id>/data.json
  const glob = readJson(SETTINGS_FILE);
  if (glob) {
    const profiles = {};
    if (fs.existsSync(PROFILES_DIR)) {
      for (const id of fs.readdirSync(PROFILES_DIR)) {
        const d = readJson(path.join(PROFILES_DIR, id, 'data.json'));
        if (d) profiles[id] = { ...WORKSPACE_DEFAULTS, ...d };
      }
    }
    if (!Object.keys(profiles).length) {
      const id = newId();
      profiles[id] = { ...WORKSPACE_DEFAULTS };
    }
    raw = {
      activeProfileId: glob.activeProfileId,
      profiles,
      settings: glob.settings || {},
      lastAutoSearchAt: glob.lastAutoSearchAt || null
    };
  } else {
    // 2) Older single-file layouts → migrate
    let flat = readJson(OLD_FILE);
    let migratedFrom = flat ? OLD_FILE : null;
    if (!flat) {
      flat = readJson(LEGACY_FILE);
      if (flat) migratedFrom = LEGACY_FILE;
    }
    if (!flat) {
      firstRun = true;
      const id = newId();
      raw = { activeProfileId: id, profiles: { [id]: { ...WORKSPACE_DEFAULTS } }, settings: {}, lastAutoSearchAt: null };
    } else if (flat.profiles) {
      // v3 multi-profile single file
      raw = {
        activeProfileId: flat.activeProfileId,
        profiles: Object.fromEntries(Object.entries(flat.profiles).map(([id, w]) => [id, { ...WORKSPACE_DEFAULTS, ...w }])),
        settings: flat.settings || {},
        lastAutoSearchAt: flat.lastAutoSearchAt || null
      };
    } else {
      // v2 flat single-profile
      const id = newId();
      raw = {
        activeProfileId: id,
        profiles: { [id]: { ...WORKSPACE_DEFAULTS, profile: flat.profile || null, cvText: flat.cvText || null, applications: flat.applications || [], activity: flat.activity || [], reports: flat.reports || [], appliedSinceReport: flat.appliedSinceReport || 0 } },
        settings: flat.settings || {},
        lastAutoSearchAt: flat.lastAutoSearchAt || null
      };
    }
    if (migratedFrom) {
      persist(); // write the new layout first, only then retire the old file
      try { fs.renameSync(migratedFrom, migratedFrom + '.migrated'); } catch { /* non-fatal */ }
      console.log(`Migrated data to per-profile folders under ${PROFILES_DIR}`);
    }
  }
  if (!raw.profiles[raw.activeProfileId]) raw.activeProfileId = Object.keys(raw.profiles)[0];
  return raw;
}

function load() {
  if (cache) return cache;
  const r = loadRaw();
  const ws = { ...WORKSPACE_DEFAULTS, ...r.profiles[r.activeProfileId] };
  cache = {
    profile: ws.profile,
    cvText: ws.cvText,
    cvFileName: ws.cvFileName,
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
    cvFileName: c.cvFileName,
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

// Store the uploaded CV file as-is inside the active profile's folder
function saveCvOriginal(originalName, buffer) {
  const r = loadRaw();
  const dir = path.join(PROFILES_DIR, r.activeProfileId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(originalName || '') || '.txt';
  const fileName = 'cv-original' + ext.toLowerCase();
  fs.writeFileSync(path.join(dir, fileName), buffer);
  load().cvFileName = fileName;
  return fileName;
}

// ---------- Profiles ----------

function listProfiles() {
  const r = loadRaw();
  if (cache) save();
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
  try { fs.rmSync(path.join(PROFILES_DIR, id), { recursive: true, force: true }); } catch { /* non-fatal */ }
  if (r.activeProfileId === id) r.activeProfileId = Object.keys(r.profiles)[0];
  cache = null;
  persist();
}

function isFirstRun() {
  loadRaw();
  return firstRun;
}

// Real laptop time. Applied/follow-up timestamps are stored per application,
// so schedules survive restarts and device moves.
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
  load, save, now, logActivity, isFirstRun, DATA_DIR, saveCvOriginal,
  listProfiles, createProfile, switchProfile, deleteProfile
};
