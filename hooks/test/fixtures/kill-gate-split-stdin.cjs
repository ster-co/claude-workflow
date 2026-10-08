#!/usr/bin/env node
'use strict';
// Fixture for test-kill-gate.cjs: runs the real hook (path in argv[2]) and hands it its
// stdin in two writes that split the first three-byte character in the input after its
// first byte, 300 ms apart, so the hook reads the character across two chunks. Prints the
// hook's stdout and exits with its exit code.
const { spawn } = require('child_process');

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const buf = Buffer.concat(chunks);
  const at = buf.indexOf(0xe2) + 1;
  const hook = spawn(process.execPath, [process.argv[2]], { stdio: ['pipe', 'pipe', 'inherit'] });
  const out = [];
  hook.stdout.on('data', (c) => out.push(c));
  hook.on('close', (code) => {
    process.stdout.write(Buffer.concat(out), () => process.exit(code));
  });
  hook.stdin.write(buf.subarray(0, at));
  setTimeout(() => hook.stdin.end(buf.subarray(at)), 300);
});
