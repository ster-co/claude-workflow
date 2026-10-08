#!/usr/bin/env node
// SessionStart: gives a repository its Serena configuration the first time a
// session opens in it.
//
// Why this is automatic. `bin/claude-repo-setup.sh` has existed since
// 2026-09-21, is idempotent, and detects the languages itself — and nothing ever
// ran it, which is why verify-all.cjs ends with a list of repositories printed as
// "NOT gated". Serena autogenerates a config with only the dominant language
// and reports every other language as *ignored* rather than failing, so an unconfigured repository does not announce
// itself: it answers JS/TS questions with nothing, and the gates that key on
// `.serena/project.yml` stay switched off. A setup step nobody runs is the same
// as no setup step.
//
// What it will and will not write. Only the `--serena-only` slice of that
// script's behaviour, reimplemented here in Node instead of shelled out to:
// `.serena/` ends up gitignored on a machine that has it in the repo's own
// .gitignore or in an operator's global excludesFile, but not on one that has
// neither — so the hook checks with `git check-ignore` at the time it writes
// and reports honestly either way, rather than assuming. The script's other
// outputs — `.claude/settings.json`, `jsconfig.json` — are tracked files, and
// creating those in a repository nobody asked about is a different kind of
// act. Run the script by hand for those. This hook does not shell out to it
// at all: a SessionStart that depends on `bash` and a `python3` heredoc fails outright on
// a Windows machine without Git Bash, so the counting and YAML-editing logic
// below is a direct Node port of that script's `count_ext`/`setup_repo`
// functions rather than a call to them.
//
// It never overwrites an existing config that already lists a language server:
// a repository with one has made its own choices, including the choice to
// list fewer servers than the file counts would suggest. The one exception is
// a config with no usable language_servers entries at all — Serena itself
// writes exactly that, a commented template, the first time it opens a
// project with none — which cannot serve a lookup and so is not a choice
// worth preserving over an ungated repo.
//
// It also keeps the shared Serena servers (bin/serena-relay.cjs, one per
// repository, recorded in hooks/serena-registry.cjs) in step with the
// sessions that use them. A relay that exits cleanly stops its server when it
// was the last client, but a relay that is SIGKILLed cannot, so every session
// start reaps the records no live client depends on. And Serena reads a
// project's configuration once, when its server starts, so after this hook
// writes `.serena/project.yml` it stops that repository's server: each relay
// gets a refused connection on its next request, starts a new server that
// reads the file, and replays its session's `initialize` to it.
//
// Set CLAUDE_NO_AUTO_REPO_SETUP=1 to disable writing the configuration. The
// reaper runs regardless: it is the only thing that stops the server of a
// relay that was killed, whether or not this hook configures repositories.
//
// detectServers, writeProjectYml and commandOnPath are exported for reuse
// (see the export below, and the `require.main === module` guard further
// down).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Loaded defensively: a registry that fails to load must cost the session its
// reaping and its restart, not its start.
let registry = null;
try { registry = require('./serena-registry.cjs'); } catch { registry = null; }

// A hook on SessionStart runs before anything else can. It must never throw and
// never exit non-zero: a failure here is a failure to start the session.
const quit = () => process.exit(0);

const serversIn = (yml) => {
  try {
    const lines = fs.readFileSync(yml, 'utf8').split('\n');
    const i = lines.findIndex((l) => l.startsWith('language_servers:'));
    if (i < 0) return [];
    const out = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith('- '); j++) {
      out.push(lines[j].slice(2).trim());
    }
    return out;
  } catch { return []; }
};

// Directories `count_ext`'s `find -prune` skips: VCS internals, dependency
// trees, build output, and the caches/config dirs that hold no source of their
// own. Pruned means never descended into, at any depth.
const NOISE_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  'site-packages', '.mypy_cache', '.pytest_cache', '.serena', '.claude',
]);

// Counts files per extension under `root`, the way `count_ext` does with
// `find`. Returns a plain object keyed by extension without the leading dot.
function countExtensions(root) {
  const counts = Object.create(null);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (NOISE_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1);
        if (ext) counts[ext] = (counts[ext] || 0) + 1;
      }
    }
  };
  walk(root);
  return counts;
}

