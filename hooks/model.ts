// Pure logic of the codex plugin: no `$` here (the engine follows `$` only
// within one file, so every engine call lives in register.tsx). Codex
// protocol parameters, how events change an agent, and the texts the model
// and the person read.

import type { EngineInterface, ToolSpec } from 'claude-code'

import type { CodexAgent, CodexApprovals, CodexSandbox } from '../types'
import { ROLES } from './roles'
import type { Role } from './roles'

export type Settings = {
  codexPath: string
  nodePath: string
  /** Undefined (userConfig per-model): each model's built-in effort (MODEL_EFFORTS). */
  defaultEffort: string | undefined
  defaultSandbox: CodexSandbox
  defaultApprovals: CodexApprovals
  /** Hard ceilings on the final resolved value, whatever its source. */
  maxSandbox: CodexSandbox
  allowedApprovals: CodexApprovals[]
  maxConcurrentJobs: number
  /** A final message longer than this is written in full to .handoff/<job>.spill.md and shown as its head plus the path. */
  spillChars: number
  /** Refuse a writing job whose cwd is the main checkout rather than a linked git worktree. */
  requireWorktree: boolean
  /** Allow a `cwd:` header to name a checkout of a different repository than the session's. */
  allowForeignCwd: boolean
}

export type BridgeEvent =
  | { type: 'ready'; socket: string; registry?: string; reattached: boolean; active: Record<string, string>; codexVersion?: string | null }
  | { type: 'notification'; method: string; params: Record<string, unknown> }
  | { type: 'request'; id: number | string; method: string; params: Record<string, unknown> }
  | { type: 'exit'; code: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'fatal'; message: string; logTail: string }

/** A failure to show the model as the tool's error. */
export class CodexError extends Error {}

/** Where $.http.fetch sends a bridge endpoint: over the daemon's Unix socket, or on Windows to its loopback URL, which carries the daemon's secret (bin/bridge.mjs). */
export const bridgeTarget = (socket: string, endpoint: string): { url: string; socketPath?: string } =>
  /^https?:/.test(socket) ? { url: `${socket}${endpoint}` } : { url: `http://codex${endpoint}`, socketPath: socket }

export const PREFIX = 'mcp__codex-delegate__'
export const SANDBOXES: CodexSandbox[] = ['read-only', 'workspace-write', 'full-access']
export const APPROVALS: CodexApprovals[] = ['auto', 'ask', 'never', 'yolo']
export const MAX_AGENTS = 40

export const MODEL_ALIASES: Record<string, string> = {
  luna: 'gpt-6-luna',
  sol: 'gpt-6.1-sol',
  astra: 'gpt-6-astra',
  terra: 'gpt-5.6-terra',
}

/** Each model's built-in effort, used when neither userConfig nor the project sets one. */
export const MODEL_EFFORTS: Record<string, string> = { luna: 'max', sol: 'high', astra: 'high', terra: 'high' }
/** The defaultEffort userConfig value (its default) that leaves effort to MODEL_EFFORTS. */
export const PER_MODEL_EFFORT = 'per-model'

/** The alias a model id belongs to, by its family suffix (`gpt-5.6-luna` is luna too); else the id. */
export const aliasOf = (model: string): string =>
  Object.keys(MODEL_ALIASES).find(alias => model === MODEL_ALIASES[alias] || model.endsWith(`-${alias}`)) ?? model

export const UPDATE_HINT = 'Update the Codex CLI: npm i -g @openai/codex@latest, or update the ChatGPT app on macOS.'

/** The oldest Codex CLI this plugin runs on (its app-server API, and MCP servers outside the job's sandbox). */
export const MIN_CODEX_VERSION = '0.160.0'

const versionParts = (version: string): number[] => version.split('-')[0]!.split('.').map(Number)

/** The x.y.z in `codex --version`'s output (`codex-cli 0.162.0-alpha.2`), or null. */
export const parseCodexVersion = (text: string | null | undefined): string | null =>
  text?.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/)?.[1] ?? null

/**
 * Undefined when the Codex CLI the bridge found is new enough, or its version is
 * unknown (an older relay, or output with no version); otherwise the refusal. A
 * prerelease of the minimum counts as the minimum.
 */
export const codexVersionError = (reported: string | null | undefined): string | undefined => {
  const found = parseCodexVersion(reported)
  if (found === null) return undefined
  const have = versionParts(found)
  const need = versionParts(MIN_CODEX_VERSION)
  for (let i = 0; i < need.length; i++) {
    const difference = (have[i] ?? 0) - (need[i] ?? 0)
    if (difference > 0) return undefined
    if (difference < 0) return `the Codex CLI is ${found}, older than ${MIN_CODEX_VERSION}, the oldest this plugin runs on. ${UPDATE_HINT}`
  }
  return undefined
}

/** NODE_OPTIONS flags whose value is a file node loads before any script. */
const PRELOAD_FLAGS = ['--require', '-r', '--import', '--loader', '--experimental-loader']

/** NODE_OPTIONS split as node splits it: on spaces, a double-quoted run kept whole. */
const nodeOptionTokens = (value: string): string[] =>
  [...value.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(match => match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]!)

/** A preload's file on disk: an absolute path or a file: URL; a package name or relative path is node's to resolve. */
const preloadFile = (value: string): string | null => {
  if (value.startsWith('file:')) {
    try {
      return decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    } catch {
      return null
    }
  }
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) ? value : null
}

type Preload = { tokens: number; file: string | null }

/** Each token of NODE_OPTIONS, with the file it preloads when it is a preload flag (the flag and a separate value both count). */
const parsePreloads = (tokens: string[]): Preload[] => {
  const parsed: Preload[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const flag = PRELOAD_FLAGS.find(name => token.startsWith(`${name}=`))
    if (flag) parsed.push({ tokens: 1, file: preloadFile(token.slice(flag.length + 1)) })
    else if (PRELOAD_FLAGS.includes(token) && i + 1 < tokens.length) {
      parsed.push({ tokens: 2, file: preloadFile(tokens[i + 1]!) })
      i += 1
    } else parsed.push({ tokens: 1, file: null })
  }
  return parsed
}

