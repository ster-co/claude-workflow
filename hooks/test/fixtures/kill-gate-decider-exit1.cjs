'use strict';
// Fixture decider that prints a valid allow verdict and then exits 1: a decider that died
// after answering has not given an answer to rely on.
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('null', () => process.exit(1));
});
