#!/usr/bin/env node
'use strict';

// Builds what people actually download: one ZIP per platform, with a Node
// runtime and every dependency already inside it. Unzip, double-click, done —
// nothing to install, no admin password, no trip to nodejs.org.
//
//   node scripts/build-release.js               every platform
//   node scripts/build-release.js mac-arm64     just one (ids are listed below)
//
// Node built-ins only: no dependencies, no build step, nothing to set up first.
// Downloaded runtimes are cached in build/cache, so a second run is quick and
// works offline. Nothing this script writes is ever committed — see .gitignore.
//
// Per platform it:
//   1. downloads the official Node runtime from nodejs.org,
//   2. checks it against nodejs.org's own SHASUMS256.txt and stops dead on a
//      mismatch — we are handing someone else's binary to strangers, so an
//      unverified download is not something to shrug at,
//   3. lays out the app + the runtime + the launcher in build/stage,
//   4. writes build/dist/JobPilot-<platform>.zip.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ────────────────────────────────────────────────── THE NODE VERSION WE SHIP
//
// This is the one line to edit when upgrading the bundled runtime.
//
// Pick an LTS ("long term support") version from https://nodejs.org/dist/ —
// those are the ones with years of security fixes behind them. Change the
// string, run this script, then run the test suite against the runtime it
// unpacks to be sure the app is happy on it:
//
//   node scripts/build-release.js mac-arm64
//   build/stage/mac-arm64/JobPilot/runtime/bin/node --test test/*.test.js
//
// Why 22 and not the newest LTS: Node 24 needs macOS 13.5 or later, which
// leaves out every Mac Apple stopped updating before Ventura. Node 22 runs on
// macOS 11 and later and on Windows 10 and later, it is supported until April
// 2027, and JobPilot's test suite passes on it.
const NODE_VERSION = 'v22.23.2';

// ─────────────────────────────────────────────────────────────────── targets

// The `asset` is the file name on https://nodejs.org/dist/<version>/ and is
// also exactly how it is spelled in SHASUMS256.txt, so one string covers both
// the download and the checksum lookup.
//
// Windows gets the bare node.exe rather than the whole .zip because we ship
// node_modules ready-installed, so npm is never needed on a user's machine —
// which keeps that download about 30 MB smaller.
const ALL_TARGETS = [
  {
    id: 'mac-arm64',
    label: 'Mac · Apple Silicon (M1, M2, M3, M4)',
    zipName: 'JobPilot-Mac-AppleSilicon.zip',
    asset: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    kind: 'tar.gz',
    member: 'bin/node',
    runtimePath: 'runtime/bin/node',
    expectBinary: 'macho-arm64',
    launchers: ['JobPilot.command', 'setup.sh'],
  },
  {
    id: 'mac-x64',
    label: 'Mac · Intel',
    zipName: 'JobPilot-Mac-Intel.zip',
    asset: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
    kind: 'tar.gz',
    member: 'bin/node',
    runtimePath: 'runtime/bin/node',
    expectBinary: 'macho-x64',
    launchers: ['JobPilot.command', 'setup.sh'],
  },
  {
    id: 'windows-x64',
    label: 'Windows · 64-bit',
    zipName: 'JobPilot-Windows.zip',
    asset: 'win-x64/node.exe',
    kind: 'raw',
    runtimePath: 'runtime/node.exe',
    expectBinary: 'pe-x64',
    launchers: ['JobPilot.bat', 'setup.bat'],
  },
  {
    id: 'linux-x64',
    label: 'Linux · 64-bit',
    zipName: 'JobPilot-Linux.zip',
    asset: `node-${NODE_VERSION}-linux-x64.tar.gz`,
    kind: 'tar.gz',
    member: 'bin/node',
    runtimePath: 'runtime/bin/node',
    expectBinary: 'elf-x64',
    launchers: ['setup.sh', 'JobPilot.command'],
  },
];