/** The files NODE_OPTIONS preloads by absolute path, which the plugin checks are on disk. */
export const nodeOptionPreloads = (value: string): string[] =>
  parsePreloads(nodeOptionTokens(value)).flatMap(one => (one.file === null ? [] : [one.file]))

/**
 * NODE_OPTIONS without its preloads of the given missing files. A terminal or tool
 * may preload a file of its own through NODE_OPTIONS and delete it later (cmux's
 * restore-node-options.cjs); every node started after that exits before running
 * a line, and the bridge with it.
 */
export const withoutPreloads = (value: string, missing: ReadonlySet<string>): string => {
  const tokens = nodeOptionTokens(value)
  const kept: string[] = []
  let at = 0
  for (const one of parsePreloads(tokens)) {
    if (one.file === null || !missing.has(one.file)) kept.push(...tokens.slice(at, at + one.tokens))
    at += one.tokens
  }
  return kept.map(token => (/[\s"]/.test(token) ? `"${token.replace(/(["\\])/g, '\\$1')}"` : token)).join(' ')
}

/** What to do about a bridge that would not start; every codex call tries again. */
export const BRIDGE_ADVICE =
  'The next codex call or Agent spawn starts the bridge again. If this repeats, check the plugin\'s nodePath and codexPath settings (and NODE_OPTIONS), then /reload-plugins.'

/** Why the bridge stopped before it was ready: how it ended and the last lines it wrote to stderr. */
export const bridgeStopReason = (ended: string, stderrTail: readonly string[]): string => {
  const tail = stderrTail.map(line => line.trim()).filter(Boolean).slice(-6).join(' | ')
  return `the codex bridge stopped before it was ready (${ended})${tail ? `: ${clip(tail, 1200)}` : ''}. ${BRIDGE_ADVICE}`
}

/**
 * The newest numeric version of the alias's family, regardless of list order.
 * With no family listed, use the fallback id, which modelEffortError refuses.
 */
export const modelFor = (models: Map<string, string[]>, alias: string): string => {
  const family = [...models.keys()].filter(id => id.endsWith(`-${alias}`))
  const version = (id: string): number[] => id.match(/^gpt-(\d+(?:\.\d+)*)-/)?.[1]?.split('.').map(Number) ?? []
  family.sort((a, b) => {
    const av = version(a)
    const bv = version(b)
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      const difference = (bv[i] ?? 0) - (av[i] ?? 0)
      if (difference) return difference
    }
    return 0
  })
  return family[0] ?? (MODEL_ALIASES[alias] as string)
}

// ------------------------------------------------------------ text helpers

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`

export const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

export const elapsed = (from: number, to: number): string => {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`
}

export const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tok` : `${tokens} tok`

export const isLive = (agent: CodexAgent): boolean => agent.status === 'running' || agent.status === 'starting'

export const timeOf = (agent: CodexAgent, now: number): string =>
  isLive(agent) ? elapsed(agent.turnStartedAt, now) : agent.turnEndedAt ? elapsed(agent.turnStartedAt, agent.turnEndedAt) : ''

/** Splits a stream of text pieces into whole lines. */
export class LineBuffer {
  private pending = ''

  push(text: string): string[] {
    this.pending += text
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    return lines.filter(line => line.trim() !== '')
  }

  rest(): string[] {
    const rest = this.pending.trim()
    this.pending = ''
    return rest === '' ? [] : [rest]
  }
}

// ------------------------------------------------------------ registry

const MAX_DIGEST = 60
const MAX_MESSAGE = 20_000

export const sanitize = (agent: CodexAgent): CodexAgent => ({
  ...agent,
  lastMessage: clip(agent.lastMessage, MAX_MESSAGE),
  digest: agent.digest.slice(-MAX_DIGEST),
})

/** Keeps the live agents and the most recently updated, up to MAX_AGENTS. */
export const trim = (agents: Record<string, CodexAgent>): Record<string, CodexAgent> => {
  const list = Object.values(agents)
  if (list.length <= MAX_AGENTS) return agents
  const keep = list
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_AGENTS)
  return Object.fromEntries(keep.map(agent => [agent.id, agent]))
}

export const findIn = (agents: Record<string, CodexAgent>, ref: string): CodexAgent | undefined =>
  agents[ref] ?? Object.values(agents).find(agent => agent.name === ref)

export const byThread = (agents: Record<string, CodexAgent>, threadId: string): CodexAgent | undefined =>
  Object.values(agents).find(agent => agent.threadId === threadId)

export const sorted = (agents: Record<string, CodexAgent>): CodexAgent[] =>
  Object.values(agents).sort((a, b) => b.startedAt - a.startedAt)

export const uniqueName = (agents: Record<string, CodexAgent>, wanted: string): string => {
  const taken = new Set(Object.values(agents).map(agent => agent.name))
  if (!taken.has(wanted)) return wanted
  let n = 2
  while (taken.has(`${wanted} (${n})`)) n += 1
  return `${wanted} (${n})`
}

// ------------------------------------------------------------ codex params

export const sandboxMode = (sandbox: CodexSandbox): string =>
  sandbox === 'full-access' ? 'danger-full-access' : sandbox

/** Passed on every turn/start: a resumed thread otherwise falls back to read-only. */
export const sandboxPolicy = (sandbox: CodexSandbox): Record<string, unknown> => {
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false }
  if (sandbox === 'full-access') return { type: 'dangerFullAccess' }
  return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

/** ask: the person decides; auto: Codex's reviewer (--approve-for-me); never and yolo: no escalation. */
export const approvalParams = (approvals: CodexApprovals) => ({
  approvalPolicy: approvals === 'never' || approvals === 'yolo' ? 'never' : 'on-request',
  approvalsReviewer: approvals === 'auto' ? 'auto_review' : 'user',
})


export const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }]

export const threadResumeParams = (agent: CodexAgent, messaging: MessagingParams | undefined) => ({
  threadId: agent.threadId,
  model: agent.model,
  cwd: agent.cwd,
  sandbox: sandboxMode(agent.sandbox),
  ...approvalParams(agent.approvals),
  excludeTurns: true,
  ...messaging,
})

export const turnStartParams = (agent: CodexAgent, text: string) => ({
  threadId: agent.threadId,
  input: textInput(text),
  model: agent.model,
  effort: agent.effort,
  cwd: agent.cwd,
  sandboxPolicy: sandboxPolicy(agent.sandbox),
  ...approvalParams(agent.approvals),
})

/** Undefined when the pair fits; otherwise the error naming the valid choices. */
export const modelEffortError = (models: Map<string, string[]>, model: string, effort: string): string | undefined => {
  const efforts = models.get(model)
  if (!efforts) {
    const hint = Object.values(MODEL_ALIASES).includes(model) ? ` This Codex CLI lists no model of the ${aliasOf(model)} family. ${UPDATE_HINT}` : ''
    return `Unknown Codex model "${model}". Use luna, sol, astra, terra or one of: ${[...models.keys()].join(', ')}.${hint}`
  }
  if (!efforts.includes(effort)) return `Model ${model} does not take effort "${effort}". Its efforts: ${efforts.join(', ')}.`
  return undefined
}

// ------------------------------------------------------------ events

export type Item = {
  type: string
  text?: string
  phase?: string | null
  command?: string
  exitCode?: number | null
  status?: string
  changes?: { path: string; kind: unknown }[]
  server?: string
  tool?: string
  content?: { type: string; text?: string }[]
}

export const finalMessage = (items: readonly Item[]): string | null => {
  const messages = items.filter(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text !== '')
  const final = messages.filter(item => item.phase === 'final_answer').at(-1) ?? messages.at(-1)
  return final?.text ?? null
}

/** The words of a POSIX-shell-quoted command line ('…' literal, "…" and bare \ escaping); null when a quote is open. */
function shellWords(line: string): string[] | null {
  const words: string[] = []
  let word: string | null = null
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] as string
    if (c === ' ' || c === '\t' || c === '\n') {
      if (word !== null) words.push(word)
      word = null
      continue
    }
    word ??= ''
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      if (end < 0) return null
      word += line.slice(i + 1, end)
      i = end
    } else if (c === '"') {
      for (i += 1; i < line.length && line[i] !== '"'; i += 1) {
        if (line[i] === '\\' && '"\\$`\n'.includes(line[i + 1] ?? 'x')) i += 1
        word += line[i]
      }
      if (i >= line.length) return null
    } else if (c === '\\' && i + 1 < line.length) {
      i += 1
      word += line[i]
    } else word += c
  }
  if (word !== null) words.push(word)
  return words
}

const SHELL = /(?:^|[\\/])(?:ba|z)?sh$|(?:pwsh|powershell)(?:\.exe)?$/i

/**
 * The script of a command Codex reports as a shell running it, else the command:
 * Codex quotes the argv POSIX-style, `/bin/zsh -lc '<script>'` on macOS and
 * Linux, `"C:\\...\\pwsh.exe" -Command '<script>'` on Windows (pieces of the
 * script in '…' and "…" by turns).
 */
export const shortCommand = (command: string): string => {
  const words = shellWords(command)
  const flag = words?.findIndex((word, i) => i > 0 && /^-(?:l?c|command)$/i.test(word)) ?? -1
  const script = words && flag > 0 && flag === words.length - 2 && SHELL.test(words[0] as string) ? (words[flag + 1] as string) : command
  return clip(script, 160)
}

const changeKind = (kind: unknown) =>
  typeof kind === 'string' ? kind : typeof kind === 'object' && kind !== null ? String((kind as { type?: string }).type ?? 'edit') : 'edit'

export function itemStarted(item: Item): Partial<CodexAgent> | null {
  if (item.type === 'commandExecution' && item.command) return { activity: `$ ${shortCommand(item.command)}` }
  if (item.type === 'fileChange') return { activity: `editing ${(item.changes ?? []).map(one => one.path).join(', ')}` }
  if (item.type === 'reasoning') return { activity: 'thinking' }
  if (item.type === 'mcpToolCall') return { activity: `tool ${item.server}.${item.tool}` }
  if (item.type === 'webSearch') return { activity: 'searching the web' }
  return null
}

export function itemCompleted(agent: CodexAgent, item: Item): Partial<CodexAgent> {
  if (item.type === 'commandExecution' && item.command) {
    const result = item.status === 'declined' ? 'declined' : `exit ${item.exitCode ?? '?'}`
    return { activity: 'thinking', digest: [...agent.digest, `$ ${shortCommand(item.command)} -> ${result}`] }
  }
  if (item.type === 'fileChange') {
    const files = (item.changes ?? []).map(one => `${changeKind(one.kind)} ${one.path}`).join(', ')
    return { activity: 'thinking', digest: [...agent.digest, `files (${item.status ?? 'done'}): ${files}`] }
  }
  if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text !== '') {
    return {
      lastMessage: item.text,
      activity: clip(firstLine(item.text), 160),
      digest: [...agent.digest, `${item.phase === 'final_answer' ? 'answer' : 'note'}: ${clip(firstLine(item.text), 200)}`],
    }
  }
  if (item.type === 'userMessage' && agent.digest.length > 0) {
    const text = (item.content ?? []).map(part => part.text ?? '').join(' ')
    return { digest: [...agent.digest, `steer: ${clip(firstLine(text), 200)}`] }
  }
  return {}
}

/** Codex's `codexErrorInfo`: a plain string, or an object whose one key names the variant (`{ httpConnectionFailed: {...} }`). */
export const codexErrorCode = (info: unknown): string | undefined =>
  typeof info === 'string' && info !== '' ? info
    : info && typeof info === 'object' ? Object.keys(info)[0] : undefined

/** The agent after its turn ended, from turn/completed's `turn`. */
export function afterTurn(agent: CodexAgent, turn: Record<string, unknown>, now: number): Partial<CodexAgent> {
  const status = String(turn.status ?? 'completed')
  const turnError = turn.error as { message?: string; codexErrorInfo?: unknown } | null
  const error = turnError?.message ?? null
  const errorCode = codexErrorCode(turnError?.codexErrorInfo)
  const final = finalMessage((turn.items as Item[] | undefined) ?? [])
  return {
    status: status === 'completed' ? 'idle' : status === 'interrupted' ? 'interrupted' : 'failed',
    currentTurnId: null,
    lastTurnId: String(turn.id ?? agent.currentTurnId ?? ''),
    lastTurnStatus: status,
    error: error ?? (status === 'failed' ? 'the turn failed' : null),
    errorCode,
    activity: status,
    turnEndedAt: now,
    ...(final !== null ? { lastMessage: final } : {}),
  }
}

// ------------------------------------------------------------ approvals

export const ALLOW_ONCE = 'Allow once'
export const ALLOW_SESSION = 'Allow for session'
export const ALLOW_ALWAYS = 'Allow always'
export const DENY = 'Deny'

export type Verdict = { kind: 'once' | 'session' | 'always' | 'deny' } | { kind: 'other'; text: string }

export const verdictOf = (answer: string): Verdict =>
  answer === ALLOW_ONCE
    ? { kind: 'once' }
    : answer === ALLOW_SESSION
      ? { kind: 'session' }
      : answer === ALLOW_ALWAYS
        ? { kind: 'always' }
        : answer === DENY
          ? { kind: 'deny' }
          : { kind: 'other', text: answer }

/**
 * The command prefix Codex proposes to allow from now on, when it proposes one.
 * "Allow always" answers with it, and Codex itself appends a `prefix_rule` to
 * ~/.codex/rules/default.rules, so later matching commands run unasked.
 */
export const proposedRule = (method: string, params: Record<string, unknown>): string[] | null => {
  const proposed = params.proposedExecpolicyAmendment
  if (method !== 'item/commandExecution/requestApproval' || !Array.isArray(proposed) || proposed.length === 0) return null
  return proposed.map(String)
}

/** The dialog's options: "Allow always" only where Codex can persist a rule. */
export const approvalOptions = (method: string, params: Record<string, unknown>): string[] =>
  proposedRule(method, params) ? [ALLOW_ONCE, ALLOW_SESSION, ALLOW_ALWAYS, DENY] : [ALLOW_ONCE, ALLOW_SESSION, DENY]

export const grantedProfile = (requested: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null))

/** The question for a server request this plugin asks about, or null for one it declines unasked. */
export function approvalQuestion(method: string, params: Record<string, unknown>, who: string): string | null {
  if (method === 'item/commandExecution/requestApproval') {
    const command = typeof params.command === 'string' ? shortCommand(params.command) : '(command not shown)'
    return `${who} wants to run: ${command}`
  }
  if (method === 'item/fileChange/requestApproval') {
    const root = typeof params.grantRoot === 'string' ? ` (write access under ${params.grantRoot})` : ''
    return `${who} wants to change files${root}`
  }
  if (method === 'item/permissions/requestApproval') {
    const requested = (params.permissions as Record<string, unknown> | undefined) ?? {}
    return `${who} asks for extra permissions: ${clip(JSON.stringify(grantedProfile(requested)), 300)}`
  }
  return null
}

/** The JSON-RPC answer to a server request, given the person's verdict (null when not asked). */
export function approvalAnswer(
  method: string,
  params: Record<string, unknown>,
  verdict: Verdict | null,
): { result: unknown } | { error: { code: number; message: string } } {
  if (verdict && (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval')) {
    const rule = proposedRule(method, params)
    if (verdict.kind === 'always' && rule) {
      return { result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: rule } } } }
    }
    const decision =
      verdict.kind === 'once' ? 'accept' : verdict.kind === 'session' || verdict.kind === 'always' ? 'acceptForSession' : 'decline'
    return { result: { decision } }
  }
  if (verdict && method === 'item/permissions/requestApproval') {
    const isAllowed = verdict.kind === 'once' || verdict.kind === 'session' || verdict.kind === 'always'
    const requested = (params.permissions as Record<string, unknown> | undefined) ?? {}
    return { result: { permissions: isAllowed ? grantedProfile(requested) : {}, scope: verdict.kind === 'once' ? 'turn' : 'session' } }
  }
  if (method === 'mcpServer/elicitation/request') return { result: { action: 'decline', content: null, _meta: null } }
  return { error: { code: -32601, message: `${method} is not supported by the Claude Code codex plugin` } }
}

