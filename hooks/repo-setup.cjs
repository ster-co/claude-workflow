#!/usr/bin/env node
// SessionStart: gives a repository its Serena configuration the first time a
// session opens in it.
//
// Why this is automatic. `bin/claude-repo-setup.sh` has existed since
// 2026-09-21, is idempotent, and detects the languages itself — and nothing ever
// ran it, which is why verify-all.cjs ends with a list of repositories printed as
// "NOT gated". Serena ships python-only and reports every other language as
// *ignored* rather than failing, so an unconfigured repository does not announce
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
// Set CLAUDE_NO_AUTO_REPO_SETUP=1 to disable.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
// and typescript fire on any file present, csharp on any file, and yaml fires
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
  const yamlCount = n('yml', 'yaml');
  const servers = [];
  if (hasPy) servers.push('python');
  if (hasTs) servers.push('typescript');
  if (yamlCount >= 10 || (!hasPy && !hasTs && !hasCs && yamlCount > 0)) servers.push('yaml');
  if (hasCs) servers.push('csharp');
  return servers;
}

// Serena's supported language servers (python, typescript, ...) all launch
// through `uvx`. Writing `.serena/project.yml` when `uvx` is not on PATH would
// point the edit/commit gates in gate-lib.cjs at a server that can never start:
// every edit would be denied and there would be no lookup tool available to
// satisfy the gate. `where`/`which` is the portable way to ask "is this on
// PATH" — Node has no built-in for it. A missing binary must be caught, not
// thrown, and the check must not be able to hang a SessionStart.
function uvxOnPath() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(finder, ['uvx'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Whether `.serena/` at this repo root is actually excluded from `git
// status` — by the repo's own .gitignore, or by the operator's global
// excludesFile. Both exist in the wild and neither is universal: a machine
// with no global excludesFile entry for `.serena/` shows it as untracked,
// so this is checked with `git check-ignore` rather than assumed the way the
// session-start message used to.
function serenaDirIgnored(root) {
  try {
    execFileSync('git', ['check-ignore', '-q', path.join(root, '.serena')], {
      cwd: root, stdio: 'ignore', timeout: 5000,
    });
    return true;
  } catch {
    return false;
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
function writeProjectYml(yml, name, servers) {
  if (fs.existsSync(yml)) {
    const current = fs.readFileSync(yml, 'utf8');
    const updated = withLanguageServersBlock(current, servers);
    if (updated !== current) fs.writeFileSync(yml, updated);
    return;
  }
  fs.mkdirSync(path.dirname(yml), { recursive: true });
  fs.writeFileSync(yml, newProjectYml(name, servers));
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
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

    try { writeProjectYml(yml, path.basename(root), servers); } catch { quit(); }
    const chosen = serversIn(yml);
    if (!chosen.length) quit();

    // Factual statements, not instructions: SessionStart context framed as an
    // out-of-band instruction trips prompt-injection defences and gets shown to
    // the operator instead of used.
    const ignored = serenaDirIgnored(root);
    const gitStatusLine = ignored
      ? '.serena/ is gitignored here, so this added nothing that git status reports.'
      : `.serena/ is not gitignored here, so ${path.relative(root, yml)} will show as untracked in git status unless you add .serena/ to .gitignore or your global excludes.`;
    emit([
      `This repository had no usable Serena configuration. ${path.relative(root, yml)} was`,
      `written with language servers: ${chosen.join(', ')}.`,
      'Serena reads a project\'s configuration once when its server starts, so these',
      'servers are available from the next session rather than this one.',
      gitStatusLine,
    ].join(' '));
  } catch { /* never the thing that fails a session start */ }
  process.exit(0);
});
