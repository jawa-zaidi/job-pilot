// City aliases: "Bangalore" in settings must match "Bengaluru" on a listing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JOBPILOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-location-'));

const { matchesLocation } = require('../server/jobs');

test('Bangalore in settings matches Bengaluru on a listing', () => {
  const prefs = { locations: ['bangalore'], remoteOk: false };
  assert.ok(matchesLocation({ location: 'Bengaluru, Karnataka, IN' }, prefs));
  assert.ok(matchesLocation({ location: 'Bangalore' }, prefs));
  assert.ok(!matchesLocation({ location: 'Mumbai, Maharashtra' }, prefs));
  assert.ok(matchesLocation({ location: 'Gurugram, Haryana' }, { locations: ['gurgaon'], remoteOk: false }));
});