/** The digest line recording how a server request was answered. */
export function approvalDigest(method: string, params: Record<string, unknown>, verdict: Verdict | null): string {
  const what =
    method === 'item/commandExecution/requestApproval'
      ? `$ ${typeof params.command === 'string' ? shortCommand(params.command) : '?'}`
      : method === 'item/fileChange/requestApproval'
        ? 'file change'
        : method === 'item/permissions/requestApproval'
          ? 'extra permissions'
          : method
  return `approval: ${what} -> ${verdictOutcome(verdict, proposedRule(method, params))}`
}

function verdictOutcome(verdict: Verdict | null, rule: string[] | null): string {
  if (verdict === null) return 'declined (not supported here)'
  switch (verdict.kind) {
    case 'once':
      return 'approved by user (once)'
    case 'session':
      return 'approved by user (session)'
    case 'always':
      return rule ? `approved by user (always: rule ${rule.join(' ')})` : 'approved by user (session; no rule offered)'
    case 'deny':
      return 'declined by user'
    case 'other':
      return `declined by user: ${clip(firstLine(verdict.text), 120)}`
  }
}

/** The digest line for Codex's own reviewer (approvals: auto). */
export function autoReviewDigest(params: Record<string, unknown>): string {
  const review = (params.review ?? {}) as { status?: string; riskLevel?: string | null; rationale?: string | null }
  const action = (params.action ?? {}) as { type?: string; command?: string; files?: string[]; host?: string; toolName?: string }
  const what =
    action.type === 'command' && action.command
      ? `$ ${shortCommand(action.command)}`
      : action.type === 'applyPatch'
        ? `files ${(action.files ?? []).join(', ')}`
        : action.type === 'networkAccess'
          ? `network ${action.host}`
          : (action.type ?? 'action')
  const risk = review.riskLevel ? `, ${review.riskLevel} risk` : ''
  const why = review.rationale ? `: ${clip(firstLine(review.rationale), 160)}` : ''
  return `approval: ${what} -> auto-reviewer ${review.status ?? '?'}${risk}${why}`
}

