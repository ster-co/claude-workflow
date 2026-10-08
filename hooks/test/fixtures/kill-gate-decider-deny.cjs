'use strict';
// Fixture decider that answers a deny verdict at once.
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ rule: 'match', reason: 'kill-gate rule match (fixture decider): denied. fixture' }));
});
