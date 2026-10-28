// Role presets: each `codex-delegate:<role>` agent type runs with these
// defaults. Header lines can lower them; the userConfig ceiling still caps
// the final value (model.ts permissionsFor).

import type { CodexApprovals, CodexSandbox } from '../types'

export type Role = {
  sandbox: CodexSandbox
  approvals: CodexApprovals
  /** A MODEL_ALIASES key. */
  model: string
  /** Whether the job may commit in its own worktree (enforced from the handoff preamble on). */
  commit: boolean
  whenToUse: string
}

export const ROLES: Record<string, Role> = {
  implementer: {
    sandbox: 'workspace-write',
    approvals: 'never',
    model: 'sol',
    commit: true,
    whenToUse: 'Applies an already-decided change in one worktree: implement, build, test, commit. Not for planning or open-ended debugging.',
  },
  reviewer: {
    sandbox: 'read-only',
    approvals: 'never',
    model: 'sol',
    commit: false,
    whenToUse: 'Read-only review of a diff or code area; reports findings and changes nothing.',
  },
  runner: {
    sandbox: 'workspace-write',
    approvals: 'ask',
    model: 'luna',
    commit: true,
    whenToUse: 'No-judgement legwork: run a command and report its failures, grep/find, apply an exact patch, rename or reformat.',
  },
  rescuer: {
    sandbox: 'workspace-write',
    approvals: 'ask',
    model: 'sol',
    commit: true,
    whenToUse: 'A stuck task or a second pass: deeper diagnosis or an alternative implementation.',
  },
}