// ------------------------------------------------------------ project config

/** `effort` undefined: the model's own built-in (effortFor). */
export type Defaults = { effort: string | undefined; sandbox: CodexSandbox; approvals: CodexApprovals }

export const PROJECT_CONFIG = '.claude/codex.json'

/** Parses a project's .claude/codex.json: optional defaults {effort, sandbox, approvals}. */
export function parseProjectConfig(text: string, path: string): Partial<Defaults> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new CodexError(`${path} is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CodexError(`${path} must hold a JSON object`)
  const config = parsed as Record<string, unknown>
  const out: Partial<Defaults> = {}
  for (const key of ['effort', 'sandbox', 'approvals'] as const) {
    const value = config[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value === '') throw new CodexError(`${path}: "${key}" must be a non-empty string`)
    if (key === 'sandbox' && !SANDBOXES.includes(value as CodexSandbox)) throw new CodexError(`${path}: sandbox must be one of ${SANDBOXES.join(', ')}`)
    if (key === 'approvals' && !APPROVALS.includes(value as CodexApprovals)) throw new CodexError(`${path}: approvals must be one of ${APPROVALS.join(', ')}`)
    if (key === 'sandbox') out.sandbox = value as CodexSandbox
    else if (key === 'approvals') out.approvals = value as CodexApprovals
    else out.effort = value
  }
  return out
}

/** The directories from `cwd` up to `root` (or up to / when cwd is not under root); Windows paths split at \ too and end at the drive, `X:`. */
export function configDirs(cwd: string, root: string): string[] {
  const dirs: string[] = []
  const top = root.replace(/[\\/]+$/, '') || '/'
  let dir = cwd.replace(/[\\/]+$/, '') || '/'
  for (;;) {
    dirs.push(dir)
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
    if (dir === top || dir === '/' || cut < 0) return dirs
    dir = dir.slice(0, cut) || '/'
  }
}

/** Precedence: prompt header lines > role preset > project config > userConfig > built-ins (sandbox and approvals: the manifest defaults; effort: MODEL_EFFORTS). Headers and project config can only tighten a role's preset, never widen it. */
export const effectiveDefaults = (settings: Settings, project: Partial<Defaults>): Defaults => ({
  effort: project.effort ?? settings.defaultEffort,
  sandbox: project.sandbox ?? settings.defaultSandbox,
  approvals: project.approvals ?? settings.defaultApprovals,
})

/** The effort a `codex-delegate:<alias>` spawn runs with when its prompt sets none. */
export const effortFor = (defaults: Defaults, alias: string): string => defaults.effort ?? (MODEL_EFFORTS[alias] as string)

/** Approvals from tightest to loosest: the more it prompts, the tighter. */
const APPROVALS_LOOSENESS: CodexApprovals[] = ['ask', 'auto', 'never', 'yolo']

/** The sandbox and approvals a spawn runs with; yolo forces full access. A result above the settings' ceiling, or a header looser than its role's preset, is refused, never clamped. */
export function permissionsFor(
  args: { sandbox?: string; approvals?: string },
  defaults: Defaults,
  limits: Pick<Settings, 'maxSandbox' | 'allowedApprovals'>,
  role?: Role,
): { sandbox: CodexSandbox; approvals: CodexApprovals } {
  const resolved = resolvePermissions(args, defaults)
  if (!limits.allowedApprovals.includes(resolved.approvals)) {
    throw new CodexError(`approvals ${resolved.approvals} is not allowed by the allowedApprovals setting (${limits.allowedApprovals.join(', ') || 'none'})`)
  }
  if (SANDBOXES.indexOf(resolved.sandbox) > SANDBOXES.indexOf(limits.maxSandbox)) {
    throw new CodexError(`sandbox ${resolved.sandbox} is above the maxSandbox setting (${limits.maxSandbox})`)
  }
  if (role && args.sandbox !== undefined && SANDBOXES.indexOf(args.sandbox as CodexSandbox) > SANDBOXES.indexOf(role.sandbox)) {
    throw new CodexError(`sandbox ${args.sandbox} is above the ${roleName(role)} role's preset (${role.sandbox}); a header can only tighten a role`)
  }
  if (role && args.approvals !== undefined && APPROVALS_LOOSENESS.indexOf(args.approvals as CodexApprovals) > APPROVALS_LOOSENESS.indexOf(role.approvals)) {
    throw new CodexError(`approvals ${args.approvals} is looser than the ${roleName(role)} role's preset (${role.approvals}); a header can only tighten a role`)
  }
  return resolved
}

