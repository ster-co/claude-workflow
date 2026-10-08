'use strict';
// Fixture decider that answers allow (the JSON text `null`). When KG_MARKER names a file it
// writes it first, so a test can tell that a decider was started at all.
const fs = require('fs');

process.stdin.resume();
process.stdin.on('end', () => {
  if (process.env.KG_MARKER) fs.writeFileSync(process.env.KG_MARKER, 'started');
  process.stdout.write('null');
});
