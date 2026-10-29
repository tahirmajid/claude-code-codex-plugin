---
name: delegate-to-codex
description: How to delegate to OpenAI Codex (codex-delegate:* agent types) - type choice, header lines, the .handoff brief, results, refusals and the fallback when Codex fails. Use before spawning any codex-delegate:* agent.
---

# Delegating to Codex

Codex sees only the spawn prompt (header lines stripped) and the files in its cwd.

## Types

| Type | Sandbox / approvals | Use when |
|---|---|---|
| `implementer` | workspace-write / never | decided change: implement, build, test |
| `reviewer` | read-only / never | review; findings only |
| `runner` | workspace-write / ask | no judgement: command, grep, exact patch, rename |
| `rescuer` | workspace-write / ask | stuck task or second pass |

Raw types: `sol` (judgement), `luna` (cheap, mechanical), `astra`/`terra` only when the user asks. No role commits: `.git` is read-only in the sandbox, so you review the diff and commit.

## Header lines (top of the prompt)

`effort:`, `sandbox:`, `approvals:` (can only tighten a role), `cwd: <path>` (run there; abs, relative or `~`; double-quote spaces), `brief: <path relative to the job's cwd>`.

## Brief

Write `.handoff/<job>.md` (template: `templates/handoff.md`; Goal, Scope, Constraints, Acceptance, Out of scope; leave `## Result`), then start the prompt with `brief: .handoff/<job>.md` and one task line. `.handoff/` is git-excluded.

## Results

- The answer is a summary plus a `## Result` (Status, Files changed, Commands run, Open questions). Over `spillChars` (4000) the full text goes to `.handoff/<job>.spill.md`.
- Warnings (missing Result fields, HEAD moved, Co-Authored-By) refuse nothing; check them.
- Verify: `git diff`, re-run acceptance. Never push on Codex's word.
- `codex_list` lists jobs; `codex_result` shows status, error and last message.

## Refusals

The message names the cause: above the `maxSandbox`/`allowedApprovals` ceiling; a header looser than the role; `maxConcurrentJobs` reached; another writer in that cwd or main checkout under `requireWorktree` (use another worktree or `cwd:`); `cwd:` missing, not a directory, or another repository without `allowForeignCwd`; outdated CLI or unknown model/effort.

## Failures

`Codex failed (<code>): <message>`. `usageLimitExceeded`/`rateLimitExceeded`: stop using Codex and give the same brief to the equivalent Claude agent in the same worktree (check for partial changes first); say so in your report. `serverOverloaded` or a connection error: one retry. `unauthorized`: the user runs `codex login`. A stuck job: SendMessage, then TaskStop, and treat its partial changes as untrusted.
