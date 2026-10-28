<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Codex for Claude Code. Illustration of a Claude Code session: one Codex agent is still running npm test, another has completed, and a one-line notice wakes Claude with its result.">
</p>

**codex-delegate** is a fork of [SSS135/claude-code-codex-plugin](https://github.com/SSS135/claude-code-codex-plugin) (MIT, original author SSS135; see [LICENSE](LICENSE)). It keeps the upstream mechanism and adds guardrails for team use: role agents (implementer, reviewer, runner, rescuer), a user-set policy ceiling, handoff docs with result spill, a worktree guard and a commit audit. Differences from upstream: the plugin is named `codex-delegate`; `ask` is the default approval mode; the sandbox, approvals and concurrency have hard limits; and it never pushes.

A Claude Code plugin that runs OpenAI Codex as native Claude Code background subagents, either as a role or as a raw model (luna, sol, astra, terra). Claude hands a task to a `codex-delegate:sol` agent through its own Agent tool and carries on. The job shows in the native task list, `SendMessage` and `TaskStop` reach it, and when Codex finishes, the native `Agent "<description>" finished` notification brings Claude the Codex final message, word for word. Codex approval requests show up as Claude Code dialogs.

<p align="center">
  <img src="./assets/readme/demo.gif" width="100%" alt="Demo: Claude starts a codex-delegate:sol agent that writes calc.js with two hidden bugs, then runs a reviewer and a test writer in parallel. The test writer asks Claude a question mid-task, Claude answers, both agents report back through native finish notifications, and Claude summarizes the two bugs they found.">
</p>

## How it works

<p align="center">
  <img src="./assets/readme/flow.svg" width="100%" alt="Four steps: Claude starts a codex-delegate:luna background agent and moves on; Codex works in its own sandbox while the native task list shows progress; escalations go to a Claude Code dialog in ask mode or to Codex's reviewer in auto mode; the result arrives as a native task notification and SendMessage continues the thread.">
</p>

The plugin registers four raw model agent types, one per Codex model family: `codex-delegate:luna`, `codex-delegate:sol`, `codex-delegate:astra` and `codex-delegate:terra`. Claude uses them like `general-purpose`, so you can ask in plain words, for example "have a Codex agent fix the flaky retry test". Claude turns that into an Agent call like this:

```json
{ "subagent_type": "codex-delegate:sol", "description": "Fix flaky retry test", "prompt": "effort: medium\nFix the flaky test in retry.test.ts and run it." }
```

### Which agent Claude picks

Each agent type's description in Claude's agent listing opens with when to use it, so Claude routes by it:

| Agent type | Model | Default effort | Use it for |
| --- | --- | --- | --- |
| `codex-delegate:sol` | Newest Sol model | high | Normal tasks: implementation, debugging, analysis, review, anything needing judgement. The default. |
| `codex-delegate:luna` | Newest Luna model | max | Simple mechanical work and searches: find/grep/list, bulk renames, boilerplate, straightforward well-specified edits, data gathering. Cheap and fast. |
| `codex-delegate:astra` | Newest Astra model | high | Only when you ask for astra explicitly. |
| `codex-delegate:terra` | Newest Terra model | high | Only when you ask for terra explicitly. |

In short: `codex-delegate:sol` is the default for normal tasks, `codex-delegate:luna` is for fast searches and easy mechanical tasks, and `codex-delegate:astra` and `codex-delegate:terra` run only when you explicitly ask for them.

Each agent runs the newest model of its family listed by the Codex CLI, comparing numeric versions regardless of list order. With no model of that family, the Agent call is refused with advice to update the CLI (`npm i -g @openai/codex@latest`, or update the ChatGPT app on macOS). Runtime status and job listings show the actual model id chosen.

What happens then:

- The plugin starts the Codex thread and turn itself, with the Agent call's prompt exactly as given (header lines taken off), in the Agent call's `cwd` or the session's. Nothing is relayed through a Claude model.
- The agent the engine starts for it is a thin wrapper. Every model request of its loop is answered by the plugin (a `turn.step` hook): while Codex works, the wrapper calls the plugin's `codex_await` tool, and once the Codex turn ends, it hands back the Codex final message, verbatim. Codex `error` notifications (model capacity, retries, a failed compaction) are warnings shown by `codex_list` and `codex_result`, not an end; a failed turn end counts only when the thread does no more work for 30 s. Where the engine requires a background subagent to report through `SubagentHandback` (auto mode), that call carries it; where the engine does not offer that tool, the failed call is followed by the message as the final text. No Claude model runs for it, so it costs no Claude tokens.
- The wrapper is a real background subagent: it is in the task list ("↓ to manage"), and its finish row and the notification Claude reads are the engine's own.
- `SendMessage` to the agent (by its agentId, or the `name` the Agent call gave) goes to Codex first: it steers the running turn, or, once the agent finished, starts a new turn on the same Codex thread and resumes the agent, which then notifies again. If Codex refuses the message, `SendMessage` reports it as not delivered.
- Codex can message the session mid-task (see Messages from Codex below), and a `SendMessage` reply reaches its running turn.
- `TaskStop`, or stopping the task from the task list, interrupts the Codex turn.

### Prompt header lines

Optional lines at the very top of the prompt, one `key: value` each, set how Codex runs. They are taken off before Codex sees the prompt; everything after them is passed as given.

| Line | Values | Default |
| --- | --- | --- |
| `effort:` | low, medium, high, xhigh, max, ultra (luna does not take ultra) | the model's own (luna max, the others high), unless `defaultEffort` or the project sets one |
| `sandbox:` | read-only, workspace-write, full-access | `defaultSandbox` |
| `approvals:` | auto, ask, never, yolo | `defaultApprovals` |

An effort the model does not take, an unknown sandbox or approvals value, a key given twice, or a prompt with nothing after its header refuses the Agent call before any agent starts. `approvals: yolo` means no sandbox and no approvals; Claude is told to use it only when you asked for it explicitly in the request.

### Messages from Codex

A Codex job can message the Claude session mid-task, as a native background subagent can `SendMessage` to `main`: a question it needs answered, a blocker, or an important interim finding. Each Codex thread gets one extra MCP server, `claude_session` (`bin/codex-msg`, Node, no dependencies), with one tool, `message_claude(text)`, and developer instructions saying when to use it. The tool posts the text to the bridge daemon (`POST /msg`), which holds it for the job's agent; the agent's `codex_await` returns early, and the plugin has the agent send the text to `main` with its own `SendMessage` call, word for word, then wait again. In auto mode the plugin allows that call itself through a `tool.check` hook, only for the call it made: no model request produced the step, so auto mode's classifier has no verdict for it. Claude sees the native message row from that agent. A reply is an ordinary `SendMessage` to the agent, which steers the running Codex turn, so Codex reads it mid-turn as a new user message.

It is an MCP server, not a shell command, because Codex's sandboxes refuse a shell command's `connect()` to the bridge's Unix socket: both `read-only` and `workspace-write` fail with EPERM (tested with `codex sandbox`, Codex CLI 0.160), and only `network_access = true` lifts that, which opens the network too. Codex starts its MCP servers outside the job's sandbox, so `message_claude` works in every sandbox, and in testing it ran without an approval prompt under `approvals: ask`.

Each job is named after the Agent call's description, numbered when another job has it (`Fix flaky retry test`, `Fix flaky retry test (2)`); the Codex thread carries the description too, so the session is easy to find in the Codex app, `codex resume` and `codex agents`.

## Roles

Four role agent types carry a preset. A role job also gets a short preamble (stay in the worktree, never push, commit or not, read the handoff doc, write a `## Result`); raw model types get none.

| Agent type | Sandbox | Approvals | Model | May commit | Use it for |
| --- | --- | --- | --- | --- | --- |
| `codex-delegate:implementer` | workspace-write | never | sol | yes | An already-decided change in one worktree: implement, build, test, commit. |
| `codex-delegate:reviewer` | read-only | never | sol | no | Read-only review of a diff or code area. |
| `codex-delegate:runner` | workspace-write | ask | luna | yes | No-judgement legwork: run a command and report failures, grep, an exact patch, a rename. |
| `codex-delegate:rescuer` | workspace-write | ask | sol | yes | A stuck task or a second pass. |

Raw model types (`codex-delegate:luna`, `sol`, `astra`, `terra`) have no preset: they use the configured defaults and may be told to do anything the policy allows.

## Policy

You, the user, set a ceiling in the plugin settings; nothing a spawn asks for can exceed it. A spawn above it is refused, not clamped.

- `maxSandbox`: highest sandbox any spawn may use.
- `allowedApprovals`: approvals values a spawn may use (`auto`, `ask`, `never`, `yolo`).
- `maxConcurrentJobs`: spawns are refused while this many jobs of the session run.
- `requireWorktree`: writing jobs must run in a linked git worktree, not the main checkout.
- `spillChars`: see Handoff docs.

Precedence for sandbox, approvals and effort: prompt header line, then role preset, then the project's `.claude/codex.json`, then `userConfig`, then built-in defaults. The ceiling applies to the result either way. Headers and the project file can only tighten a role's preset, never widen it: a header sandbox above the role's, or approvals looser than the role's (`ask` < `auto` < `never` < `yolo`), refuses the spawn; raw model types have no preset. `yolo` (no sandbox, no approvals) needs `allowedApprovals` to include `yolo` and `maxSandbox` to be `full-access`.

## Handoff docs, spill and results

- Claude can write a brief to `.handoff/<job>.md` in the job's cwd (see `templates/handoff.md`). A role job is told to read it first and, when it may write, to put its `## Result` there. `.handoff/` is excluded from git through the worktree's own `info/exclude`; `.gitignore` is never touched.
- Spill: a final message longer than `spillChars` (default 4000) is written in full to `.handoff/<job>.spill.md`; the answer carries its first 1,500 characters and the path.
- Result: a role job's `## Result` has four fixed fields: Status, Files changed, Commands run (with output tails), Open questions. The check is warn-only and a case-insensitive substring match: the answer gets a warning naming any field label that does not appear anywhere in it. Nothing is refused.
- Worktree guard: with `requireWorktree` on, a writing spawn in the main checkout (or a non-git directory) is refused. Independently, a writing spawn is refused while another live writing job has the same cwd.
- Commit audit: at the end of a job the answer carries a warning when a role that may not commit moved HEAD, or any new commit has a `Co-Authored-By` trailer. Nothing is reverted.
- The plugin never pushes, and role jobs are told never to push or open or merge a pull request.

## Install

At a Claude Code prompt:

```
/plugin marketplace add github.com/tahirmajid/claude-code-codex-plugin
/plugin install codex-delegate@tahirmajid
```

From a shell:

```
claude plugin marketplace add github.com/tahirmajid/claude-code-codex-plugin
claude plugin install codex-delegate@tahirmajid
```

### Requirements

- Claude Code with the hooks plugin API (function hooks, currently early access).
- The Codex CLI 0.160.0 or newer, with `codex app-server`. An older one refuses each codex-delegate:* spawn with the version found and how to update. It ships inside the ChatGPT desktop app on macOS, or you can install it separately.
- Node 18 or newer.
- macOS, Linux or Windows 10/11. On Windows install the Codex CLI with `npm i -g @openai/codex` (or point `codexPath` at a `codex.exe`); Codex runs its shell commands in PowerShell there.

## Tools

Besides the agent types, Claude sees two tools as `mcp__codex-delegate__<name>`:

| Tool | Parameters | What it does |
| --- | --- | --- |
| `codex_list` | `all` | Lists active jobs and jobs finished within the last 30 minutes, newest first, with model, status, tokens and current activity. With `all: true`, lists the full session history, including restored, interrupted and missing jobs. |
| `codex_result` | `id`, `full` | Status and final message. With `full=true` it adds the turn digest: commands with exit codes, file changes and messages. |

Since 0.2.9, the default list reports how many older finished jobs it hides, including when no active or recently finished jobs remain. `codex_list` with `all: true` lists them; `codex_result` and `SendMessage` still reach any of them.

`id` is the agent's agentId or the job's name (its description, as `codex_list` shows it); `codex_result` reads saved jobs, including older ones and other sessions'. The list reconciles saved jobs with Claude's native agent IDs, so a restored agent is still included when Claude's session ID changes. A third tool, `codex_await`, serves the wrapper agents alone and refuses any other caller.

Jobs are saved separately under `~/.claude/plugins/codex-delegate-agents/` (`CLAUDE_CONFIG_DIR/plugins/codex-delegate-agents/` when set), outside temporary task folders and versioned plugin installs. After a process restart, a running job is shown as interrupted; `SendMessage` loads its saved Codex thread with `thread/resume` and starts a new turn before resuming the wrapper. If its saved record or thread is missing, the message is refused with a clear reason and the wrapper stops instead of retrying `codex_await`. Records already lost by older versions cannot be reconstructed automatically.

Since 0.2.10, job lines distinguish runtime from time since finishing: `running 3m 10s` or `idle, ran 7m 22s, finished 53m ago`. Failed and interrupted jobs keep their status too. The finish age uses the same end timestamp as the default list's 30-minute filter; a seven-minute job finished 53 minutes ago is hidden by default. Older records without an end timestamp omit timing.

In the transcript each call is one row like a native one, for example `● Codex(list)` over `⎿  2 agents · 1 running`. While jobs run they are also named at the end of the hint line under the prompt (`codex: Fix flaky retry test (luna)`); the native task list (↓ to manage) shows and stops them.

## Configuration

Set these in the install screen or the plugin's config menu (`userConfig`):

| Option | Default | Meaning |
| --- | --- | --- |
| `codexPath` | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` | The Codex CLI. If the path is empty or does not exist, `codex` is looked up on PATH. |
| `nodePath` | `/opt/homebrew/bin/node` | Node used to run the bridge. If the path is empty or does not exist, `node` is looked up on PATH. |
| `defaultEffort` | `per-model` | `per-model` uses each model's own default: max for luna, high for sol, astra and terra. Any other value (low, medium, high, xhigh, max, ultra) applies to every model; luna does not take ultra. |
| `defaultSandbox` | `workspace-write` | read-only, workspace-write, full-access. |
| `defaultApprovals` | `ask` | auto, ask, never. `yolo` is never a user-wide default. |
| `maxSandbox` | `workspace-write` | Ceiling on the sandbox of every spawn. |
| `allowedApprovals` | `ask,never` | Comma-separated approvals a spawn may run with, from auto, ask, never, yolo. yolo also needs `maxSandbox` full-access. |
| `spillChars` | `4000` | A final message longer than this spills to `.handoff/<job>.spill.md`. |
| `requireWorktree` | `false` | Refuse a writing job whose cwd is the main checkout rather than a linked git worktree. Read-only jobs are never refused. |
| `maxConcurrentJobs` | `3` | Refuse a spawn while this many jobs of the session run. |

Both path defaults are macOS paths (Apple Silicon with Homebrew). Elsewhere, either keep them and put `codex` and `node` on PATH, or set absolute paths. An empty path also means PATH. On Windows npm's `codex.cmd` shim cannot run without a shell, so the bridge runs the npm package's `codex.js` with node instead, found beside a configured path or on PATH, or a `codex.exe` found there; `codexPath` may also name a `codex.exe` or `codex.js` directly.

A project can set its own defaults in `.claude/codex.json`. The plugin uses the nearest one found walking up to the project root:

```json
{ "effort": "medium", "sandbox": "workspace-write", "approvals": "ask" }
```

When a setting comes from several places, the prompt's header lines beat the role preset, which beats the project's `.claude/codex.json`, which beats `userConfig`, which beats the built-in defaults (see Policy for the ceiling). For effort, the built-in default is per model (luna max, the others high); an `effort` in `.claude/codex.json`, or a `defaultEffort` other than `per-model`, replaces it for every model. The model family comes from the agent type, which runs its newest listed model: `codex-delegate:luna` uses Luna (fast, cheap), `codex-delegate:sol` uses Sol (the default for normal work), `codex-delegate:astra` uses Astra, and `codex-delegate:terra` uses Terra.

## Approval modes

- `ask`: you approve each escalation in a Claude Code dialog. The choices are Allow once, Allow for session and Deny, plus Allow always where Codex can save a rule.
- `auto`: Codex's own reviewer decides on escalations. It is looser than Claude Code's auto mode; in testing it approved writes outside the workspace.
- `never`: no escalation. The sandbox alone decides.
- `yolo`: full bypass with no sandbox and no approvals. Claude uses it only when you ask for it explicitly in the request, or when a project's `.claude/codex.json` makes it the default. You cannot set it as a user-wide default.

"Allow always" adds a `prefix_rule` to Codex's own rules file, `~/.codex/rules/default.rules`, managed like any Codex rule. That rule then applies to every Codex session on the machine, including ones started outside this plugin.

## Architecture

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="The hooks module in Claude Code sends requests over HTTP on a Unix socket to a detached daemon, which runs codex app-server over stdio. The relay, bin/bridge.mjs, reads the daemon's event stream and passes it back to the hooks module as NDJSON on stdout.">
</p>

The hooks module starts `bin/bridge.mjs` as a relay (and Codex starts `bin/codex-msg` per thread, which posts to the same socket). The relay launches a detached daemon, or reattaches to one that is still running. The daemon owns `codex app-server` and serves an HTTP API on a Unix socket under `/tmp/cxb-<uid>/` (mode 0700, owned by your user). On Windows, where Node cannot listen on a Unix socket and the plugin API refuses a named pipe, it serves on a random `127.0.0.1` port instead, every path under a random 128-bit secret, and keeps that address in `%TEMP%\cxb\`. The module sends requests over that socket, and the relay streams the daemon's events back to it as NDJSON on stdout.

The bridge exists because the plugin API cannot write to a child process's stdin once it has spawned it, and `codex app-server` speaks JSON-RPC over stdio. The daemon runs detached so that Codex turns keep running through a plugin reload. The relay also serves the durable agent registry over a separate loopback address under a random secret, including when it reattaches to an older daemon. Existing plugin-store records are migrated on startup; new writes replace only the changed agent's file atomically, so independent sessions cannot replace each other's records. HTTP waits use slices of at most 20 seconds, below the hook host's 30-second limit; that limit alone does not mark a running Codex turn as lost.

The relay starts with the session and again on the next codex call or codex-delegate:* spawn after it stopped (the daemon sat idle, crashed, or a plugin reload ended the relay), so a stopped bridge never needs a restart of Claude Code. When it cannot start, the call or spawn is refused with how it ended, the last lines it wrote to stderr and what to do. It runs with `NODE_OPTIONS` minus preloads (`--require`, `--import`, `--loader`) of files no longer on disk: some terminals preload a file of their own there and delete it later, which would stop every node before it runs a line.

Processes end with the work they serve:

- When a job's turn ends, the plugin unsubscribes from its thread (`thread/unsubscribe`). About a minute later `codex app-server` unloads the thread and stops the MCP servers it started for it: `codex-msg`, and those of Codex's own plugins, such as `computer-history`. A `SendMessage` to the job resumes the thread (`thread/resume`) before its next turn.
- The daemon exits 20 seconds after its relay goes away (the Claude session ended), or after 10 minutes with no turn running and no request. Codex and every MCP server it started exit with it. The plugin starts a new daemon when it next needs one.
- The daemon's directory names the bridge build (its path and code), so a session reloaded onto another plugin version starts a new daemon, and the old one exits once its relay is gone. If the old daemon still runs turns, the reloaded plugin keeps driving it instead, so no turn is lost; about 10 seconds after its last turn ends the plugin stops it, and the next request starts the new version's daemon, which resumes the threads. A wait cut off by a daemon that stops mid-turn ends the job as interrupted, and a `SendMessage` to it starts a new turn on its thread. A daemon started by plugin 0.2.2 or earlier, which never exits on its own while its session lives, is stopped by a newer daemon that has seen it run no turn for 5 minutes.

## Known limits

- The wrapper agent is defined on `haiku`, because an agent type must name a Claude model; the plugin answers every request of its loop, so that model is never called. Where the engine names the agent's model (its task details), it may say haiku; `codex_list` and `codex_result` show the Codex model.
- If the plugin's `turn.step` hook fails for a wrapper request, the engine sends that request to haiku, whose system prompt tells it to call `codex_await` and deliver its result unchanged. A failure is reported in the transcript's dim plugin line.
- In auto mode the hand-back arrives with the engine's note that auto mode's classifier was unavailable for the agent's work: the classifier judges a model's actions with its request, and the wrapper's steps make no request. Only that classifier may allow `SubagentHandback`, so the plugin cannot allow it itself. The report under the note is the Codex final message, verbatim.
- The final message and each `message_claude` message are passed on whole up to 20,000 characters; a longer one is cut there. At most 50 messages wait unread per job.
- Messages are read only while the job's agent runs; one still unread when the bridge daemon exits is lost.
- A Codex thread is started before the Agent call's subagent; if another plugin then refuses the spawn, that thread stays unused.
- The model is chosen by the agent type alone: the four aliases, no other Codex model id.
- Each Agent call starts a new Codex thread. `SendMessage` continues one; there is no way to attach a new agent to an older thread.
- The plugin API does not tell a tool row whether ctrl+o is expanding it, so the text a `codex_*` call returned is not drawn under its row; `codex_result` shows a job's result.
- The running-jobs line under the prompt is drawn on the terminal only.
- Resuming a thread right after Claude Code restarts can take about 20 seconds while Codex reloads it.
- On Windows, which has no SIGTERM, the daemon stops Codex with its whole process tree by force (`taskkill /T /F`), so Codex runs none of its own cleanup on the way out.
- The hooks plugin API is early access and may change between Claude Code releases.

## Development

```
claude plugin validate .
claude plugin test .
node --test tests/registry.test.mjs tests/bridge.test.mjs
claude --plugin-dir .
```

## Merging upstream

The `upstream` remote is `SSS135/claude-code-codex-plugin`. Merge by hand (`git fetch upstream`, then `git merge upstream/main` and resolve). Files most likely to conflict because of the rename and the added features: `hooks/model.ts`, `hooks/register.tsx`, `types/index.d.ts`.

## License

MIT. See [LICENSE](LICENSE). Original work copyright its upstream author.