const roleName = (role: Role): string => Object.keys(ROLES).find(name => ROLES[name] === role) as string

function resolvePermissions(args: { sandbox?: string; approvals?: string }, defaults: Defaults): { sandbox: CodexSandbox; approvals: CodexApprovals } {
  let approvals = (args.approvals ?? defaults.approvals) as CodexApprovals
  if (!APPROVALS.includes(approvals)) throw new CodexError(`approvals must be one of ${APPROVALS.join(', ')}`)
  // A project default of yolo with an explicit narrower sandbox: that sandbox, still no prompts.
  if (approvals === 'yolo' && args.approvals === undefined && args.sandbox !== undefined && args.sandbox !== 'full-access') {
    approvals = 'never'
  }
  if (approvals === 'yolo') {
    if (args.sandbox !== undefined && args.sandbox !== 'full-access') {
      throw new CodexError(`approvals yolo runs with sandbox full-access; sandbox "${args.sandbox}" contradicts it`)
    }
    return { sandbox: 'full-access', approvals }
  }
  const sandbox = (args.sandbox ?? defaults.sandbox) as CodexSandbox
  if (!SANDBOXES.includes(sandbox)) throw new CodexError(`sandbox must be one of ${SANDBOXES.join(', ')}`)
  return { sandbox, approvals }
}

// ------------------------------------------------------------ codex-msg

/** The MCP server, bin/codex-msg, through which a job messages the session; Codex starts it outside the job's sandbox. */
export const MSG_SERVER = 'claude_session'

