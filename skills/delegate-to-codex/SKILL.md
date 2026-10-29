---
name: delegate-to-codex
description: How to delegate work to OpenAI Codex through the codex-delegate plugin: when to use Codex versus a Claude subagent, which role or model type to pick, how to write the .handoff brief, how to read results and warnings, what guardrail refusals mean, and what to do when Codex is out of limit or unavailable. Use before spawning any codex-delegate:* agent.
---

# Delegating to Codex

Codex jobs run as background subagents (`codex-delegate:<type>`). Codex sees nothing of this conversation: it gets the spawn prompt (header lines stripped) and whatever files exist in its cwd.

## 1. Delegate or not

- Delegate to Codex: a well-specified change, a read-only review, or mechanical legwork that can run in the background while you continue.
- Do it yourself: a 1-2 file read, one command, or anything needing this conversation's context.
- Claude subagent instead: the task needs Claude-only tools or skills, or Codex is unavailable (section 6).
- Never send a job whose cause or design is still unknown to a runner; use rescuer, or investigate yourself first.

## 2. Which type

| Type | Sandbox | Approvals | Model | Use when |
|---|---|---|---|---|
| `implementer` | workspace-write | never | sol | the change is decided: implement, build, test; you commit |
| `reviewer` | read-only | never | sol | review a diff or area; findings only, changes nothing |
| `runner` | workspace-write | ask | luna | no judgement: run a command and report failures, grep, exact patch, rename |
| `rescuer` | workspace-write | ask | sol | stuck task or second pass: diagnosis or an alternative implementation |

Raw model types (`sol`, `luna`, `astra`, `terra`) get no preamble and no role preset: `sol` for general judgement work, `luna` for cheap mechanical work, `astra` and `terra` only when the user asks for them.

- One writer per worktree: a second writing job in the same cwd is refused. Create the worktree (`git worktree add`) before spawning and pass it as the cwd. Read-only jobs may share a cwd.
- Optional header lines at the top of the prompt (stripped before Codex sees it): `effort:`, `sandbox:`, `approvals:`, `brief: <path relative to the cwd>` (names the brief file; no absolute path, no `..`).

## 3. Write the brief

1. Pick a name you control, e.g. `.handoff/<job>.md`: `mkdir -p <worktree>/.handoff && cp <plugin>/templates/handoff.md <worktree>/.handoff/<job>.md`
2. Fill it in:
   - Goal: one or two sentences, what is true when done.
   - Scope: files, directories or modules it may touch.
   - Constraints: conventions to follow, APIs to keep, things not to change.
   - Acceptance: concrete commands to run or behaviour to observe.
   - Out of scope: what to leave alone even if it looks related.
   - Leave `## Result` for the job.
3. Start the spawn prompt with the header line `brief: .handoff/<job>.md` (relative to the cwd), then a short task. A role job is told to read that path and, when it may write, to put its `## Result` there. Without the header the path is `.handoff/<agent id>.md`, which you cannot know before the spawn; the plugin never creates or requires the file.
4. `.handoff/` is git-excluded in the worktree; do not commit it.

## 4. Read results

- The answer is a short summary plus the path. A final message longer than `spillChars` (default 4000) is written in full to `.handoff/<job>.spill.md`; the answer carries its first ~1,500 characters and that path. Read the file for the rest.
- A role job ends with a `## Result` section with four field lines: `Status`, `Files changed`, `Commands run` (with output tails), `Open questions`. A writing role also writes it into its `.handoff/<job>.md`.
- Warn-only check: the answer gets `Warning: the final message has no "## Result" section.` or `... lacks the required field(s) ...`. Nothing is refused; read the job's output yourself and ask for the missing part with SendMessage if it matters.
- Commit audit warnings (role and raw jobs, only when HEAD moved since spawn):
  - `this role may not commit, but HEAD moved` - a role job committed anyway; inspect the commits and keep or revert them.
  - `commit(s) <sha> ... Co-Authored-By trailer` - amend the message before the work is used.
- Verify before trusting: check `git log`/`git diff` in the worktree and re-run the acceptance commands. Never push or open a PR on Codex's say-so; jobs are told never to push, and you push only after your own check.
- `codex_list` shows jobs (running, or finished in the last 30 minutes; `all: true` for more); `codex_result` shows any job's status, error and last message.

