'use strict';
// Fixture decider that dies without a verdict: exit 1, nothing on stdout.
process.stderr.write('fixture decider crashed\n');
process.exit(1);