/** What thread/start and thread/resume take so a job can message the session: the server in `config`, its use in the developer instructions. */
export const messagingParams = (node: string, root: string, socketPath: string, key: string) => ({
  config: { mcp_servers: { [MSG_SERVER]: { command: node, args: [`${root}/bin/codex-msg`, socketPath, key] } } },
  developerInstructions: [
    'You run as a background job of a Claude Code session, which gets your final message when your turn ends.',
    `To message that session while you work, call the message_claude tool of the ${MSG_SERVER} MCP server with the text.`,
    'Use it for a question you need answered, a blocker, or an important interim finding; never for progress updates, and never for your final result.',
    'A reply, when the session sends one, arrives as a new user message in your turn; keep working on what you can while you wait for it.',
  ].join('\n'),
})

export type MessagingParams = ReturnType<typeof messagingParams>

// ------------------------------------------------------------ native agent types

/**
 * Each model alias is a native agent type, `codex-delegate:<alias>`. Its subagent is a
 * wrapper: the plugin starts the Codex turn with the spawn's own prompt, and
 * answers every model request of the wrapper's loop itself (turn.step), so no
 * Claude model reads or rewrites the task or the result.
 */
export const AGENT_PREFIX = 'codex-delegate:'
export const AWAIT_TOOL = `${PREFIX}codex_await`
/** The wrapper's Claude model: named because the definition needs one, and never called. */
export const WRAPPER_MODEL = 'haiku'
/** How a background subagent hands its report back where the engine requires it (auto mode); elsewhere its final text is the report. */
export const HANDBACK_TOOL = 'SubagentHandback'

type AgentSpec = Parameters<EngineInterface['agent']['register']>[0]

/** The role a `codex-delegate:<role>` agent type names, or undefined. */
export const roleOfType = (subagentType: string): Role | undefined => {
  const name = subagentType.startsWith(AGENT_PREFIX) ? subagentType.slice(AGENT_PREFIX.length) : ''
  return Object.hasOwn(ROLES, name) ? ROLES[name] : undefined
}

/** The model alias a `codex-delegate:<alias|role>` agent type runs (a role's preset model), or undefined for any other type. */
export const aliasOfType = (subagentType: string): string | undefined => {
  if (!subagentType.startsWith(AGENT_PREFIX)) return undefined
  const alias = subagentType.slice(AGENT_PREFIX.length)
  return Object.hasOwn(MODEL_ALIASES, alias) ? alias : roleOfType(subagentType)?.model
}

/** The defaults a role's preset lays over the effective ones; other types keep them. */
export const roleDefaults = (defaults: Defaults, role: Role | undefined): Defaults =>
  role ? { ...defaults, sandbox: role.sandbox, approvals: role.approvals } : defaults

/** The fixed field labels of a job's `## Result`. */
export const RESULT_FIELDS = ['Status', 'Files changed', 'Commands run', 'Open questions'] as const

/** `.handoff/<job>.md` under the job's cwd: the brief Claude writes, and where the job writes its `## Result`. */
export const handoffPath = (cwd: string, job: string, brief?: string): string => `${cwd.replace(/\/$/, '')}/${brief ?? `.handoff/${job}.md`}`

/** The text prepended to a role job's prompt (not to a raw model type's). */
export const rolePreamble = (role: Role, path: string): string => [
  'Working rules for this job:',
  '- Stay inside this worktree; touch nothing outside it.',
  '- Never push, and never open or merge a pull request.',
  '- Do not commit; leave all changes uncommitted (the spawner reviews and commits them).',
  `- If ${path} exists, read it first: it is the brief (goal, scope, constraints, acceptance, out of scope).`,
  `- Finish by writing a "## Result" section${role.sandbox === 'read-only' ? ' in your final message' : ` in ${path} (and your final message)`} as the last section, headed exactly "## Result", with one field line each: ${RESULT_FIELDS.map(f => `"- ${f}:"`).join(', ')} (put the tail of each command's output under Commands run). Mentioning a field in prose elsewhere does not count.`,
  `- Keep the final message to a short summary plus the path ${path}.`,
  '',
  '',
].join('\n')

/** The final message cut to its head, with the line that says where the whole text is. */
export const spillHead = (text: string, path: string): string =>
  `${text.slice(0, SPILL_HEAD)}\n\n[Message of ${text.length} chars cut here; full text: ${path}]`
export const SPILL_HEAD = 1500

