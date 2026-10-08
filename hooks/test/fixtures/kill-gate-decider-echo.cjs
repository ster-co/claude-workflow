'use strict';
// Fixture decider that answers a deny whose reason is the request it was handed, so a test
// can read what the hook sent on the decider's stdin.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ rule: 'match', reason: raw }));
});