// Mirrors setup_repo's server-selection thresholds, with one addition: python
// and typescript fire on any file present, csharp and swift on any file, and yaml fires
// once there are enough files to be worth a server on its own (one stray .yml
// in a Python repo is not a reason to start one) OR when yaml is the only
// supported language present at all, at any count — a repo that is nothing
// but YAML must not stay ungated just because it never reaches the
// noisy-extra threshold. One typescript server covers .js/.jsx/.mjs/.cjs too
// — Serena has no separate javascript id.
function detectServers(root) {
  const c = countExtensions(root);
  const n = (...exts) => exts.reduce((sum, e) => sum + (c[e] || 0), 0);
  const hasPy = n('py') > 0;
  const hasTs = n('ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs') > 0;
  const hasCs = n('cs') > 0;
  const hasSwift = n('swift') > 0;
  const yamlCount = n('yml', 'yaml');
  const servers = [];
  if (hasPy) servers.push('python');
  if (hasTs) servers.push('typescript');
  if (yamlCount >= 10 || (!hasPy && !hasTs && !hasCs && !hasSwift && yamlCount > 0)) servers.push('yaml');
  if (hasCs) servers.push('csharp');
  // swift (sourcekit-lsp, shipped with Xcode's command line tools) on any
  // file: the edit gate gates .swift edits, and without this server Serena
  // answers "path is ignored" for every Swift symbol, so the gate could
  // never be satisfied in a Swift repository.
  if (hasSwift) servers.push('swift');
  return servers;
}

// Whether `cmd` resolves to something runnable: a bare name found on PATH, or
// an absolute path that exists and is executable. Node has no built-in for
// this. A missing binary must be caught, not thrown, and the check must not be
// able to hang a SessionStart.
//
// An absolute path is checked directly and never handed to `where`: on
// Windows `where C:\...\node.exe` fails with `Invalid pattern is specified in
// "path:pattern"`, so every absolute command would read as not on PATH.
function commandOnPath(cmd) {
  if (path.isAbsolute(cmd)) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return fs.statSync(cmd).isFile();
    } catch {
      return false;
    }
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(finder, [cmd], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Serena's supported language servers (python, typescript, ...) all launch
// through `uvx`. Writing `.serena/project.yml` when `uvx` is not on PATH would
// point the edit/commit gates in gate-lib.cjs at a server that can never start:
// every edit would be denied and there would be no lookup tool available to
// satisfy the gate.
function uvxOnPath() {
  return commandOnPath('uvx');
}

// Whether `.serena/` at this repo root is actually excluded from `git
// status` — by the repo's own .gitignore, or by the operator's global
// excludesFile. Both exist in the wild and neither is universal: a machine
// with no global excludesFile entry for `.serena/` shows it as untracked,
// so this is checked with `git check-ignore` rather than assumed the way the
// session-start message used to.
//
// Three-valued. true and false are `check-ignore -q`'s own answers (exit 0:
// ignored, exit 1: not ignored). null means git gave neither answer: the 5 s
// timeout fired, git exited with another status (128 for a fatal error such
// as a directory outside any repository), or git could not be started. The
// SessionStart message says on null that it could not tell; the relay sends
// its notice only on false.
function serenaDirIgnored(root) {
  try {
    execFileSync('git', ['check-ignore', '-q', path.join(root, '.serena')], {
      cwd: root, stdio: 'ignore', timeout: 5000,
    });
    return true;
  } catch (e) {
    return e.status === 1 ? false : null;
  }
}

// Replaces the `language_servers:` key and its `- ` list items with `servers`,
// leaving every other line untouched — a Node port of the python3 heredoc
// setup_repo used to run for the same edit. When the file has no such block,
// appends one, matching the heredoc's `if not replaced` fallback.
function withLanguageServersBlock(text, servers) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const out = [];
  let i = 0;
  let replaced = false;
  while (i < lines.length) {
    if (lines[i].startsWith('language_servers:')) {
      out.push('language_servers:\n');
      for (const s of servers) out.push(`- ${s}\n`);
      i += 1;
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].trim() === '')) {
        if (lines[i].trim() === '') break;
        i += 1;
      }
      replaced = true;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  if (!replaced) {
    out.push('\nlanguage_servers:\n');
    for (const s of servers) out.push(`- ${s}\n`);
  }
  return out.join('');
}

// project.yml content for a repository that has none yet, matching what
// setup_repo's else-branch printf'd.
function newProjectYml(name, servers) {
  return [
    `project_name: "${name}"\n`,
    '\n',
    'language_servers:\n',
    ...servers.map((s) => `- ${s}\n`),
    '\n',
    'ignore_all_files_in_gitignore: true\n',
  ].join('');
}

// Writes .serena/project.yml the way setup_repo's Serena section does:
// replace only the language_servers: block of a file that already exists (a
// no-op if it already reads the way `servers` wants), or create a fresh one.
// Returns whether the file was written, which is what decides whether a
// running server has a configuration it has not read.
function writeProjectYml(yml, name, servers) {
  if (fs.existsSync(yml)) {
    const current = fs.readFileSync(yml, 'utf8');
    const updated = withLanguageServersBlock(current, servers);
    if (updated === current) return false;
    fs.writeFileSync(yml, updated);
    return true;
  }
  fs.mkdirSync(path.dirname(yml), { recursive: true });
  fs.writeFileSync(yml, newProjectYml(name, servers));
  return true;
}