/** The body of the last `## Result` heading up to the next heading of level 1-2, or null without one. */
const resultSection = (text: string): string | null => {
  const heads = [...text.matchAll(/^##[ \t]+Result[ \t]*$/gim)]
  const head = heads[heads.length - 1]
  if (!head) return null
  const body = text.slice(head.index + head[0].length)
  const next = body.search(/^#{1,2}[ \t]/m)
  return next < 0 ? body : body.slice(0, next)
}

/** True when the section has a field line for the label: `Label:`, `**Label:**`, `- Label:` or a `### Label` heading. */
const hasField = (section: string, label: string): boolean =>
  new RegExp(`^[ \\t]*(?:(?:[-*][ \\t]+)?(?:\\*\\*)?${label}(?::\\*\\*|\\*\\*:|:)|#{3,6}[ \\t]+${label}[ \\t]*:?[ \\t]*$)`, 'im').test(section)

/** A one-line warning for a role job's final message with no `## Result` section, or one lacking field lines; '' when complete. */
export function resultWarning(text: string): string {
  const section = resultSection(text)
  if (section === null) return '\n\nWarning: the final message has no "## Result" section.'
  const missing = RESULT_FIELDS.filter(label => !hasField(section, label))
  return missing.length === 0 ? '' : `\n\nWarning: the result lacks the required field${missing.length === 1 ? '' : 's'} ${missing.join(', ')}.`
}

/**
 * Warnings for commits made since a job spawned (HEAD moved): `mayCommit` false means the role may not
 * commit; undefined (a raw model type) skips that check. A Co-Authored-By trailer is flagged by short sha.
 */
export function auditWarnings(mayCommit: boolean | undefined, commits: readonly { sha: string; message: string }[]): string {
  if (commits.length === 0) return ''
  let out = ''
  if (mayCommit === false) out += `\n\nWarning: this role may not commit, but HEAD moved (${commits.length} new commit${commits.length === 1 ? '' : 's'}).`
  const trailers = commits.filter(c => /^co-authored-by:/im.test(c.message)).map(c => c.sha.slice(0, 7))
  if (trailers.length) out += `\n\nWarning: commit${trailers.length === 1 ? '' : 's'} ${trailers.join(', ')} ${trailers.length === 1 ? 'has' : 'have'} a Co-Authored-By trailer.`
  return out
}

/** When to pick each type: the main model reads this first in the agent listing. */
const WHEN_TO_USE: Record<string, string> = {
  sol: 'Default Codex agent for normal tasks: implementation, debugging, analysis, review, anything needing judgement.',
  luna: 'For simple mechanical work and searches: find/grep/list, bulk renames, boilerplate, straightforward well-specified edits, data gathering. Cheap and fast; not for tasks needing judgement (use codex-delegate:sol).',
  astra: 'Use ONLY when the user explicitly asks for astra; otherwise use codex-delegate:sol.',
  terra: 'Use ONLY when the user explicitly asks for terra; otherwise use codex-delegate:sol.',
}

const effortsOf = (alias: string): string => (alias === 'luna' ? 'low|medium|high|xhigh|max' : 'low|medium|high|xhigh|max|ultra')

/** The listing line the main model reads for `codex-delegate:<alias>`; `defaults` are the effective ones at session start. */
export function agentDescription(name: string, defaults: Defaults): string {
  const alias = ROLES[name]?.model ?? name
  const family = alias.charAt(0).toUpperCase() + alias.slice(1)
  return [
    `${ROLES[name]?.whenToUse ?? WHEN_TO_USE[name]} OpenAI Codex on the newest ${family} model, effort ${effortFor(defaults, alias)}.`,
    'Runs in the background and sees only your prompt.',
    `Optional header lines first: effort: ${effortsOf(alias)}; sandbox: read-only|workspace-write|full-access (default ${defaults.sandbox}); approvals: auto|ask|never|yolo (default ${defaults.approvals}; yolo only if the user asked); cwd: <path>; brief: <path>.`,
    'SendMessage steers it, TaskStop stops it. Details: the delegate-to-codex skill.',
  ].join(' ')
}

/** What the wrapper's model would follow if it ever ran (only when the plugin's turn.step hook failed). */
export const WRAPPER_PROMPT = [
  'You relay one OpenAI Codex job that the codex plugin has already started with your task.',
  `Call the ${AWAIT_TOOL} tool with no arguments: it blocks until the Codex turn ends. While it says the job is still running, call it again.`,
  'When it returns a message from Codex for the main session, send exactly that text with SendMessage to "main", then call it again.',
  `When it returns the result, deliver exactly that text, nothing added, removed or reworded: with ${HANDBACK_TOOL} when you have that tool, else as your reply.`,
  'Never do the task yourself and never call any other tool.',
  'If codex_await fails, report its error and stop. Never retry a missing job or diagnose the tool yourself.',
].join(' ')

export const agentSpecs = (defaults: Defaults): AgentSpec[] =>
  [...Object.keys(MODEL_ALIASES), ...Object.keys(ROLES)].map(name => ({
    name,
    description: agentDescription(name, roleDefaults(defaults, ROLES[name])),
    prompt: WRAPPER_PROMPT,
    tools: [AWAIT_TOOL, 'SendMessage', HANDBACK_TOOL],
    model: WRAPPER_MODEL,
    background: true,
    omitClaudeMd: true,
  }))

const HEADER_KEYS = ['effort', 'sandbox', 'approvals', 'brief', 'cwd'] as const
type HeaderKey = (typeof HEADER_KEYS)[number]
export type PromptHeader = Partial<Record<HeaderKey, string>> & { body: string }

const HEADER_LINE = /^[ \t]*(effort|sandbox|approvals|brief|cwd)[ \t]*:[ \t]*(.*?)[ \t]*$/i

/** Reads the `effort:`, `sandbox:`, `approvals:`, `brief:` and `cwd:` lines at the top of a prompt (`brief:` is a path relative to the job's cwd, kept as given; `cwd:` is a path, double quotes optional, kept as given); `body` is the rest, as given. */
export function parseHeader(prompt: string): PromptHeader {
  const lines = prompt.split('\n')
  const header: PromptHeader = { body: prompt }
  let count = 0
  for (const line of lines) {
    const match = HEADER_LINE.exec(line)
    if (!match) break
    const key = (match[1] as string).toLowerCase() as HeaderKey
    let value = match[2] as string
    // Only cwd takes a quoted value with spaces; any other key needs one bare word, else the line is the body.
    if (key !== 'cwd' && !/^\S+$/.test(value)) break
    if (header[key] !== undefined) throw new CodexError(`the prompt's header sets ${key} twice`)
    if (key === 'cwd') {
      const quoted = /^"([^"]*)"$/.exec(value)
      if (!quoted && /\s/.test(value)) throw new CodexError(`the prompt's cwd: has spaces; wrap the path in double quotes; got ${value}`)
      value = quoted ? (quoted[1] as string) : value
      if (value.trim() === '') throw new CodexError("the prompt's cwd: is empty")
      header.cwd = value
      count += 1
      continue
    }
    if (key === 'brief' && (value.startsWith('/') || value.split(/[\\/]/).includes('..'))) {
      throw new CodexError(`the prompt's brief: must be a path relative to the job's cwd, without ..; got ${value}`)
    }
    header[key] = key === 'brief' ? value : value.toLowerCase()
    count += 1
  }
  if (count > 0) header.body = lines.slice(count).join('\n').replace(/^(?:[ \t]*\n)+/, '')
  return header
}

/** The wrapper's final answer once the Codex turn ended: on success the Codex final message, verbatim. */
export function wrapperAnswer(agent: CodexAgent): string {
  const code = agent.errorCode ? ` (${agent.errorCode})` : ''
  if (agent.status === 'failed') return `Codex failed${code}: ${agent.error ?? 'the turn failed'}`
  if (agent.status === 'interrupted') return agent.error ? `Codex turn interrupted${code}: ${agent.error}` : 'Codex turn interrupted.'
  return agent.lastMessage || '(Codex finished without a final message.)'
}

// ------------------------------------------------------------ texts

export function describeAgent(agent: CodexAgent, now: number): string {
  const time = timeOf(agent, now)
  // Finish age omits seconds once at least a minute elapsed; runtime keeps them.
  const timing = isLive(agent) ? (time ? ` ${time}` : '') : time ? `, ran ${time}, finished ${elapsed(agent.turnEndedAt, now).replace(/m \d+s$/, 'm')} ago` : ''
  const doing = isLive(agent) ? agent.activity : (agent.lastTurnStatus ?? agent.status)
  return `${agent.id} ${agent.name} [${agent.model}/${agent.effort}, ${agent.sandbox}, approvals ${agent.approvals}] ${agent.status}${timing}, ${formatTokens(agent.tokens)}: ${clip(firstLine(doing), 100)}${agent.warning ? ` (warning: ${clip(firstLine(agent.warning), 120)})` : ''}`
}

const RECENT_FINISHED_MS = 30 * 60_000

/** codex_list: active and recently finished session jobs, or all with `all`, newest first (`agents` sorted so). */
export function listText(agents: readonly CodexAgent[], sessionId: string, now: number, all = false): string {
  const mine = agents.filter(agent => agent.sessionId === sessionId)
  if (mine.length === 0) return 'No Codex agents in this session. The Agent tool starts one with subagent_type codex-delegate:implementer, reviewer, runner or rescuer, or codex-delegate:luna, sol, astra or terra.'
  const shown = all ? mine : mine.filter(agent => isLive(agent) || agent.turnEndedAt >= now - RECENT_FINISHED_MS)
  const hidden = mine.length - shown.length
  const notice = `${hidden} older finished jobs hidden; codex_list with all: true lists them. codex_result and SendMessage still reach any of them.`
  if (shown.length === 0) return `No active or recently finished Codex jobs in this session; ${notice}`
  return [...shown.map(agent => describeAgent(agent, now)), ...(hidden > 0 ? [notice] : [])].join('\n')
}

export function resultText(agent: CodexAgent, full: boolean, now: number): string {
  const lines = [describeAgent(agent, now)]
  if (agent.error) lines.push(`Error${agent.errorCode ? ` (${agent.errorCode})` : ''}: ${agent.error}`)
  if (full && agent.digest.length > 0) lines.push('Turn digest:', ...agent.digest.map(line => `  ${line}`))
  lines.push(agent.lastMessage ? `Final message:\n${agent.lastMessage}` : 'No final message yet.')
  return lines.join('\n')
}

// ------------------------------------------------------------ transcript rows

export type ToolName = 'codex_list' | 'codex_result' | 'codex_await'

/** The short task label: the spawn's `description`, else its prompt's first line. */
export const taskLabel = (input: { description?: string; prompt?: string }): string =>
  firstLine(input.description ?? '') || clip(firstLine(input.prompt ?? ''), 80)

/** A tool's result as text: a plugin tool's is a string, or text blocks. */
export function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map(part => (part as { text?: unknown }).text).filter(text => typeof text === 'string').join('\n')
  if (typeof output === 'object' && output !== null && typeof (output as { text?: unknown }).text === 'string') return (output as { text: string }).text
  return ''
}