// What goes in the download. An allow-list rather than a "copy everything
// except…" list, so a stray .env, a data folder or a git checkout can never
// find its way into something handed to strangers.
const APP_FILES = ['package.json', 'package-lock.json', '.env.example', 'README.md', 'LICENSE'];
const APP_DIRS = ['server', 'public', 'install'];

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const CACHE = path.join(BUILD, 'cache');
const STAGE = path.join(BUILD, 'stage');
const DIST = path.join(BUILD, 'dist');
const DEPS = path.join(BUILD, 'deps');

// Everything in a ZIP carries a timestamp. Giving every entry the same one
// keeps the archive tidy, and — because launch.js decides whether to reinstall
// by comparing package.json's date against node_modules' — stops a freshly
// unzipped copy deciding it needs to install anything.
const BUILD_TIME = new Date();

// ───────────────────────────────────────────────────────────── small helpers

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────── getting the node

function fetchBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'jobpilot-build-release' } }, (res) => {
        const { statusCode, headers } = res;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft === 0) {
            reject(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          resolve(fetchBuffer(new URL(headers.location, url).toString(), redirectsLeft - 1));
          return;
        }

        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`${url} answered ${statusCode}`));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

// nodejs.org publishes one SHASUMS256.txt per release, listing every file in
// that release. It is fetched over HTTPS from the same host as the downloads,
// which is the same trust boundary — it protects against a corrupted or
// truncated download and against a swapped file on a mirror, not against
// nodejs.org itself. (There is a detached GPG signature next to it for anyone
// who wants to go further; checking it needs gpg and the release keys, so it
// is deliberately not done here.)
async function fetchChecksums() {
  const url = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;
  const text = (await fetchBuffer(url)).toString('utf8');

  const sums = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (match) sums.set(match[2], match[1]);
  }

  if (sums.size === 0) {
    throw new Error(`Fetched ${url} but found no checksums in it. Is the version right?`);
  }
  return sums;
}

async function fetchRuntimeAsset(target, sums) {
  const expected = sums.get(target.asset);
  if (!expected) {
    throw new Error(
      `nodejs.org's SHASUMS256.txt for ${NODE_VERSION} does not list "${target.asset}".\n` +
      '     Either the version is wrong or that build is not published for this release.',
    );
  }

  const cached = path.join(CACHE, target.asset.replace(/[/\\]/g, '-'));

  if (fs.existsSync(cached)) {
    const buffer = fs.readFileSync(cached);
    if (sha256(buffer) === expected) {
      say(`     ✓ ${target.asset} — already downloaded, checksum still matches (${mb(buffer.length)})`);
      return buffer;
    }
    say('     · cached copy no longer matches the published checksum — downloading again');
    fs.rmSync(cached, { force: true });
  }

  const url = `https://nodejs.org/dist/${NODE_VERSION}/${target.asset}`;
  say(`     · downloading ${url}`);
  const buffer = await fetchBuffer(url);
  const actual = sha256(buffer);

  if (actual !== expected) {
    throw new Error(
      'CHECKSUM MISMATCH — refusing to build.\n' +
      `     file:     ${target.asset}\n` +
      `     expected: ${expected}\n` +
      `     actually: ${actual}\n` +
      '     This runtime would go straight onto other people\'s computers, so it\n' +
      '     does not get shipped. Delete build/cache and try again; if it happens\n' +
      '     twice, do not work around it.',
    );
  }

  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, buffer);
  say(`     ✓ downloaded and verified (${mb(buffer.length)})`);
  return buffer;
}