// Exported for bin/serena-relay.cjs, which writes the same configuration for
// a repository that has never had a SessionStart hook run in it — a /ship
// worktree, chiefly, since no session ever starts there, only routes to it.
// commandOnPath is exported too, so the relay can apply this hook's own
// "can the server even start" precondition to whatever command it is about
// to spawn, rather than re-implementing the where/which check. serenaDirIgnored
// is exported so the relay can report honestly, the same way this hook's own
// SessionStart message does, when the config it just wrote is not actually
// hidden from `git status`.
// Guarded below so requiring this file never runs the hook body itself.
module.exports = {
  detectServers, writeProjectYml, commandOnPath, serenaDirIgnored,
};

// The reaper's whole allowance per session start, and its wait for any one
// record's lock. The hook times out at 40 s (hooks.json), and the
// configuration work after the reaper has to fit in that too. Stopping one
// live server can take killTree's 3 s grace, and a lock whose holder hangs
// would make withLock wait its default 30 s. A record skipped for either
// reason is still there at the next session start.
const REAP_BUDGET_MS = 10000;
const LOCK_TIMEOUT_MS = 2000;

// Whether a record's server pid is running at all. A pid that is not an
// integer above 1 names no single process, so it is treated as not running
// and never reaches a kill.
const serverRunning = (rec) =>
  Number.isSafeInteger(rec.pid) && rec.pid > 1 && registry.isAlive(rec.pid);

// Stops the server of every record with no live client and deletes the record.
// Each decision is made under that key's lock, on the record re-read there,
// so a relay that joined after listRecords is never reaped. A running server
// is stopped only through killRecordServer, which refuses unless the live
// process at the pid is the one recorded.
//
// The record is deleted once its server is stopped or dead, or when the
// refusal is IDENTITY_MISMATCH: the live identity at the pid no longer
// matches what was captured at spawn, most likely because the pid was
// reused, though an identity captured at spawn can also predate an exec, so
// this is strong but not certain evidence the recorded server is gone from
// that pid. Any other refusal proves nothing about the process -- no
// identity was recorded, or the live one could not be read (a failed `ps`)
// -- and that server may be running.
// Its record is kept, unless the pid has died meanwhile, so the next session
// start can try again; deleting it would leave a running server with nothing
// left that could ever stop it. A kept record is tried once per session
// start, like every other, inside the same budget.
//
// deleteRecord removes only `<key>.json`: the `<key>.locks/` directory beside
// it is what makes the lock exclusive, and wiping it could let two holders in
// at once.
function reapServers() {
  if (!registry) return;
  const deadline = Date.now() + REAP_BUDGET_MS;
  let records;
  try { records = registry.listRecords(); } catch { return; }
  for (const [key, listed] of Object.entries(records)) {
    if (Date.now() >= deadline) return;
    try {
      // A first pass without the lock, so a record in use costs no lock.
      if (registry.liveClients(listed).length) continue;
      registry.withLock(key, () => {
        const rec = registry.read(key);
        if (!rec || registry.liveClients(rec).length) return;
        if (serverRunning(rec)) {
          try {
            registry.killRecordServer(rec);
          } catch (e) {
            if (e?.code !== 'IDENTITY_MISMATCH' && serverRunning(rec)) return;
          }
        }
        registry.deleteRecord(key);
      }, { timeoutMs: LOCK_TIMEOUT_MS });
    } catch { /* this record waits for a later session start */ }
  }
}

// Stops the shared server recorded for the repository at `root`, so that the
// next server started reads the configuration just written. The record stays:
// the relays respawn from it and carry its live clients over to the new
// server. Returns 'stopped', 'none' when no recorded server is running, or
// 'failed' when a running one could not be stopped (its lock is held, or
// killRecordServer refused it: its pid no longer matches the record, or its
// identity could not be confirmed).
function restartServer(root) {
  if (!registry) return 'failed';
  try {
    const { key } = registry.repoKey(root);
    return registry.withLock(key, () => {
      const rec = registry.read(key);
      if (!rec || !serverRunning(rec)) return 'none';
      registry.killRecordServer(rec);
      return 'stopped';
    }, { timeoutMs: LOCK_TIMEOUT_MS });
  } catch {
    return 'failed';
  }
}

