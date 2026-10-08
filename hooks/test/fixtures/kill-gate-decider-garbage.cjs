'use strict';
// Fixture decider that exits 0 with output that is not a verdict.
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('this is not json');
});