// Pull exactly one file out of a .tar.gz. A tar is a plain sequence of 512-byte
// headers, each followed by its file's bytes rounded up to 512 — so finding one
// known path in it needs no library and no temporary folder.
function extractTarMember(gzipped, wantedPath) {
  const tar = zlib.gunzipSync(gzipped);
  const str = (start, length) => {
    const slice = tar.subarray(start, start + length);
    const end = slice.indexOf(0);
    return slice.toString('utf8', 0, end === -1 ? slice.length : end);
  };

  let offset = 0;
  while (offset + 512 <= tar.length) {
    const nameField = str(offset, 100);
    if (nameField === '') break; // two zero blocks mark the end of the archive

    const size = parseInt(str(offset + 124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(tar[offset + 156]);
    const prefix = str(offset + 345, 155);
    const full = prefix ? `${prefix}/${nameField}` : nameField;
    const dataAt = offset + 512;

    if (full === wantedPath && (type === '0' || type === '\0')) {
      return Buffer.from(tar.subarray(dataAt, dataAt + size));
    }
    offset = dataAt + Math.ceil(size / 512) * 512;
  }

  throw new Error(`Could not find ${wantedPath} inside the runtime archive.`);
}

// A cheap sanity check that the binary in our hands is the one we meant to put
// in this ZIP. Getting this wrong is invisible on the build machine — the Mac
// build would work fine here and be dead on arrival for everyone else.
function describeBinary(buffer) {
  if (buffer.length < 64) return 'far too small to be a program';

  if (buffer.readUInt32BE(0) === 0xcffaedfe) { // 64-bit Mach-O, little-endian
    const cpu = buffer.readUInt32LE(4);
    if (cpu === 0x0100000c) return 'macho-arm64';
    if (cpu === 0x01000007) return 'macho-x64';
    return `macho-cpu-0x${cpu.toString(16)}`;
  }
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) { // "MZ" — a Windows program
    const peAt = buffer.readUInt32LE(0x3c);
    const machine = buffer.readUInt16LE(peAt + 4);
    if (machine === 0x8664) return 'pe-x64';
    return `pe-machine-0x${machine.toString(16)}`;
  }
  if (buffer.readUInt32BE(0) === 0x7f454c46) { // ELF
    const machine = buffer.readUInt16LE(18);
    if (machine === 0x3e) return 'elf-x64';
    return `elf-machine-0x${machine.toString(16)}`;
  }
  return 'unrecognised';
}

function runtimeBinaryFor(target, asset) {
  const binary = target.kind === 'raw'
    ? asset
    : extractTarMember(asset, `${target.asset.replace(/\.tar\.gz$/, '')}/${target.member}`);

  if (binary.length < 5 * 1024 * 1024) {
    throw new Error(`The runtime for ${target.id} came out at only ${mb(binary.length)} — that is not Node.`);
  }

  const found = describeBinary(binary);
  if (found !== target.expectBinary) {
    throw new Error(
      `The runtime for ${target.id} is a ${found} binary, but that ZIP needs ${target.expectBinary}.`,
    );
  }

  return binary;
}

// ──────────────────────────────────────────────────────────── dependencies

// One install, shared by every platform. That is only safe because every
// JobPilot dependency is plain JavaScript — assertPureJavaScript() proves it
// afterwards rather than taking it on trust, because the day a dependency
// arrives with a compiled part in it, one build stops working everywhere.
function installDependencies() {
  say('  Installing dependencies (once, shared by every platform)…');

  rmrf(DEPS);
  fs.mkdirSync(DEPS, { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(ROOT, name), path.join(DEPS, name));
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: DEPS, stdio: 'inherit', shell: process.platform === 'win32' },
  );

  if (result.status !== 0) {
    throw new Error('npm ci failed, so there are no dependencies to bundle.');
  }

  assertPureJavaScript(path.join(DEPS, 'node_modules'));
  say('  ✓ Dependencies installed and confirmed to be pure JavaScript');
}

function assertPureJavaScript(modulesDir) {
  const compiled = [];
  const withScripts = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.node') || entry.name === 'binding.gyp') compiled.push(full);
        if (entry.name === 'package.json') {
          try {
            const scripts = JSON.parse(fs.readFileSync(full, 'utf8')).scripts || {};
            for (const hook of ['preinstall', 'install', 'postinstall']) {
              if (scripts[hook]) withScripts.push(`${path.relative(modulesDir, full)} (${hook})`);
            }
          } catch { /* an unreadable package.json is not our business here */ }
        }
      }
    }
  };
  walk(modulesDir);

  if (compiled.length || withScripts.length) {
    throw new Error(
      'A dependency is not pure JavaScript, so one node_modules can no longer serve every platform.\n' +
      (compiled.length ? `     compiled bits: ${compiled.slice(0, 8).join(', ')}\n` : '') +
      (withScripts.length ? `     install scripts: ${withScripts.slice(0, 8).join(', ')}\n` : '') +
      '     Fix it by installing dependencies once per platform (npm ci with\n' +
      '     --os/--cpu set) and staging each result into its own ZIP.',
    );
  }
}

