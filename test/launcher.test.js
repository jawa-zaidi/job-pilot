// The launcher must reinstall when node_modules exists but is empty or half
// there, instead of starting the server and crashing on a missing package.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { missingDependency } = require('../install/launch');

test('an empty or half-installed node_modules counts as not installed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-launch-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4', multer: '^1' } }));
  fs.mkdirSync(path.join(root, 'node_modules'));
  assert.strictEqual(missingDependency(root), 'express', 'empty folder');

  fs.mkdirSync(path.join(root, 'node_modules', 'express'));
  fs.writeFileSync(path.join(root, 'node_modules', 'express', 'package.json'), '{}');
  assert.strictEqual(missingDependency(root), 'multer', 'half installed');

  fs.mkdirSync(path.join(root, 'node_modules', 'multer'));
  fs.writeFileSync(path.join(root, 'node_modules', 'multer', 'package.json'), '{}');
  assert.strictEqual(missingDependency(root), null, 'all there');
});

test('this checkout itself has everything installed', () => {
  assert.strictEqual(missingDependency(), null);
});
