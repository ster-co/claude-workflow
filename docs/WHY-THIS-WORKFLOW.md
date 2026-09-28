# Why this workflow, not just the defaults

Every claim below cites the file, commit, or measurement it rests on. If a claim here
goes stale, fix it or delete it — don't leave it standing on a premise that no longer
holds.

**The one-sentence version:** `superpowers` gives you skills — instructions an agent can
choose to follow. This setup adds **hooks that do not ask** — gates that block a tool call
outright when the discipline was skipped — plus an **adversarial audit step** on the two
artifacts nothing downstream re-checks (the plan, and the merged tree), and every one of
those gates exists because something specific went wrong without it. That's the whole
argument; everything below is the receipts.

---

## 1. Instructions get skipped. Gates don't.

`CLAUDE.md` has always said "understand callers before a non-trivial change." Prose. It
was measured against this repo's own history and held **4.8% compliance across 4,874
edits** (`hooks/gates/edit-gate.cjs:5-6`). That is not a rounding error — it means the rule
was, in practice, decorative on 95 edits out of 100.

`hooks/gates/edit-gate.cjs` turns it into something that isn't optional: a source edit
in a gated repo is **denied** until `mcp__serena__find_referencing_symbols` (or
`find_implementations` / `find_declaration`) has actually run this turn. Not "should
run" — the `Edit`, `Write`, `Bash` and `PowerShell` tools themselves refuse. This is the
difference between a workflow and a skill: a skill is instructions in context, competing
with everything else in context for attention; a gate is a `PreToolUse` hook the harness
runs regardless of what the model is thinking about at the time.

The same shape repeats three more times, each closing a hole that was actually measured
open, not hypothesized:

| gate | fires on | what it refuses | what it will not accept |
|---|---|---|---|
| `edit-gate.cjs` | Edit/Write/Bash/PowerShell | a source edit with no reference lookup this turn | `find_symbol` — it locates a definition, says nothing about callers (`refs-record.cjs:8-9`) |
| `commit-gate.cjs` | `git commit` | a commit with no `git diff` this turn | `git status` — it names files, shows no content (README.md:262-264) |
| `plan-gate.cjs` | `git commit` under `docs/plans/` | a plan committed with no audit verdict for *that path* | a verdict for a different plan, or a plan edited since its audit — both invalidate the marker |
| `verify-gate.cjs` | end of turn | a turn ending mid-brief with no `APPROVED` reviewer verdict on file | a verdict `Agent` couldn't parse — recorded as `UNPARSED`, never as approval (`verify-record.cjs`) |

Each denial message tells the agent exactly what call will satisfy it — the point isn't
to be punitive, it's that the bar for "evidence" is object-level and specific, not a
vibe. `SKIP_CODE_GATES=1` is the escape hatch, for when you've actually decided a gate
doesn't apply — not for getting past one you haven't read.

**`superpowers` alone has none of this.** `systematic-debugging`, `test-driven-development`
and friends are excellent prose — they are also just prose, read or skipped at the model's
discretion turn to turn. This setup dispatches through them (`.claude-plugin/plugin.json`
declares the dependency; `commands/` invoke `brainstorming`, `systematic-debugging`,
`writing-plans` and `finishing-a-development-branch` by name) and then wraps the two points
in the loop — editing code, and committing — in hooks that do not care whether the model
remembered to read the skill that turn.

---

## 2. The plan gate: why `/ship`'s plan beats a plain `writing-plans` output

`superpowers:writing-plans` produces a plan document. That's it — a well-structured one,
but nothing downstream checks it against the repository before code gets written against
it. `/blueprint` (`commands/blueprint.md`) adds a step that plan is not allowed to skip:

**Step 3.5 dispatches `plan-auditor`** — a subagent handed *only* the plan's absolute path
and the current architectural premises, deliberately **not** the conversation that produced
the plan. That exclusion is the actual mechanism: a plan's false claims arrive via a chain
of reasoning, and an auditor fed that same chain inherits the same premises and confirms
the same errors. The auditor's only authority is the repository itself — it re-derives each
load-bearing claim (the ones a task, a decision's reason, or a `Done when` rests on) against
what's actually there, and separately flags **stale premises**: tasks or mitigations that
only made sense under an architecture the plan itself has since moved past.

It returns one of three verdicts, and the gate (`hooks/gates/plan-gate.cjs`, a `PreToolUse`
hook on `git commit`) enforces the consequence mechanically:

- **CLEAN** — nothing found, and the auditor has to say what it actually checked. A clean
  verdict that can't name what it attacked has told you nothing.
- **MINOR** — citation drift only (facts right, line numbers off). Recorded under
  `## Known defects — accepted`, which is excluded from the audit's content hash, so writing
  it doesn't re-invalidate the audit. No further round.
- **DEFECTS** — at least one blocking claim is false. Fix it, or write every blocking id
  into `## Known defects — accepted` with the reason you're committing anyway. `plan-gate.cjs`
  reads the verdict's own footer (`Plan: <abs path>`) and hashes the plan *minus* that
  section, so a verdict for a different plan can't unlock this one, and editing the plan
  after the audit silently invalidates the marker — because the edit is exactly where the
  next false claim enters.

**This found real defects, repeatedly, on plans that had already been reviewed by a human.**
On 2026-09-22, a plan written carefully, revised once under challenge, and self-reviewed
still came back with **seven defects** from the auditor — including a false safety claim
("this script cannot spend money") asserted twice as a load-bearing decision, and a task
that would have reimplemented a weaker copy of two tests that already existed
(`commands/blueprint.md:276-281`). None of those were reachable by re-reading the plan,
because re-reading it means re-reading it with the belief that put the error there in the
first place — the exact failure mode a second, independent pass exists to catch.

The alternative was tried and measured worse: a different plan went through **three** audit
rounds (13 → 9 → 10 defects) before anyone thought to ask why the number wasn't
converging — the fix (`## Known defects — accepted` as a first-class, gate-recognized
section) exists because the only other exits from that loop were "perfect it" or
`SKIP_CODE_GATES=1`, and a bypass leaves no trace for the next reader
(`commands/blueprint.md:240-246`).

**`~/.claude` gates its own plans, too.** This isn't a rule applied to client repos and
waived for the tooling's own home — `docs/plans/` in *this* repository is committed and
audited the same way, and was retrofitted in after a bug meant it briefly wasn't
(`commands/blueprint.md:297-311`).

**A subagent dispatched in the background satisfies nothing.** `plan-auditor` must run with
`run_in_background: false` — a backgrounded dispatch returns a launch receipt as its
immediate result, not a verdict, so the recording hook sees nothing to record. Measured:
seven `plan-auditor` dispatches landed zero markers before this was caught
(`commands/blueprint.md:317-322`).

---

## 3. Serena, not the predecessor call-graph tool — measured, not assumed

A locally-built call-graph indexer preceded Serena here and was removed on 2026-09-21.
The reason was **correctness, not licensing**. Against a freshly rebuilt index:

- Its impact analysis on a real symbol (`structured`) returned 7 callers, of which
  **0 were real**, while missing all 8 that were — and reported `epistemic: "exact"`
  on that wrong answer.
- Its rename analysis on `queueFilterKey` duplicated one declaration line and missed
  both real call sites in the same file.
- Its analysis step wrote **45 lines of its own instructions** into a tracked `AGENTS.md`,
  unprompted.
- Its enrichment hook cost a measured **0.64 seconds on every Grep/Glob/Bash call**,
  twice per Bash call — a tax on tools that have nothing to do with call graphs.

(All four, verbatim from the commit that retired it and the README section it rewrote —
see the playground research doc dated 2026-09-25 for the exact commit hashes.)

**This was re-litigated, not assumed stale** (2026-09-25, after that tool's own current
docs were re-read fresh, and again 2026-09-26 against every other credible
code-intelligence option — Claude Code's own native `LSP` tool, Cursor, GitHub Copilot
CLI, Sourcegraph SCIP, `mcp-language-server`). The re-check's own finding: that tool's
current architecture (a global multi-repo server, lazy per-repo eviction) is the same
*shape* the shared-Serena relay in this repo already retrofitted onto Serena — so
switching would not remove a resource problem Serena still has, and it would reintroduce
the one correctness failure already paid to discover. Its tools closest to the gate's
needs are the exact tools measured wrong above; there is no dedicated
find-references/find-implementation tool at all in that product. Full comparison table,
with sourcing marked verified/inferred/unverified line by line: the internal research doc
dated 2026-09-26 in this repository's `docs/`, §4 (same reason, not shipped).

**The honest limit, kept rather than hidden:** no tool in that comparison — not Serena,
not the tool above, not Claude Code's native `LSP`, not Sourcegraph — resolves a **string
reference** (`monkeypatch.setattr(m, "x", f)`-shaped indirection). That's exactly why
`CLAUDE.md`'s *"no callers found is not proof — confirm with a grep"* stays as a standing
rule even with the gate in place, and why `gate-lib.cjs` keys gating on
`.serena/project.yml` existing rather than a `.serena/` directory existing — Serena writes
a global `~/.serena/` with no project config, and keying on the directory would silently
gate every file on the machine. The predecessor tool set the identical trap with its own
global registry file; the lesson was carried forward rather than relearned.

---

## 4. `/attack`: the whole-tree pass nothing else in the loop does

`/execute`'s per-brief reviewer (opus, `agents/reviewer.md`) is a **per-commit** review —
it grades one brief's diff against that brief's intent. A `/ship` run that reaches `/land`
has therefore never had a look at the *merged tree* — what several correct-in-isolation
commits add up to once they're sitting together.

This gap is not theoretical. The same pattern — parallel opus agents over a completed
merge, each briefed to **disprove**, not confirm — found **three real defects in a green
2,298-test suite**: a dropped `.gitignore` entry that would have committed verbatim user
queries, a tool returning soft-deleted rows that the prompt treats as outranking ground
truth, and a schema-drift check blind to two migrations while exiting 0 against all three
live databases. A **per-commit review had already passed one of those seven days earlier**
— it existed only in the merged tree, not in any single commit (`commands/attack.md`,
"Why" section).

This is why `/attack` is a distinct command from the bundled `code-review` skill rather
than a duplicate of it: `code-review` hunts correctness bugs in a diff someone's about to
merge; `/attack` fans out per architectural axis (security, correctness, operational
excellence, idempotency, reliability, performance, cost) over a *standing system* — a
whole repo, a subsystem, a completed merge — and only ever reports, never applies. `/land`
offers it before every push; a "no" costs nothing, and it can be pointed at anything, not
just the branch about to land.

---

## 5. The fine print — smaller fixes that hold up the bigger ones

These read as trivia until you notice each one is a silent failure mode that would
otherwise have made a bigger guarantee false without anyone finding out:

- **The test suite could not fail.** Until 2026-09-22, every unit test in
  `verify-all.cjs` was piped through `tail -2`, so the script reported `tail`'s exit
  status, not the tests'. A red test and a green test looked identical from the outside.
  `verify-all.cjs` now asserts wiring explicitly and fails on any failing test —
  found only because a check was deliberately broken and watched to see if the suite
  noticed. It didn't, the first time.
- **Cross-session recovery was dead on arrival.** The `SessionStart` matcher read
  `compact|resume`, so `checkpoint-restore.cjs` never fired on `startup` at all —
  the crash/reboot recovery path was silently inert while 38 unit tests on that same
  script reported green (README.md:432-437).
- **A global git-ignore change orphaned every teammate's local settings file.** Moving
  `core.excludesFile` without merging the old file's contents silently made every
  `.claude/settings.local.json` in every repo committable — caught only by testing
  `git check-ignore` directly, not by inspection (README.md:397-402).
- **The plugin version-pin trap.** Claude Code only ships an update when `plugin.json`'s
  `version` field moves. Four promotions to the production repo went out at the same
  version, so `claude plugin update` found nothing to do — including the release that
  made the edit gate satisfiable at all for a plugin install. The export script now
  refuses to push an unbumped version, and the guard that checks this was itself broken
  once (it read a remote git archive GitHub doesn't serve, "passed" while reading
  nothing) before being rewritten to actually fail on an unreadable remote
  (`docs/2026-09-24-plugin-rollout-findings.md`, "Version pinning").
- **"It works here" was measured to be close to no evidence at all, for this repo
  specifically.** Four of five defects found in the first real colleague install were
  things only ever true on the machine that built the config: tool names that change
  shape under a plugin namespace, a gitignore claim true only because of a personal
  global gitignore, a scan root hardcoded to one person's directory, and a required
  binary that was inferred, not verified, and nothing in the workflow actually calls.
  Four review rounds and a whole-branch merged-tree review missed all four; a colleague's
  install found them in an afternoon (`docs/2026-09-24-plugin-rollout-findings.md`, "The
  pattern that matters more than any single fix"). Confidence built on one machine has a
  specific, measured failure rate here.

---

## 6. What this does *not* claim

- **No tool resolves a string reference.** Not Serena, not the alternatives evaluated
  against it. The "confirm with a grep" rule in `CLAUDE.md` is load-bearing, not legacy
  advice left over from before the gate existed.
- **The edit gate proves a lookup happened, not that it was read.** `refs-record.cjs`
  records that a qualifying tool call was made; it cannot verify the caller list was
  understood rather than glanced past.
- **Windows `/execute` end-to-end and `/land` through to a real PR are still unverified**
  as of the last real colleague install (`docs/2026-09-24-plugin-rollout-findings.md`,
  "Still untested"). Everything up to and including the gates firing is verified there.
- **A colleague who copies `settings.json` wholesale instead of using `SETUP.md`'s merge
  script (step 4b) can still disable `workflow-discipline`.** The export no longer ships
  this machine's own `enabledPlugins` list (fixed 2026-09-28 — it was clobbering a
  colleague's plugin enablement outright), but a plain copy still overwrites the key
  rather than merging it, so a colleague still needs step 4b, not a plain copy. `SETUP.md`'s
  troubleshooting table names the symptom and the fix.
- **This document itself will go stale.** Every dated claim above should be treated as
  "true as of the commit/date cited" — if you're reading this after a material change to
  the gates, the plan-auditor, or the code-intelligence choice, check the cited file
  before repeating the claim to someone else.