// ───────────────────────────────────────────────────────────────── staging

// Copying refuses symlinks outright rather than following them: a symlink is
// how a "copy the app" step quietly turns into "copy someone's home folder",
// and Windows would not know what to do with one anyway.
function copyTree(from, to, { skip = () => false } = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (skip(entry.name, src)) continue;

    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to bundle the symlink ${src} — resolve or exclude it.`);
    }
    if (entry.isDirectory()) copyTree(src, dest, { skip });
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

// Belt and braces on top of the allow-list: these never travel, wherever they
// turn up. A .env holds the developer's own API keys.
function isPrivate(name) {
  return name === '.env' || name === '.git' || name === '.DS_Store' || name.endsWith('.log');
}

function stageTarget(target, runtimeBinary) {
  const base = path.join(STAGE, target.id);
  const app = path.join(base, 'JobPilot');
  rmrf(base);
  fs.mkdirSync(app, { recursive: true });

  for (const name of APP_FILES) {
    fs.copyFileSync(path.join(ROOT, name), path.join(app, name));
  }
  for (const name of APP_DIRS) {
    copyTree(path.join(ROOT, name), path.join(app, name), { skip: isPrivate });
  }
  for (const name of target.launchers) {
    fs.copyFileSync(path.join(ROOT, name), path.join(app, name));
    fs.chmodSync(path.join(app, name), 0o755);
  }

  // node_modules/.bin is nothing but shortcuts to command-line tools we never
  // run, and on macOS they are symlinks — which do not belong in a ZIP that a
  // Windows machine will open.
  copyTree(path.join(DEPS, 'node_modules'), path.join(app, 'node_modules'), {
    skip: (name) => name === '.bin' || isPrivate(name),
  });

  const runtimeFile = path.join(app, ...target.runtimePath.split('/'));
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  fs.writeFileSync(runtimeFile, runtimeBinary);
  fs.chmodSync(runtimeFile, 0o755);

  // A note for whoever opens the folder and wonders what this 100 MB file is.
  fs.writeFileSync(path.join(app, 'runtime', 'README.txt'),
    `This folder holds Node ${NODE_VERSION}, downloaded unchanged from nodejs.org.\n\n`
    + 'It is what runs JobPilot on your computer. It lives here so that you do not\n'
    + 'have to install anything: JobPilot uses this copy and nothing else on your\n'
    + 'machine is touched. Deleting this folder does not break JobPilot if you\n'
    + 'already have Node.js installed — it will simply use yours instead.\n');

  return app;
}

// ────────────────────────────────────────────────────────── writing the ZIP

// A ZIP writer in about a hundred lines, so the build needs no zip command and
// runs the same on any machine. Everything is deflated in memory and written
// straight out, entry by entry.

let crcTable = null;
function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
      crcTable[i] = value;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function dosStamp(date) {
  const time = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);
  return { time, day };
}

function listEntries(dir, prefix, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      out.push({ name: `${name}/`, dir: true, mode: 0o755 });
      listEntries(full, `${name}/`, out);
    } else if (entry.isFile()) {
      out.push({ name, dir: false, full, mode: fs.statSync(full).mode & 0o777 });
    }
  }
  return out;
}

function writeZip(sourceDir, folderName, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const { time, day } = dosStamp(BUILD_TIME);
  const entries = [{ name: `${folderName}/`, dir: true, mode: 0o755 }]
    .concat(listEntries(sourceDir, `${folderName}/`));

  const fd = fs.openSync(zipPath, 'w');
  const central = [];
  let offset = 0;

  const put = (buffer) => {
    fs.writeSync(fd, buffer);
    offset += buffer.length;
  };

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const raw = entry.dir ? Buffer.alloc(0) : fs.readFileSync(entry.full);
    const deflated = entry.dir ? Buffer.alloc(0) : zlib.deflateRawSync(raw);
    const useDeflate = !entry.dir && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const localAt = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(1 << 11, 6); // flags: names are UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    put(local);
    put(nameBytes);
    if (payload.length) put(payload);

    const middle = Buffer.alloc(46);
    middle.writeUInt32LE(0x02014b50, 0);
    middle.writeUInt16LE((3 << 8) | 20, 4); // made by unix, so the mode below counts
    middle.writeUInt16LE(20, 6);
    middle.writeUInt16LE(1 << 11, 8);
    middle.writeUInt16LE(useDeflate ? 8 : 0, 10);
    middle.writeUInt16LE(time, 12);
    middle.writeUInt16LE(day, 14);
    middle.writeUInt32LE(crc32(raw), 16);
    middle.writeUInt32LE(payload.length, 20);
    middle.writeUInt32LE(raw.length, 24);
    middle.writeUInt16LE(nameBytes.length, 28);
    middle.writeUInt16LE(0, 30); // extra
    middle.writeUInt16LE(0, 32); // comment
    middle.writeUInt16LE(0, 34); // disk
    middle.writeUInt16LE(0, 36); // internal attributes
    // The top half of the external attributes is the unix mode — this is what
    // keeps `runtime/bin/node` executable after someone unzips it.
    const unixMode = (entry.dir ? 0o040000 : 0o100000) | entry.mode;
    middle.writeUInt32LE((((unixMode << 16) >>> 0) | (entry.dir ? 0x10 : 0)) >>> 0, 38);
    middle.writeUInt32LE(localAt, 42);
    central.push(Buffer.concat([middle, nameBytes]));
  }

  const directoryAt = offset;
  for (const record of central) put(record);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - directoryAt, 12);
  end.writeUInt32LE(directoryAt, 16);
  end.writeUInt16LE(0, 20);
  put(end);

  fs.closeSync(fd);
  return { entries: entries.length, size: fs.statSync(zipPath).size };
}

// ──────────────────────────────────────────────────────────────────── main

async function main() {
  const asked = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const targets = asked.length
    ? ALL_TARGETS.filter((t) => asked.includes(t.id))
    : ALL_TARGETS;

  if (!targets.length) {
    say('');
    say(`  Unknown target. Pick from: ${ALL_TARGETS.map((t) => t.id).join(', ')}`);
    say('');
    process.exit(1);
  }

  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  say('');
  say(`  ✈️  Building JobPilot ${version} releases`);
  say('  ─────────────────────────────────────');
  say(`  Bundled runtime: Node ${NODE_VERSION}`);
  say(`  Platforms:       ${targets.map((t) => t.id).join(', ')}`);
  say('');

  installDependencies();
  say('');

  say('  Fetching nodejs.org checksums…');
  const sums = await fetchChecksums();
  say(`  ✓ SHASUMS256.txt for ${NODE_VERSION} (${sums.size} files listed)`);
  say('');

  fs.mkdirSync(CACHE, { recursive: true });
  const built = [];

  for (const target of targets) {
    say(`  ${target.label}`);
    const asset = await fetchRuntimeAsset(target, sums);
    const binary = runtimeBinaryFor(target, asset);
    say(`     ✓ runtime binary: ${target.expectBinary}, ${mb(binary.length)}`);

    const staged = stageTarget(target, binary);
    const zipPath = path.join(DIST, target.zipName);
    const { entries, size } = writeZip(staged, 'JobPilot', zipPath);
    say(`     ✓ ${target.zipName} — ${mb(size)}, ${entries} files`);
    say('');

    built.push({ target, zipPath, size });
  }

  say('  ─────────────────────────────────────');
  say('  Done. The downloads are in build/dist:');
  say('');
  for (const item of built) {
    say(`    ${item.target.zipName.padEnd(30)} ${mb(item.size).padStart(9)}   ${item.target.label}`);
  }
  say('');
  say('  Next: make a GitHub Release and upload these as its assets. The names');
  say('  above are what site/index.html expects — see "Cutting a release" in the');
  say('  README.');
  say('');
}

main().catch((err) => {
  say('');
  say(`  ❌ ${err && err.message ? err.message : err}`);
  say('');
  process.exit(1);
});