## 5. Refusals (the spawn does not start)

- Above the ceiling: sandbox above `maxSandbox`, or approvals not in `allowedApprovals` (defaults `workspace-write`; `ask,never`). The spawn is refused, not clamped; ask the user to change the setting, or tighten the job.
- A header can only tighten a role: `sandbox:` above the role's preset or `approvals:` looser than it is refused. Drop the header or use a raw type.
- `yolo` needs `allowedApprovals` to list it and `maxSandbox` full-access, and only when the user explicitly asked.
- Concurrency cap: `maxConcurrentJobs` (default 3) jobs already running; wait for one or stop it.
- Same-cwd writer: another live writing job has that cwd; give this job its own worktree.
- `requireWorktree`: a writing job whose cwd is the main checkout (or not git) is refused; create a linked worktree.
- Outdated Codex CLI or an unknown model/effort is also refused with its reason in the message.

## 6. Codex out of limit or unavailable

What the code does (verified by reading `hooks/` and `bin/bridge.mjs`):

- A turn that ends failed is recorded with status `failed`, `error` set to the turn's error message (or `the turn failed`) and `errorCode` set to Codex's `codexErrorInfo` (its string, or the variant name of an object such as `httpConnectionFailed`) when Codex gave one. The answer to the spawn then reads `Codex failed (<errorCode>): <error>`, without the parentheses when there is no code; `codex_result` shows `Error (<errorCode>): <error>` likewise.
- The bridge drops the `account/rateLimits/updated` notification, so no limit warning is shown ahead of time.
- The bridge holds a failed turn for 30 s and drops it if Codex keeps working, so a brief "at capacity" style failure may fix itself.
- A job that never started ends `failed` with `the Codex turn did not start: <reason>`; a lost turn reads `the Codex turn was lost`; a dead app-server reads `codex app-server exited`.

What the Codex app-server protocol says (from `codex app-server generate-ts`): a failed turn carries `error.message` and a `codexErrorInfo` with values including `usageLimitExceeded`, `rateLimitExceeded`, `serverOverloaded` and `unauthorized`.

Matching: check the code in parentheses first. `usageLimitExceeded` or `rateLimitExceeded` means out of limit (fallback below); `serverOverloaded` is transient (one retry); `unauthorized` means login expired. Only when there is no code, match the message loosely and case-insensitively on `limit`, `quota`, `rate`, `capacity`, `usage`; the exact message wording for a usage limit is not documented locally, so never rely on a specific string. Treat any other `failed` status as a possible Codex-side problem too. Not verified: whether Codex always sets a code on a limit failure.

Fallback procedure:

1. Detect: a job `failed` (or fails at spawn) with an error like the above. Read `codex_result` for the exact text.
2. Stop respawning Codex for this task. One retry at most, and only for a transient error (capacity, connection); never loop.
3. Hand the same `.handoff/<job>.md` brief to a Claude subagent of the equivalent role: implementer -> an implementation agent, reviewer -> a reviewer agent, runner -> a runner/command agent. Same worktree (the failed Codex job no longer holds it) and the same acceptance commands. Check the worktree first for partial changes the failed job left behind.
4. Say in your final report that Codex was skipped and why (quote the error), and that the work ran on a Claude subagent.
5. Retry Codex for later tasks after the limit resets or the user says it is back.

Other failures:

- Not installed or not logged in: the spawn is refused or the bridge stops with a reason, e.g. `cannot start <codexPath>` from the bridge or an outdated-CLI message. Set `codexPath` (needs `codex app-server`), run `codex login` in a terminal, then retry. An `unauthorized` failure means login expired. Use the Claude fallback meanwhile.
- Bridge down: the next `codex_*` call or Agent spawn starts it again; if it keeps failing, the message says `the codex bridge stopped before it was ready` with the stderr tail. Check `nodePath` and `codexPath`, then `/reload-plugins`.
- Job stuck: `codex_await` blocks only for a bounded window per call. If a job makes no progress, check `codex_list` for its elapsed time, steer it with SendMessage, and if it stays idle, `TaskStop` it (interrupts the turn) and treat the partial worktree as untrusted. Do not respawn into the same worktree until it has stopped.