// Guarded so a `require('./repo-setup.cjs')` for its exports alone (see
// above) never reads this process's stdin or reaps/writes anything: only the
// entry script itself — `node hooks/repo-setup.cjs`, as SessionStart and this
// file's own tests run it — has `require.main === module`.
if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
  // First, and outside the configuration work: every early quit() below
  // would otherwise skip it.
  try { reapServers(); } catch { /* never the thing that fails a session start */ }
  try {
    if (process.env.CLAUDE_NO_AUTO_REPO_SETUP === '1') quit();

    let input;
    try { input = JSON.parse(raw || '{}'); } catch { quit(); }
    const cwd = input?.cwd || process.cwd();

    // The repository root, not the working directory: a session opened in a
    // subdirectory configures the repo, not the subdirectory.
    let root;
    try {
      root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { quit(); }
    if (!root) quit();

    const yml = path.join(root, '.serena', 'project.yml');
    const emit = (text) => process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
      suppressOutput: true,
    }));

    const configExists = fs.existsSync(yml);
    const existingServers = configExists ? serversIn(yml) : [];

    // A file already lists usable language_servers entries: that is the
    // operator's own configuration, including the choice to list fewer
    // servers than the file counts would suggest, and this hook must never
    // overwrite it. But if the repo has since grown a language the file
    // never mentions, silence would leave it permanently short a server with
    // no way to notice — so say what is missing and leave the file alone.
    if (configExists && existingServers.length) {
      let servers;
      try { servers = detectServers(root); } catch { quit(); }
      const missing = servers.filter((s) => !existingServers.includes(s));
      if (missing.length) {
        const rel = path.relative(root, yml);
        const them = missing.length === 1 ? 'it' : 'them';
        emit([
          `${rel} already lists language servers (${existingServers.join(', ')}), and this`,
          'hook does not overwrite an existing configuration. This repository also has',
          `files matching: ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'}`,
          `not listed there. Add ${them} to language_servers in ${rel} to enable ${them}.`,
        ].join(' '));
      }
      quit();
    }

    let servers;
    try { servers = detectServers(root); } catch { quit(); }

    // detectServers finds nothing supported, which is the common case for a
    // docs or config repository. Silence is not correct there, for the same
    // reason the uvx-missing case below is not: an ungated repo the operator
    // believes is protected is worse than one they know is not.
    if (!servers.length) {
      emit([
        'This repository has no file matching a language Serena supports, so',
        `${path.relative(root, yml)} was not written. This repository is therefore not`,
        'gated: the edit and commit discipline hooks key on that file existing, and it',
        'does not. A .py file, a .ts or .js file, a .cs file, or enough YAML would',
        'change that.',
      ].join(' '));
      quit();
    }

    // A repository this hook would otherwise configure, but Serena cannot run
    // here: do not write a config that points the gates at a server that will
    // never start. Silence would be the worse failure — the operator would
    // believe edits were being checked when nothing was. Report before
    // exiting; there is no admin-only channel a SessionStart hook can write to
    // instead.
    if (!uvxOnPath()) {
      emit([
        `This repository has files Serena could configure, but uvx is not on PATH, so`,
        `${path.relative(root, yml)} was not written. This repository is therefore not`,
        'gated: the edit and commit discipline hooks key on that file existing, and it',
        'does not. Installing uv provides uvx. On Windows:',
        'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex".',
        'On macOS/Linux: curl -LsSf https://astral.sh/uv/install.sh | sh.',
        'Start a new session afterward to configure this repository.',
      ].join(' '));
      quit();
    }

    let wrote;
    try { wrote = writeProjectYml(yml, path.basename(root), servers); } catch { quit(); }
    const restart = wrote ? restartServer(root) : 'none';
    const chosen = serversIn(yml);
    if (!chosen.length) quit();

    // Factual statements, not instructions: SessionStart context framed as an
    // out-of-band instruction trips prompt-injection defences and gets shown to
    // the operator instead of used.
    const ignored = serenaDirIgnored(root);
    const gitStatusLine = ignored === true
      ? '.serena/ is gitignored here, so this added nothing that git status reports.'
      : ignored === false
        ? `.serena/ is not gitignored here, so ${path.relative(root, yml)} will show as untracked in git status unless you add .serena/ to .gitignore or your global excludes.`
        : `Whether .serena/ is gitignored here could not be determined, so ${path.relative(root, yml)} may show as untracked in git status.`;
    const serverLine = {
      stopped: 'Serena reads a project\'s configuration once when its server starts, so this'
        + ' repository\'s shared Serena server was stopped; this session\'s next Serena call'
        + ' starts it again with these servers.',
      none: 'Serena reads a project\'s configuration once when its server starts. No shared'
        + ' Serena server was running for this repository, so the one this session starts'
        + ' reads it.',
      failed: 'Serena reads a project\'s configuration once when its server starts, and this'
        + ' repository\'s shared Serena server could not be stopped to reread it, so these'
        + ' servers apply once it next starts.',
    }[restart];
    emit([
      `This repository had no usable Serena configuration. ${path.relative(root, yml)} was`,
      `written with language servers: ${chosen.join(', ')}.`,
      serverLine,
      gitStatusLine,
    ].join(' '));
  } catch { /* never the thing that fails a session start */ }
  process.exit(0);
  });
}
