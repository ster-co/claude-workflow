#!/usr/bin/env node
// Behavioural tests for the automatic per-repo Serena setup.
// Run: node ~/.claude/hooks/test/test-repo-setup.cjs
//
//   repo-setup.cjs   SessionStart — gives a repository its Serena config, once.
//
// `claude-repo-setup.sh` has existed since 2026-09-21 and nothing ran it, which
// is why verify-all.cjs ends with a list of repositories that are "NOT gated".
// Serena ships python-only and reports every other language as ignored rather
// than failing, so an unconfigured repo answers JS/TS questions with silence.
//
// House style: every MUST-fire paired with a MUST-NOT. This one writes into a
// repository unattended, so the MUST-NOTs are the important half.
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-repo-setup.cjs -> hooks/test -> hooks: resolve from the
// script's own location, not the homedir, so this suite exercises the
// checkout it lives in rather than always the live ~/.claude install (the
// defect that made a worktree's tests silently grade ~/.claude instead).
const HOOKS = path.join(__dirname, '..');

// Every hook run, and this process's own registry, use a throwaway config
// dir. The hook reaps the Serena registry under CLAUDE_CONFIG_DIR/state at
// every start; pointed at the real ~/.claude it would stop the operator's own
// shared servers. Set before the registry is required: gate-lib.cjs reads it
// once, at load.
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'reposetup-config-'));
process.env.CLAUDE_CONFIG_DIR = CONFIG;
const registry = require(path.join(HOOKS, 'serena-registry.cjs'));
let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}: got ${a}, want ${e}`); }
}

const tmpRepo = (files = {}, init = true) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reposetup-'));
  if (init) execFileSync('git', ['init', '-q', d]);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(d, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return d;
};

const start = (cwd, env = {}) => {
  const r = spawnSync('node', [path.join(HOOKS, 'repo-setup.cjs')], {
    input: JSON.stringify({
      hook_event_name: 'SessionStart', source: 'startup', session_id: 's1', cwd,
    }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: CONFIG,
      CLAUDE_NO_AUTO_REPO_SETUP: '',
      ...env,
    },
  });
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = { RAW: r.stdout }; }
  return { out, code: r.status, stderr: r.stderr };
};
const context = (res) => res.out?.hookSpecificOutput?.additionalContext ?? '';
const yml = (repo) => path.join(repo, '.serena', 'project.yml');
const servers = (repo) => {
  try {
    const lines = fs.readFileSync(yml(repo), 'utf8').split('\n');
    const i = lines.findIndex((l) => l.startsWith('language_servers:'));
    if (i < 0) return [];
    const out = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith('- '); j++) out.push(lines[j].slice(2).trim());
    return out;
  } catch { return []; }
};

const trash = [];
const repo = (...args) => { const d = tmpRepo(...args); trash.push(d); return d; };

// =============================================================================
console.log('\nrepo-setup.cjs — an unconfigured repository gets its language servers');
{
  const r = repo({ 'app/main.py': 'x = 1\n', 'web/app.ts': 'export const a = 1;\n' });
  const res = start(r);
  check('a config is written', fs.existsSync(yml(r)), true);
  check('with the languages actually present', servers(r), ['python', 'typescript']);
  check('and the session is told', /serena/i.test(context(res)), true);
  check('naming the servers it chose', /python/.test(context(res)) && /typescript/.test(context(res)), true);
  // Serena reads a project config once at startup. With no shared server
  // recorded for this repository, the one this session's relay starts is
  // started after the write and reads it, so it applies now; telling the
  // session to wait for the next one would send it elsewhere for nothing.
  check('and that it applies in this session, not only the next',
    /this session/i.test(context(res)) && !/next session/i.test(context(res)), true);
}

// yaml is a noisy extra in a repo that already has a real language — the
// threshold guards against one stray .yml starting a server nobody asked for.
{
  const r = repo({ 'app/main.py': 'x = 1\n', 'cfg/a.yaml': 'a: 1\n', 'cfg/b.yaml': 'b: 1\n', 'cfg/c.yaml': 'c: 1\n' });
  const res = start(r);
  check('python only, not yaml, below the noisy-extra threshold', servers(r), ['python']);
  check('and the session is told', /python/.test(context(res)), true);
}

// But a repo that is nothing but YAML is a YAML repo at any count, not just
// at the >=10 threshold that exists to keep yaml out of a Python repo.
{
  const files = {};
  for (let i = 0; i < 9; i++) files[`k8s/svc-${i}.yaml`] = `name: svc-${i}\n`;
  const r = repo(files);
  const res = start(r);
  check('a yaml-only repo below 10 files still gets yaml', servers(r), ['yaml']);
  check('and it is gated', /yaml/.test(context(res)), true);
}

// MUST NOT touch a repository that has already made its own choices, but a
// detected language the file never mentions must still be surfaced so the
// operator can add it themselves — the file itself stays byte-identical.
{
  const r = repo({ 'app/main.py': 'x = 1\n' });
  fs.mkdirSync(path.join(r, '.serena'), { recursive: true });
  const before = 'language_servers:\n- rust\n';
  fs.writeFileSync(yml(r), before);
  const res = start(r);
  check('an existing config is left exactly as it was', servers(r), ['rust']);
  check('byte-identical, not just the same servers list',
    fs.readFileSync(yml(r), 'utf8'), before);
  check('but the missing detected language is mentioned', /python/.test(context(res)), true);
  check('and the existing choice is named too', /rust/.test(context(res)), true);
}

// Serena itself writes a commented template with no active language_servers
// entries when it first opens a project. That is not a configuration choice
// to preserve — it cannot serve a lookup — so the block gets written, the way
// it would for a repo with no .serena/project.yml at all.
{
  const r = repo({ 'app/main.py': 'x = 1\n' });
  fs.mkdirSync(path.join(r, '.serena'), { recursive: true });
  const before = [
    'project_name: "x"\n',
    '\n',
    '# language_servers:\n',
    '#   - python\n',
    '\n',
    'ignore_all_files_in_gitignore: true\n',
  ].join('');
  fs.writeFileSync(yml(r), before);
  const res = start(r);
  check('a config with no usable entries gets the block written', servers(r), ['python']);
  check('and the rest of the file is preserved',
    fs.readFileSync(yml(r), 'utf8').includes('project_name: "x"'), true);
  check('and the session is told', /python/.test(context(res)), true);
}

// MUST NOT write into a directory that is not a repository at all.
{
  const r = repo({ 'main.py': 'x = 1\n' }, false);
  const res = start(r);
  check('a plain directory is not configured', fs.existsSync(yml(r)), false);
  check('and nothing is reported', context(res), '');
}

// It must not depend on `bash` (or the python3 heredoc the shell script used)
// to write the config: a Windows machine without Git Bash has neither. Proved
// by stripping PATH down to nothing but git's and node's own directories — if
// an implementation still tried to spawn `bash`, that spawn would ENOENT and
// the whole call would be caught and quit silently, so a config appearing here
// is direct evidence no such spawn happened. A test that only checks the file
// exists would pass on this machine either way, since it has bash; this one
// would not.
{
  const which = (bin) => {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, bin);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* not in this dir */ }
    }
    return null;
  };
  const gitBin = which('git');
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const finderBin = which(finder);
  const uvxBin = which('uvx');
  const farm = fs.mkdtempSync(path.join(os.tmpdir(), 'nobash-'));
  trash.push(farm);
  fs.symlinkSync(gitBin, path.join(farm, 'git'));
  fs.symlinkSync(process.execPath, path.join(farm, 'node'));
  // uvx (and the resolver used to find it) must also be reachable here: this
  // farm is proving bash-independence, not uvx detection, which has its own
  // test below.
  // Stub rather than symlink the real binaries: this farm proves
  // bash-independence, and it must build on a machine that has no uvx at all --
  // which is precisely the machine the uvx-absent test below is about. A
  // symlink to a null path throws and takes the whole suite down with it.
  if (finderBin) fs.symlinkSync(finderBin, path.join(farm, finder));
  const uvxStub = path.join(farm, 'uvx');
  if (uvxBin) fs.symlinkSync(uvxBin, uvxStub);
  else { fs.writeFileSync(uvxStub, '#!/bin/sh\nexit 0\n'); fs.chmodSync(uvxStub, 0o755); }

  const r = repo({ 'app/main.py': 'x = 1\n', 'web/app.ts': 'export const a = 1;\n' });
  const res = start(r, { PATH: farm });
  check('the config is still written with only git, node and uvx on PATH',
    servers(r), ['python', 'typescript']);
  check('and the run completed, not just exited quietly',
    /python/.test(context(res)) && /typescript/.test(context(res)), true);
}

// Belt and suspenders on the same claim: the string that used to spawn bash
// should not be sitting in the source to come back by accident.
{
  const src = fs.readFileSync(path.join(HOOKS, 'repo-setup.cjs'), 'utf8');
  check("the hook source contains no \"'bash'\" literal", /'bash'/.test(src), false);
}

// Serena's language servers launch through `uvx`. Writing a config that points
// the edit/commit gates at a server that cannot start would deny every edit
// with no lookup tool able to satisfy the gate — worse than not installing the
// workflow at all. Proved the same way as the no-bash test above: a PATH farm
// holding git, node and `which`/`where` themselves, but no `uvx`, so the
// resolver genuinely reports it missing rather than the test merely asserting
// a mocked answer.
{
  const which = (bin) => {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, bin);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* not in this dir */ }
    }
    return null;
  };
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const gitBin = which('git');
  const finderBin = which(finder);
  const farm = fs.mkdtempSync(path.join(os.tmpdir(), 'nouvx-'));
  trash.push(farm);
  fs.symlinkSync(gitBin, path.join(farm, 'git'));
  fs.symlinkSync(process.execPath, path.join(farm, 'node'));
  fs.symlinkSync(finderBin, path.join(farm, finder));

  const r = repo({ 'app/main.py': 'x = 1\n', 'web/app.ts': 'export const a = 1;\n' });
  const res = start(r, { PATH: farm });
  check('no config is written when uvx is not on PATH', fs.existsSync(yml(r)), false);
  check('and the session is told uvx is missing', /uvx/.test(context(res)), true);
  check('and told the repository is not gated as a result',
    /not gated/i.test(context(res)), true);
  check('and given both installers', /astral\.sh\/uv\/install/.test(context(res)), true);
}

// MUST NOT create the tracked settings file. `.serena/` is gitignored globally,
// so writing it unattended shows up in no git status; `.claude/settings.json` is
// committed in the repos that have one, and creating it in a repository nobody
// asked about would appear as an untracked file in someone else's project.
{
  const r = repo({ 'app/main.py': 'x = 1\n' });
  start(r);
  check('no .claude/settings.json is created',
    fs.existsSync(path.join(r, '.claude', 'settings.json')), false);
}

// A repository with nothing Serena supports gets nothing written, but silence
// would leave the operator believing an ungated repo was protected, so it
// must say so.
{
  const r = repo({ 'README.md': '# docs only\n' });
  const res = start(r);
  check('a repo with no supported language is not configured', fs.existsSync(yml(r)), false);
  check('and the session is told it is not gated', /not gated/i.test(context(res)), true);
}

// bin/serena-relay.cjs writes the same configuration for a routed target
// that has never had a SessionStart hook run in it (BRIEF 7). It reuses
// detectServers/writeProjectYml rather than a copy of them, so they must be
// exported, and requiring this file for them alone must not run the hook: a
// separate process proves both, since requiring the file in-process here
// would attach the (pre-fix) listeners to this suite's own real stdin.
console.log('\nrepo-setup.cjs — detectServers and writeProjectYml are exported, and requiring the file runs nothing');
{
  const r = repo({ 'app/main.py': 'x = 1\n', 'web/app.ts': 'export const a = 1;\n' });
  const script = `
    const before = { data: process.stdin.listenerCount('data'), end: process.stdin.listenerCount('end') };
    const mod = require(${JSON.stringify(path.join(HOOKS, 'repo-setup.cjs'))});
    const after = { data: process.stdin.listenerCount('data'), end: process.stdin.listenerCount('end') };
    const servers = typeof mod.detectServers === 'function' ? mod.detectServers(${JSON.stringify(r)}) : null;
    const wrote = (typeof mod.writeProjectYml === 'function' && servers)
      ? mod.writeProjectYml(${JSON.stringify(yml(r))}, ${JSON.stringify(path.basename(r))}, servers)
      : null;
    process.stdout.write(JSON.stringify({
      before, after, hasDetect: typeof mod.detectServers, hasWrite: typeof mod.writeProjectYml, servers, wrote,
    }));
  `;
  // input: '' gives the child a real stdin that reads empty and closes, the
  // same shape SessionStart's own stdin has -- so a require that still
  // attached the hook's real listeners would run the whole hook body here.
  const res = spawnSync('node', ['-e', script], {
    encoding: 'utf-8', input: '',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_NO_AUTO_REPO_SETUP: '1' },
  });
  let out;
  try { out = JSON.parse(res.stdout); } catch { out = { RAW: res.stdout, stderr: res.stderr }; }
  check('detectServers is exported', out.hasDetect, 'function');
  check('writeProjectYml is exported', out.hasWrite, 'function');
  check('requiring the file attaches no stdin listener (MUST-NOT run SessionStart just by being required)',
    out.after, out.before);
  check('detectServers, called directly, finds the languages actually present', out.servers, ['python', 'typescript']);
  check('writeProjectYml, called directly, writes a fresh config', out.wrote, true);
  check('...with both language servers on disk', servers(r), ['python', 'typescript']);
}

// =============================================================================
// The shared Serena registry (hooks/serena-registry.cjs). Every "server" here
// is a node child this suite spawned and recorded with its captured identity,
// so nothing the hook stops can be anything but this suite's own process; the
// registry lives under the temp CONFIG, never the operator's.
const spawned = [];
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A stand-in for a shared server. Its identity is read only once `ps` shows
// the node command line: captured before the exec, it would name the
// pre-exec image and the hook would rightly refuse to stop it.
function fakeServer() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  spawned.push(child);
  let identity = '';
  for (const deadline = Date.now() + 5000; Date.now() < deadline; sleepMs(20)) {
    identity = registry.captureIdentity(child.pid);
    if (identity.includes('setInterval')) break;
  }
  return { pid: child.pid, identity };
}

// A client that has already exited. The runner's own pid would not do: it is
// alive, so a record naming it would never be reaped and a reaper that never
// reaps would pass.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

const record = (dir, server, clients) => {
  const { root, key } = registry.repoKey(dir);
  registry.write(key, {
    root, pid: server.pid, port: 1, startedAt: Date.now(), identity: server.identity, clients,
  });
  // A real record has a lock directory beside it: the relay writes it under
  // withLock. Create it the same way, so its survival can be checked.
  registry.withLock(key, () => {});
  return key;
};
const locksDir = (key) => path.join(CONFIG, 'state', 'serena', `${key}.locks`);

console.log('\nrepo-setup.cjs — at every start, servers no live session uses are stopped');
{
  // Run from a plain directory: the reaper is not about this repository, and
  // must run even where the hook configures nothing.
  const cwd = repo({}, false);

  const orphan = fakeServer();
  const orphanKey = record(repo({}, false), orphan, [deadPid()]);

  const used = fakeServer();
  const usedKey = record(repo({}, false), used, [deadPid(), process.pid]);

  const gone = { pid: deadPid(), identity: 'a server that already exited' };
  const goneKey = record(repo({}, false), gone, [deadPid()]);

  // The pid is alive but is not the process the record names (as after a
  // reboot reuses the pid): stopping it would kill a stranger.
  const reused = fakeServer();
  const reusedKey = record(repo({}, false), { pid: reused.pid, identity: 'the server that used to have this pid' }, [deadPid()]);

  const res = start(cwd);
  check('the hook still exits clean', res.code, 0);
  check('a server whose clients are all dead is stopped', registry.isAlive(orphan.pid), false);
  check('and its record is deleted', registry.read(orphanKey), null);
  check('but its lock directory is left in place', fs.existsSync(locksDir(orphanKey)), true);
  check('a server with a live client keeps running', registry.isAlive(used.pid), true);
  check('and its record is kept, clients and all', registry.read(usedKey)?.clients.includes(process.pid), true);
  check('a record whose server already exited is deleted', registry.read(goneKey), null);
  check('a live pid that no longer matches the record is not stopped', registry.isAlive(reused.pid), true);
  check('and that stale record is deleted', registry.read(reusedKey), null);
}

// Bounded: SessionStart hooks time out (40 s), and a lock whose holder hangs
// makes withLock wait its full default (30 s). The reaper must give up on that
// one record and go on, not spend the session start waiting for it.
{
  const cwd = repo({}, false);
  const held = fakeServer();
  const heldKey = record(repo({}, false), held, [deadPid()]);
  const orphan = fakeServer();
  const orphanKey = record(repo({}, false), orphan, [deadPid()]);

  const inside = path.join(CONFIG, `holder-${heldKey}`);
  const holder = spawn(process.execPath, ['-e', `
    const registry = require(${JSON.stringify(path.join(HOOKS, 'serena-registry.cjs'))});
    registry.withLock(${JSON.stringify(heldKey)}, () => {
      require('fs').writeFileSync(${JSON.stringify(inside)}, '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    });
  `], { stdio: 'ignore', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG } });
  spawned.push(holder);
  for (const deadline = Date.now() + 10000; Date.now() < deadline && !fs.existsSync(inside); sleepMs(20));
  check('the lock holder is inside the lock', fs.existsSync(inside), true);

  const t0 = Date.now();
  const res = start(cwd);
  const elapsed = Date.now() - t0;
  check('a record whose lock is held does not hold up the hook (under 10 s)', elapsed < 10000, true);
  check('and the hook exits clean', res.code, 0);
  check('that record is left for a later start', registry.read(heldKey)?.pid, held.pid);
  check('and its server is not stopped without the lock', registry.isAlive(held.pid), true);
  check('the other orphan is still reaped', registry.isAlive(orphan.pid), false);
  check('and its record deleted', registry.read(orphanKey), null);
  holder.kill('SIGKILL');
}

// A relay that joins after the reaper listed the records: the reaper's first
// pass saw only dead clients, but by the time it holds the lock the record
// has a live one. Only the re-read under the lock can see that. The joiner
// holds the lock, the hook lists the records, and the joiner then adds a live
// client (this runner) and releases while the hook waits on it.
//
// "After the hook listed" is an event, not a delay: a preload in the hook's
// process marks its first read of this record's file, which is listRecords.
// A fixed delay proved too short under load, where the hook started late,
// listed after the join, and never took the lock.
{
  const cwd = repo({}, false);
  const server = fakeServer();
  const key = record(repo({}, false), server, [deadPid()]);
  const inside = path.join(CONFIG, `joiner-inside-${key}`);
  const listed = path.join(CONFIG, `hook-listed-${key}`);
  const preload = path.join(CONFIG, `mark-listed-${key}.cjs`);
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const readFileSync = fs.readFileSync;
    let marked = false;
    fs.readFileSync = function (file, ...rest) {
      const out = readFileSync.call(this, file, ...rest);
      if (!marked && typeof file === 'string' && path.basename(file) === ${JSON.stringify(`${key}.json`)}) {
        marked = true;
        fs.writeFileSync(${JSON.stringify(listed)}, '');
      }
      return out;
    };
  `);
  const joiner = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const registry = require(${JSON.stringify(path.join(HOOKS, 'serena-registry.cjs'))});
    const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    registry.withLock(${JSON.stringify(key)}, () => {
      fs.writeFileSync(${JSON.stringify(inside)}, '');
      for (const deadline = Date.now() + 20000; Date.now() < deadline && !fs.existsSync(${JSON.stringify(listed)}); nap(5));
      registry.addClient(${JSON.stringify(key)}, ${process.pid});
    }, { timeoutMs: 20000 });
  `], { stdio: 'ignore', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG } });
  spawned.push(joiner);
  for (const deadline = Date.now() + 10000; Date.now() < deadline && !fs.existsSync(inside); sleepMs(20));
  check('the joiner holds the record\'s lock', fs.existsSync(inside), true);

  const hook = spawnSync('node', [path.join(HOOKS, 'repo-setup.cjs')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's1', cwd }),
    encoding: 'utf-8',
    env: {
      ...process.env, CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_NO_AUTO_REPO_SETUP: '', NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    },
  });
  check('the hook exits clean', hook.status, 0);
  check('the hook listed the record while the joiner held its lock', fs.existsSync(listed), true);
  // Proves the ordering the test depends on: had the hook listed after the
  // join, its lock-free first pass would have skipped the record and it
  // would never have taken the lock, so a missing re-check could not show.
  const gens = fs.readdirSync(locksDir(key)).filter((n) => /^\d+$/.test(n)).map(Number);
  const newest = gens.length ? fs.readFileSync(path.join(locksDir(key), String(Math.max(...gens))), 'utf8') : '';
  check('the hook took the lock after the joiner released it', newest, String(hook.pid));
  check('a server whose relay joined while the hook waited keeps running', registry.isAlive(server.pid), true);
  check('and its record keeps the new client', registry.read(key)?.clients.includes(process.pid), true);
}

// The opt-out stops the hook configuring repositories, not the reaper: that is
// the only thing that stops a SIGKILLed relay's server either way.
{
  const cwd = repo({ 'app/main.py': 'x = 1\n' });
  const orphan = fakeServer();
  const key = record(repo({}, false), orphan, [deadPid()]);
  const res = start(cwd, { CLAUDE_NO_AUTO_REPO_SETUP: '1' });
  check('under CLAUDE_NO_AUTO_REPO_SETUP=1 the config is not written', fs.existsSync(yml(cwd)), false);
  check('but a server whose clients are all dead is still stopped', registry.isAlive(orphan.pid), false);
  check('and its record is deleted', registry.read(key), null);
  check('and the hook exits clean', res.code, 0);
}

// A refused kill whose refusal proves nothing about the process keeps the
// record: the next session start tries again. Deleting it would leave the
// server running with nothing left that could ever stop it.
console.log('\nrepo-setup.cjs — a refusal that may be transient keeps the record');
{
  // No identity recorded: the relay's capture at spawn came back empty and
  // it was killed before it could capture again.
  const cwd = repo({}, false);
  const server = fakeServer();
  const key = record(repo({}, false), { pid: server.pid, identity: '' }, [deadPid()]);
  const res = start(cwd);
  check('the hook exits clean', res.code, 0);
  check('a server with no recorded identity is not stopped', registry.isAlive(server.pid), true);
  check('and its record is kept', registry.read(key)?.pid, server.pid);
  // Removed by path, so later hook runs in this suite do not revisit it.
  fs.rmSync(path.join(CONFIG, 'state', 'serena', `${key}.json`), { force: true });
}
{
  // `ps` cannot be started, so the live identity reads as empty. The PATH
  // holds node alone; the reaper runs before anything else would need more.
  const farm = fs.mkdtempSync(path.join(os.tmpdir(), 'nops-'));
  trash.push(farm);
  fs.symlinkSync(process.execPath, path.join(farm, 'node'));
  const cwd = repo({}, false);
  const server = fakeServer();
  const key = record(repo({}, false), server, [deadPid()]);
  const gone = { pid: deadPid(), identity: 'a server that already exited' };
  const goneKey = record(repo({}, false), gone, [deadPid()]);
  const res = start(cwd, { PATH: farm });
  check('the hook exits clean without ps', res.code, 0);
  check('a server whose identity cannot be read is not stopped', registry.isAlive(server.pid), true);
  check('and its record is kept', registry.read(key)?.pid, server.pid);
  check('a record whose server is dead is still deleted without ps', registry.read(goneKey), null);
  fs.rmSync(path.join(CONFIG, 'state', 'serena', `${key}.json`), { force: true });
}

// The registry's private layout belongs to the registry: the hook deletes a
// record through deleteRecord, not by building `<STATE_DIR>/serena/<key>.json`.
{
  const src = fs.readFileSync(path.join(HOOKS, 'repo-setup.cjs'), 'utf8');
  check('the hook does not load the state dir to build the registry\'s record path',
    /require\(['"]\.\/gates\/gate-lib\.cjs['"]\)|\bSTATE_DIR\b|\bregistryDir\b/.test(src), false);
  check('and deletes records through the registry', /registry\.deleteRecord\(key\)/.test(src), true);
}

// =============================================================================
// The hook evaluated in a `vm` context against a stub registry, the pattern
// test-serena-pid-safety.cjs uses for the registry: every kill goes to a stub
// that records it, so a hook that would stop the wrong process shows up as a
// recorded call and never as a signal. `Date` is a clock the stubs advance,
// so a slow kill costs no wall-clock time. git and fs are real; `which uvx`
// is answered as found.
class HookExit { constructor(code) { this.code = code; } }
function runHookInVm({ records = {}, live = new Set(), running = () => true, killRecordServer, cwd, env = {}, clock = { now: 0 } }) {
  const vm = require('vm');
  const calls = [];
  const reg = {
    repoKey: (dir) => ({ root: dir, key: 'vm-key' }),
    withLock: (key, fn) => fn(),
    read: (key) => (records[key] ? { ...records[key] } : null),
    listRecords: () => Object.fromEntries(Object.entries(records).map(([k, r]) => [k, { ...r }])),
    liveClients: (rec) => (rec ? rec.clients.filter((p) => live.has(p)) : []),
    isAlive: (pid) => running(pid),
    killRecordServer: (rec) => {
      calls.push(['killRecordServer', rec.pid, clock.now]);
      if (killRecordServer) killRecordServer(rec);
    },
    killTree: (pid) => { calls.push(['killTree', pid]); throw new Error('stub: killTree'); },
    deleteRecord: (key) => { calls.push(['deleteRecord', key]); delete records[key]; },
  };
  const forbidden = (name) => () => { calls.push([name]); throw new Error(`stub: ${name}`); };
  const deps = {
    fs, path,
    child_process: {
      execFileSync: (file, args, opts) => ((file === 'which' || file === 'where') ? '' : execFileSync(file, args, opts)),
    },
    './serena-registry.cjs': reg,
    './gates/gate-lib.cjs': { STATE_DIR: path.join(CONFIG, 'vm-state-unused') },
  };
  const handlers = {};
  let stdout = '';
  const proc = {
    platform: process.platform, pid: 4000000, env: { ...env },
    cwd: () => cwd,
    stdin: { on: (ev, fn) => { handlers[ev] = fn; } },
    stdout: { write: (s) => { stdout += s; return true; } },
    exit: (code) => { throw new HookExit(code); },
    kill: forbidden('process.kill'),
  };
  const source = fs.readFileSync(path.join(HOOKS, 'repo-setup.cjs'), 'utf8').replace(/^#!.*/, '');
  const hookFn = vm.runInContext(`(function (require, process, Date, console, module) {${source}\n})`, vm.createContext({}));
  // The hook body is guarded by `require.main === module`, true only for the
  // entry script (real Node sets it that way). This stub require function
  // stands in for that entry script the same way, so the guard still lets
  // the SessionStart body run here, as it did before the guard existed.
  const requireFn = (name) => {
    if (!Object.hasOwn(deps, name)) throw new Error(`Unexpected import: ${name}`);
    return deps[name];
  };
  const moduleStub = { exports: {} };
  requireFn.main = moduleStub;
  hookFn(requireFn, proc, { now: () => clock.now }, console, moduleStub);
  let exitCode = null;
  try {
    handlers.data?.(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's1', cwd }));
    handlers.end();
  } catch (e) {
    if (!(e instanceof HookExit)) throw e;
    exitCode = e.code;
  }
  let context = '';
  try { context = JSON.parse(stdout).hookSpecificOutput.additionalContext; } catch { /* nothing emitted */ }
  return { calls, exitCode, context };
}
const named = (calls, name) => calls.filter((c) => c[0] === name);
const refusal = (code) => () => { throw Object.assign(new Error(`stub refusal ${code}`), { code }); };

console.log('\nrepo-setup.cjs — the reaper decides on the refusal\'s reason (vm stub, no OS access)');
{
  const clock = { now: 0 };
  const records = {
    unreadable: { pid: 101, identity: 'x', clients: [9] },
    unrecorded: { pid: 102, identity: '', clients: [9] },
    exited: { pid: 103, identity: 'x', clients: [9] },
    reused: { pid: 104, identity: 'x', clients: [9] },
    orphan: { pid: 105, identity: 'x', clients: [9] },
  };
  const dead = new Set();
  const { calls, exitCode } = runHookInVm({
    records, clock, cwd: CONFIG, env: { CLAUDE_NO_AUTO_REPO_SETUP: '1' },
    running: (pid) => !dead.has(pid),
    killRecordServer: (rec) => {
      clock.now += 1;
      if (rec.pid === 101) refusal('IDENTITY_UNREADABLE')();
      if (rec.pid === 102) refusal('IDENTITY_NOT_RECORDED')();
      // The identity read came back empty because the server exited just
      // then: its pid is dead by the time the reaper looks again.
      if (rec.pid === 103) { dead.add(103); refusal('IDENTITY_UNREADABLE')(); }
      if (rec.pid === 104) refusal('IDENTITY_MISMATCH')();
    },
  });
  check('the hook exits 0', exitCode, 0);
  check('an unreadable live identity keeps the record', Object.hasOwn(records, 'unreadable'), true);
  check('a record without an identity is kept', Object.hasOwn(records, 'unrecorded'), true);
  check('an unreadable identity whose server has since exited is deleted', Object.hasOwn(records, 'exited'), false);
  check('a different process at the pid deletes the record', Object.hasOwn(records, 'reused'), false);
  check('a stopped server\'s record is deleted', Object.hasOwn(records, 'orphan'), false);
  // A kept record costs one attempt per session start, not a retry loop that
  // could eat the budget: every record is tried exactly once.
  check('each record is tried exactly once', named(calls, 'killRecordServer').map((c) => c[1]), [101, 102, 103, 104, 105]);
  check('and nothing is killed except through killRecordServer', named(calls, 'killTree'), []);
}

// Slow kills: each stop takes killTree's full 3 s grace. The reaper starts no
// record once its 10 s allowance is spent, so a machine with many orphans
// cannot run the SessionStart hook into its 40 s timeout.
{
  const clock = { now: 0 };
  const records = {};
  for (let i = 0; i < 6; i++) records[`slow${i}`] = { pid: 200 + i, identity: 'x', clients: [9] };
  const { calls } = runHookInVm({
    records, clock, cwd: CONFIG, env: { CLAUDE_NO_AUTO_REPO_SETUP: '1' },
    killRecordServer: () => { clock.now += 3000; },
  });
  const starts = named(calls, 'killRecordServer').map((c) => c[2]);
  check('slow kills: records are stopped while the budget lasts', starts, [0, 3000, 6000, 9000]);
  check('and no stop starts after 10 s', starts.every((t) => t < 10000), true);
  check('and the rest are left for a later session start', Object.keys(records), ['slow4', 'slow5']);
}

console.log('\nrepo-setup.cjs — the restart stops a server only through killRecordServer (vm stub, no OS access)');
{
  // A live client, so the reaper leaves the record alone and only the
  // restart after the write acts on it.
  const r = repo({ 'app/main.py': 'x = 1\n' });
  const records = { 'vm-key': { pid: 301, identity: 'x', clients: [9] } };
  const { calls, context } = runHookInVm({ records, live: new Set([9]), cwd: r });
  check('the config is written', servers(r), ['python']);
  check('the restart goes through killRecordServer', named(calls, 'killRecordServer').map((c) => c[1]), [301]);
  check('and never calls killTree itself', named(calls, 'killTree'), []);
  check('and the session is told the server was stopped', /was stopped/i.test(context), true);
}
{
  // The pid now belongs to another process: killRecordServer refuses, and
  // nothing may go around it.
  const r = repo({ 'app/main.py': 'x = 1\n' });
  const records = { 'vm-key': { pid: 302, identity: 'x', clients: [9] } };
  const { calls, context } = runHookInVm({
    records, live: new Set([9]), cwd: r, killRecordServer: refusal('IDENTITY_MISMATCH'),
  });
  check('a refused restart calls no killTree', named(calls, 'killTree'), []);
  check('and the session is told the server could not be stopped', /could not be stopped/i.test(context), true);
  check('and the record is kept for its live client', Object.hasOwn(records, 'vm-key'), true);
}

console.log('\nrepo-setup.cjs — writing the config restarts the repository\'s shared server');
{
  const r = repo({ 'app/main.py': 'x = 1\n' });
  const server = fakeServer();
  const key = record(r, server, [process.pid]);
  const res = start(r);
  check('the config is written', servers(r), ['python']);
  check('the recorded server is stopped, so the next one reads the config', registry.isAlive(server.pid), false);
  // The relays reconnect on their next request and respawn from this record,
  // carrying its live clients over. Deleting it would drop them.
  check('its record is kept with its live client', registry.read(key)?.clients.includes(process.pid), true);
  check('and the session is told the server was stopped to reread it', /was stopped/i.test(context(res)), true);
}

// MUST NOT restart a server when the config already existed and was left
// alone: the running server already read that file.
{
  const r = repo({ 'app/main.py': 'x = 1\n', 'web/app.ts': 'export const a = 1;\n' });
  fs.mkdirSync(path.join(r, '.serena'), { recursive: true });
  fs.writeFileSync(yml(r), 'language_servers:\n- python\n');
  const server = fakeServer();
  const key = record(r, server, [process.pid]);
  const res = start(r);
  check('an existing config is left alone', fs.readFileSync(yml(r), 'utf8'), 'language_servers:\n- python\n');
  check('and the server that read it keeps running', registry.isAlive(server.pid), true);
  check('and its record is untouched', registry.read(key)?.pid, server.pid);
  check('and no restart is claimed', /was stopped/i.test(context(res)), false);
}

console.log('\nrepo-setup.cjs — it must never be the thing that fails');
{
  const r = repo({ 'app/main.py': 'x = 1\n' });
  const res = start(r, { CLAUDE_NO_AUTO_REPO_SETUP: '1' });
  check('the opt-out stops it writing', fs.existsSync(yml(r)), false);
  check('and it exits clean', res.code, 0);
}
{
  const res = start('/definitely/not/a/path/that/exists');
  check('a cwd that does not exist exits clean', res.code, 0);
}

// Only this suite's own children, each by its handle: never a pid read back
// from a record.
for (const c of spawned) { try { c.kill('SIGKILL'); } catch {} }
trash.push(CONFIG);
for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