/** What goes in a row's parentheses: the verb and the agent addressed. */
export function rowArgs(tool: ToolName, input: Record<string, unknown>): string {
  const verb = tool.slice('codex_'.length)
  return typeof input.id === 'string' && input.id.trim() ? `${verb} ${input.id.trim()}` : verb
}

export const STILL_RUNNING = 'Codex is still running'

/** The row's result line once the call succeeded, read from the model's text: main text and a dim tail. */
export function rowResult(tool: ToolName, text: string): { main: string; dim: string } {
  switch (tool) {
    case 'codex_list': {
      const lines = text.split('\n').filter(line => / \[[^\]]*\] \w+/.test(line))
      if (lines.length === 0) return { main: 'No agents', dim: '' }
      const running = lines.filter(line => /\] (running|starting)\b/.test(line)).length
      return { main: `${lines.length} agent${lines.length === 1 ? '' : 's'} · ${running} running`, dim: '' }
    }
    case 'codex_result': {
      const status = /\] (\w+)/.exec(text)?.[1] ?? 'done'
      const final = /^Final message:\n(.*)$/m.exec(text)?.[1]
      return { main: status === 'idle' ? 'done' : status, dim: final ? ` · ${firstLine(final)}` : '' }
    }
    case 'codex_await':
      return text.startsWith(STILL_RUNNING) ? { main: 'still running', dim: '' } : { main: 'done', dim: ` · ${firstLine(text)}` }
  }
}

/** The footer text while agents run, beside the prompt's hint line; undefined when none run. */
export function runningTail(agents: CodexAgent[]): string | undefined {
  const live = agents.filter(isLive)
  if (live.length === 0) return undefined
  if (live.length > 3) return `${live.length} codex agents running`
  return `codex: ${live.map(agent => `${agent.name} (${aliasOf(agent.model)})`).join(' · ')}`
}

// ------------------------------------------------------------ tool specs

const ID_PARAM = { type: 'string', description: "The agent id (the codex:* agent's agentId) or its name, as codex_list shows them." }

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'codex_list',
    description: "List this session's active Codex jobs (codex:* agents) and jobs finished within the last 30 minutes, newest first: model, status and what each is doing. With all=true, list the full history, including restored, interrupted and missing jobs. codex_result and SendMessage still reach hidden jobs.",
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'List the full session history, including older finished jobs (default false).' } } },
  },
  {
    name: 'codex_result',
    description:
      "Read a Codex job's result: its status and the final message of the last turn. With full=true also a digest of the turn: commands with exit codes, file changes and messages.",
    inputSchema: {
      type: 'object',
      properties: { id: ID_PARAM, full: { type: 'boolean', description: 'Include the turn digest.' } },
      required: ['id'],
    },
  },
  {
    name: 'codex_await',
    description: "Internal to codex:* agents, which call it themselves: blocks until the agent's Codex turn ends. Never call it.",
    inputSchema: { type: 'object', properties: {} },
  },
]

/** The label of the wrapper's own SendMessage row (not sent: the message is). */
export const messageSummary = (text: string): string => `Codex: ${clip(firstLine(text), 60)}`
