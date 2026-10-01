#!/usr/bin/env node
// Behavioural tests for verify-all.cjs's suite-runner: the bounded
// concurrency pool, the serial exception for a load-sensitive suite, and the
// wall-time budget. Task 1 of docs/plans/2026-09-28-test-runs.md.
//
// Uses fake, fast scripts (temp .cjs files that console.log then
// process.exit after a small configurable delay) instead of the 13 real
// suites, which would make this test itself take ~15 minutes.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-verify-all.cjs -> hooks/test: resolve the module under test
// from this file's own location, not the homedir, so this suite exercises
// the checkout it lives in rather than always the live ~/.claude install.
const V = require(path.join(__dirname, 'verify-all.cjs'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}`); }
}

const trash = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-all-test-'));
  trash.push(d);
  return d;
}

// A fake suite: after `delayMs`, prints two lines (mimicking the real
// suites' "<blank>\n<N> passed, <N> failed" tail) and exits with `exitCode`.
// When `logFile` is given it also appends a `<name> start|end <ms>` line, so
// a test can reconstruct wall-clock overlap between suites after the fact.
//
// When `concurrencyProbe` is set instead, the fake does a direct
// concurrent-count measurement rather than logging bare start/end
// timestamps for the caller to compare across processes afterwards: it logs
// its own start, waits half of `delayMs` (a settle window), reads the SHARED
// log at that moment and counts how many names (including itself) have a
// 'start' entry with no matching 'end' entry yet, logs that count, then
// waits out the remaining half and logs its end. See the block below for why
// this replaces a min/max timestamp comparison.
function writeFake(dir, name, { delayMs = 0, exitCode = 0, logFile, concurrencyProbe = false } = {}) {
  const p = path.join(dir, name);
  if (concurrencyProbe) {
    if (!logFile) throw new Error('concurrencyProbe fakes require a logFile');
    const half = Math.round(delayMs / 2);
    fs.writeFileSync(p, `
'use strict';
const fs = require('fs');
const logFile = ${JSON.stringify(logFile)};
const name = ${JSON.stringify(name)};
fs.appendFileSync(logFile, name + ' start ' + Date.now() + '\\n');
setTimeout(() => {
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\\n');
  const started = new Set();
  const ended = new Set();
  for (const line of lines) {
    const parts = line.split(' ');
    if (parts[1] === 'start') started.add(parts[0]);
    if (parts[1] === 'end') ended.add(parts[0]);
  }
  let active = 0;
  for (const n of started) { if (!ended.has(n)) active++; }
  fs.appendFileSync(logFile, name + ' concurrent ' + active + ' ' + Date.now() + '\\n');
  setTimeout(() => {
    console.log('');
    console.log('${name} tail line');
    fs.appendFileSync(logFile, name + ' end ' + Date.now() + '\\n');
    process.exit(${exitCode});
  }, ${delayMs - half});
}, ${half});
`);
    return name;
  }
  const logStart = logFile ? `fs.appendFileSync(${JSON.stringify(logFile)}, ${JSON.stringify(name)} + ' start ' + Date.now() + '\\n');\n` : '';
  const logEnd = logFile ? `fs.appendFileSync(${JSON.stringify(logFile)}, ${JSON.stringify(name)} + ' end ' + Date.now() + '\\n');\n` : '';
  fs.writeFileSync(p, `
'use strict';
const fs = require('fs');
${logStart}setTimeout(() => {
  console.log('');
  console.log('${name} tail line');
${logEnd}  process.exit(${exitCode});
}, ${delayMs});
`);
  return name;
}

(async () => {
  console.log('\ntest-verify-all.cjs — bounded concurrency pool actually runs suites concurrently, and never past the configured cap');
  {
    // A wall-clock bound here (e.g. "must finish within Nx a single delay")
    // was tried first and reverted: on a real machine sharing cores with
    // other work -- exactly the condition this suite runs under as
    // unit('test-verify-all.cjs') inside verify-all.cjs's own pool -- ANY
    // uniform overhead added to spawning (disk/CPU contention delaying
    // process creation) pushes elapsed past a fixed multiplier even when the
    // 4 fakes ran with full concurrency. Measured: standalone ~480ms, next to
    // a few other suites 722-982ms, inside the real pool 1343ms -- comfortably
    // past a 1200ms (4x) bound despite nothing being serialized.
    //
    // A second approach -- comparing each fake's own logged start/end
    // timestamps (min(ends) > max(starts), i.e. every fake's interval
    // overlaps every other) -- was tried next and also reverted: it is not a
    // duration bound, but it still depends on relative process-STARTUP
    // timing across separately-spawned processes, which this repo has
    // observed spread by up to ~500ms under load. Reproduced directly: 4
    // fakes launched by the same pool call, with the last one's own 'start'
    // log staggered 500ms after the first purely by spawn contention (a
    // 300ms delay each), still have every ADJACENT pair overlapping -- none
    // of them waited for a predecessor to finish -- yet min(ends) >
    // max(starts) comes out false, because the first fake had already ended
    // before the last one started. That is a false "not concurrent": genuine
    // concurrency does not require every pair's interval to overlap, only
    // that the pool did not serialize them, and startup-time spread alone can
    // break the all-pairs-overlap property regardless of how long the pool
    // held them open.
    //
    // What proves both genuine concurrency AND a bound is a direct
    // concurrent-count measurement instead of a timestamp comparison: each
    // `concurrencyProbe` fake logs its own start, waits half its own delay
    // (a settle window), then reads the shared log and counts how many names
    // have started but not yet ended AT THAT MOMENT, and logs that count.
    // This does not depend on which fake happened to start first or last --
    // only on the settle window being comfortably longer than the worst
    // realistic startup-time spread between fakes in the same wave, which
    // cap+2 fakes and a 2000ms delay (a 1000ms settle window, roughly 2x the
    // ~500ms spread this repo has observed) is sized to survive. More fakes
    // than the concurrency cap also means the pool cannot legally run them
    // all in one wave, so a bug that quietly dropped the cap (or a
    // Promise.all over every item at once) would show a concurrent count
    // above `concurrency` here, which a fixed 4-fakes/no-slack test could
    // never observe regardless of how it measured overlap.
    const dir = tmpDir();
    const logFile = path.join(dir, 'log.txt');
    const concurrency = 4;
    const names = Array.from({ length: concurrency + 2 }, (_, i) => `f${i + 1}.cjs`);
    const delayMs = 2000;
    for (const n of names) writeFake(dir, n, { delayMs, logFile, concurrencyProbe: true });
    const { rc } = await V.runUnitSuites(names, { dir, concurrency, budgetMs: Infinity });
    const concurrentCounts = fs.readFileSync(logFile, 'utf8').trim().split('\n')
      .map((line) => line.split(' '))
      .filter((parts) => parts[1] === 'concurrent')
      .map((parts) => Number(parts[2]));
    check(`at least one fake observed 2 or more fakes (including itself) running at once (observed counts: ${JSON.stringify(concurrentCounts)}), proving the pool ran them concurrently rather than one after another`,
      concurrentCounts.some((c) => c >= 2));
    check(`no fake ever observed more than the configured concurrency (${concurrency}) running at once (max observed: ${Math.max(...concurrentCounts)}), proving the pool is actually BOUNDED and not just "eventually parallel"`,
      Math.max(...concurrentCounts) <= concurrency);
    check('an all-passing run reports rc 0', rc === 0);
  }

  console.log('\ntest-verify-all.cjs — the named serial suite never overlaps the pool');
  {
    const dir = tmpDir();
    const logFile = path.join(dir, 'log.txt');
    const concurrency = 4;
    // At least concurrency+1 pool fakes, not exactly concurrency: with only
    // `concurrency` pool fakes and the serial fake listed last, a bug that
    // silently folds the serial fake into the pool's own queue would only
    // get it pulled off that queue AFTER a lane frees up -- by which point
    // the real pool fakes are already finishing, so "the serial fake started
    // after the pool ended" would look true even though it was never
    // actually serialized. One extra pool fake keeps a lane busy long enough
    // that a wrongly-pooled serial fake genuinely overlaps a still-running one.
    const poolNames = Array.from({ length: concurrency + 1 }, (_, i) => `p${i + 1}.cjs`);
    for (const n of poolNames) writeFake(dir, n, { delayMs: 250, logFile });
    writeFake(dir, 'serial.cjs', { delayMs: 50, logFile });
    // The serial fake sits in the MIDDLE of the combined list, not last --
    // see above for why last would hide the very bug this test exists to catch.
    const mid = Math.floor(poolNames.length / 2);
    const names = [...poolNames.slice(0, mid), 'serial.cjs', ...poolNames.slice(mid)];
    await V.runUnitSuites(names, { dir, serial: ['serial.cjs'], concurrency, budgetMs: Infinity });
    const events = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => {
      const [name, kind, ts] = line.split(' ');
      return { name, kind, ts: Number(ts) };
    });
    const times = (name, kind) => events.filter((e) => e.name === name && e.kind === kind).map((e) => e.ts);
    const serialStart = times('serial.cjs', 'start')[0];
    const serialEnd = times('serial.cjs', 'end')[0];
    const poolStart = Math.min(...poolNames.map((n) => times(n, 'start')[0]));
    const poolEnd = Math.max(...poolNames.map((n) => times(n, 'end')[0]));
    check('the serial suite runs entirely before or entirely after the pool, never overlapping it',
      serialEnd <= poolStart || poolEnd <= serialStart);
  }

  console.log('\ntest-verify-all.cjs — the real SERIAL_SUITES list actually names the known load-sensitive suites');
  {
    // The check above only proves the generic `serial` OPTION keeps whatever
    // it is given out of the pool -- it says nothing about what verify-all.cjs
    // itself hands that option, so it stays green even if `serial:
    // SERIAL_SUITES` is dropped from main()'s own call or SERIAL_SUITES is
    // emptied out from under it. Two more things have to hold directly: the
    // exported SERIAL_SUITES constant still names every known load-sensitive
    // suite, and main() still threads it through to its own runUnitSuites
    // call.
    //
    // Checking only `.includes('test-verify-checkpoint.cjs')` proved blind to
    // removing test-run-state-registry.cjs (the second suite serialized after
    // it flaked inside the pool -- see the comment above SERIAL_SUITES'
    // definition): with that entry dropped, SERIAL_SUITES is
    // ['test-verify-checkpoint.cjs'], the includes() check is still true, and
    // the suite stays green while the second suite silently returns to the
    // pool. Assert against the full, current expected list instead, so
    // removing (or adding, without updating this list) either name is caught.
    const EXPECTED_SERIAL_SUITES = ['test-verify-checkpoint.cjs', 'test-run-state-registry.cjs'];
    check(`SERIAL_SUITES is exactly ${JSON.stringify(EXPECTED_SERIAL_SUITES)} -- the documented lock-timing races -- not missing or gaining an entry`,
      V.SERIAL_SUITES.length === EXPECTED_SERIAL_SUITES.length &&
      EXPECTED_SERIAL_SUITES.every((s) => V.SERIAL_SUITES.includes(s)));
    const src = fs.readFileSync(path.join(__dirname, 'verify-all.cjs'), 'utf8');
    check('verify-all.cjs’s main() wires SERIAL_SUITES into its own runUnitSuites call',
      /runUnitSuites\(UNIT_SUITES,\s*\{\s*serial:\s*SERIAL_SUITES\s*\}\)/.test(src));
  }

  console.log('\ntest-verify-all.cjs — a failing fake fails the aggregate result and is reported by name');
  {
    const dir = tmpDir();
    writeFake(dir, 'ok1.cjs', {});
    writeFake(dir, 'bad.cjs', { exitCode: 1 });
    writeFake(dir, 'ok2.cjs', {});
    const names = ['ok1.cjs', 'bad.cjs', 'ok2.cjs'];
    let out = '';
    const origLog = console.log;
    console.log = (...args) => { out += args.join(' ') + '\n'; };
    let rc;
    try {
      ({ rc } = await V.runUnitSuites(names, { dir, concurrency: 4, budgetMs: Infinity }));
    } finally {
      console.log = origLog;
    }
    check('a failing fake sets the aggregate result non-zero', rc === 1);
    // Matching the bare substring 'bad.cjs' is satisfied by the ordinary
    // per-suite header line ("  bad.cjs (0.05s)") even if the actual failure
    // report line below it is deleted outright. Anchor on the `^^ FAILED`
    // line format verify-all.cjs prints ONLY for a non-zero exit, so this can
    // only pass if that report line is still there.
    check('the failing fake is still reported by name in a ^^ FAILED line',
      /\^\^ FAILED \(exit \d+\): node bad\.cjs/.test(out));
  }

  console.log('\ntest-verify-all.cjs — a wall-time budget fails loudly when exceeded, and not when it is not');
  {
    const dirOver = tmpDir();
    const names = ['x.cjs', 'y.cjs'];
    for (const n of names) writeFake(dirOver, n, { delayMs: 300 });
    let outOver = '';
    const origLog = console.log;
    console.log = (...args) => { outOver += args.join(' ') + '\n'; };
    let rcOver;
    try {
      ({ rc: rcOver } = await V.runUnitSuites(names, { dir: dirOver, concurrency: 4, budgetMs: 50 }));
    } finally {
      console.log = origLog;
    }
    check('a budget set below the fakes\u2019 total wall time fails the run', rcOver === 1);
    check('a budget set below the fakes\u2019 total wall time prints a loud FAIL message', /FAIL/.test(outOver));

    const dirUnder = tmpDir();
    for (const n of names) writeFake(dirUnder, n, { delayMs: 50 });
    const { rc: rcUnder } = await V.runUnitSuites(names, { dir: dirUnder, concurrency: 4, budgetMs: 5000 });
    check('a budget set above the fakes\u2019 total wall time does not fail the run', rcUnder === 0);
  }

  console.log('\ntest-verify-all.cjs — output prints in the original list order regardless of completion order');
  {
    const dir = tmpDir();
    // Listed slowest-first, so completion order is the REVERSE of list
    // order -- if output were printed in completion order, this would come
    // out backwards.
    writeFake(dir, 'slow.cjs', { delayMs: 300 });
    writeFake(dir, 'medium.cjs', { delayMs: 150 });
    writeFake(dir, 'fast.cjs', { delayMs: 10 });
    const names = ['slow.cjs', 'medium.cjs', 'fast.cjs'];
    let out = '';
    const origLog = console.log;
    console.log = (...args) => { out += args.join(' ') + '\n'; };
    try {
      await V.runUnitSuites(names, { dir, concurrency: 4, budgetMs: Infinity });
    } finally {
      console.log = origLog;
    }
    const idx = names.map((n) => out.indexOf(`${n} tail line`));
    check('every fake\u2019s output appears in the printed block', idx.every((i) => i >= 0));
    check('the printed order matches the suite list order, not completion order',
      idx[0] < idx[1] && idx[1] < idx[2]);
  }

  for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort cleanup */ } }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail ? 1 : 0);
})();
