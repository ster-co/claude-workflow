'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate only the registry, with no real process, filesystem or subprocess
// capabilities. A missing guard must produce a test failure, not a signal.
function runPidSafetyTests(source, check) {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const calls = [];
    const forbidden = (name) => (...args) => {
      calls.push([name, ...args]);
      throw new Error(`Unexpected OS operation: ${name}`);
    };
    const module = { exports: {} };
    const dependencies = {
      child_process: { spawnSync: forbidden('spawnSync') },
      crypto: {}, fs: {}, os: {}, path,
      './gates/gate-lib.cjs': { STATE_DIR: '/mock-state' },
      './run-state.cjs': { replaceFile: forbidden('replaceFile') },
    };
    const context = vm.createContext({
      module,
      require(name) {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected import: ${name}`);
        return dependencies[name];
      },
      process: { platform, pid: 500, kill: forbidden('kill') },
    });
    vm.runInContext(source, context, { timeout: 1000 });
    for (const pid of [0, 1, -1, -500, 1.5, NaN, Infinity, undefined, null, '2', Number.MAX_SAFE_INTEGER + 1]) {
      calls.length = 0;
      context.targetPid = pid;
      let error;
      try {
        vm.runInContext('module.exports.killTree(targetPid)', context, { timeout: 1000 });
      } catch (e) { error = e; }
      const label = `${platform}: invalid PID ${String(pid)}`;
      check(`${label} rejected by validation`, error?.name === 'RangeError', true);
      check(`${label} performs no OS operations`, calls.length, 0);
    }
    // A valid PID must reach the mock: ensure a blanket refusal cannot pass.
    calls.length = 0;
    try { vm.runInContext('module.exports.killTree(12345)', context, { timeout: 1000 }); } catch {}
    check(`${platform}: valid PID reaches mocked process lookup`, calls[0]?.[0], 'spawnSync');
  }
}

module.exports = { runPidSafetyTests };
if (require.main === module) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'serena-registry.cjs'), 'utf8');
  let count = 0;
  runPidSafetyTests(source, (name, actual, expected) => {
    assert.deepEqual(actual, expected, name); count++;
  });
  // Reproduce the original missing-guard bug entirely inside the mocks.
  const mutant = source.replace(/  if \(!Number\.isSafeInteger\(rootPid\) \|\| rootPid <= 1\) \{\n    throw new RangeError\('[^']*'\);\n  \}\n/, '');
  assert.notEqual(mutant, source, 'guard mutation must apply');
  let failures = 0;
  runPidSafetyTests(mutant, (_name, actual, expected) => { if (actual !== expected) failures++; });
  assert.ok(failures > 0, 'missing guard must fail safely');
  console.log(`${count} safety assertions passed; missing-guard mutation detected without OS access`);
}
