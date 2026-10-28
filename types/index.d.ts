export type CodexSandbox = 'read-only' | 'workspace-write' | 'full-access'
/** yolo: no sandbox and no approvals; only on the user's explicit request or a project default. */
export type CodexApprovals = 'ask' | 'auto' | 'never' | 'yolo'
export type CodexStatus = 'starting' | 'running' | 'idle' | 'interrupted' | 'failed'

/** One Codex job: a Codex thread run under a native `codex-delegate:<alias>` subagent, keyed by that subagent's agentId. */
export type CodexAgent = {
  /** The native subagent's agentId, which SendMessage and TaskStop take. */
  id: string
  name: string
  /** The short task label the transcript shows (the spawn's description, else its prompt's first line). */
  description: string
  threadId: string
  model: string
  effort: string
  sandbox: CodexSandbox
  approvals: CodexApprovals
  cwd: string
  /** The role the job runs as (implementer, reviewer, runner, rescuer); absent for a raw model type. */
  role?: string
  /** HEAD of the job's repo when it spawned; null when cwd is not git or has no commits. Absent on older records. */
  headAtSpawn?: string | null
  status: CodexStatus
  /** The running turn, null when none runs. */
  currentTurnId: string | null
  /** The last turn that ended, null before the first ends. */
  lastTurnId: string | null
  /** completed | interrupted | failed, as Codex reported the last turn. */
  lastTurnStatus: string | null
  /** The final answer of the last turn (or the latest agent message). */
  lastMessage: string
  /** One line of what it is doing now. */
  activity: string
  tokens: number
  error: string | null
  /** Codex's `codexErrorInfo` for the failed turn (e.g. usageLimitExceeded, rateLimitExceeded); absent when Codex gave none. */
  errorCode?: string
  /** The latest non-terminal Codex error (a retry, a failed compaction, work after a reported end); the job runs on. */
  warning?: string | null
  /** The key bin/codex-msg names this job by (in the thread's developer instructions). */
  msgKey: string
  /** codex-msg messages read from the bridge and not yet passed on to the main session. */
  outbox: string[]
  /** Compact lines of the current or last turn: commands, file changes, messages. */
  digest: string[]
  startedAt: number
  updatedAt: number
  turnStartedAt: number
  turnEndedAt: number
  sessionId: string
}

declare module 'claude-code' {
  interface PluginState {
    'codex-delegate': {
      agents: Record<string, CodexAgent>
      /** Survives reloads: names this session's bridge daemon. */
      bridgeKey: string | null
    }
  }
}
