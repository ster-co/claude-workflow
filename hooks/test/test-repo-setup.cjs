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
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// hooks/test/test-repo-setup.cjs -> hooks/test -> hooks: resolve from the
// script's own location, not the homedir, so this suite exercises the
// checkout it lives in rather than always the live ~/.claude install (the
// defect that made a worktree's tests silently grade ~/.claude instead).
// REAL_CONFIG below stays homedir-based -- it deliberately targets the live
// ~/.claude config, not the checkout under test.
const HOOKS = path.join(__dirname, '..');
const REAL_CONFIG = path.join(os.homedir(), '.claude');
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
      CLAUDE_CONFIG_DIR: REAL_CONFIG,
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
  // Serena reads a project config once at startup, so a config written now is
  // not in effect now. Saying otherwise sends the next tool call into silence.
  check('and that it applies to the next session, not this one',
    /next session/i.test(context(res)), true);
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

for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail ? 1 : 0);
