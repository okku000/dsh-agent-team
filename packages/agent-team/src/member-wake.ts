/**
 * Host-side Member wake: one producer-triggered turn in a Member's own Session.
 *
 * A wake is not a new agent. The Member keeps its durable Session, its private
 * memory, its Claims and its Thread attention; the producer supplies only the
 * instruction and the one-line account of why it arrived. Routines are the first
 * caller — a schedule that fires an instruction into one named Member — but a
 * watcher or another Host plugin uses the same path, so this contract lives
 * beside the service rather than inside one caller: the refusal paths and the
 * injected message shape are what a producer records its failures against.
 *
 * Why refusals are reasons rather than messages a caller parses: a routine fires
 * unattended, at a time nobody is watching. "No such Member", "Member is not
 * enabled", "no live session" and a failed injection are four different
 * operational answers — a typo in a schedule, an intentional state, a Member
 * that was never activated, a broken Session — and the producer's fire log has
 * to keep them apart long afterwards.
 *
 * The producer owns its message `kind`: every producer declares its own kind in
 * its own module, so the kind arrives here as an opaque plugin id and the source
 * is asserted rather than enumerated. The Host cannot know the plugins that will
 * call it.
 *
 * @module @wowyuarm/dsh-agent-team/member-wake
 */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentTeamAgentMember, AgentTeamMemberId } from './types.ts'

/** Delivery lane: an idle Member gets a turn, a busy one is steered into it. */
export type AgentTeamWakeMode = 'followup' | 'steer'

/** Why a wake was refused; the producer records this instead of a bare message. */
export type AgentTeamWakeRefusalReason = 'unknown-member' | 'member-not-enabled' | 'no-live-session' | 'wake-failed'

/** One producer-triggered wake: who to wake, what to say, and why it arrived. */
export interface AgentTeamWakeRequest {
  /** Exact target Member; takes precedence over `handle` when both are given. */
  readonly memberId?: AgentTeamMemberId
  /** Display handle, with or without a leading `@`, matched case-insensitively. */
  readonly handle?: string
  /** The producer-side trigger's name, e.g. a routine name. */
  readonly routine: string
  /** Producer plugin id; becomes the injected message's source `kind`. */
  readonly plugin: string
  /** One-line account shown in the Member's context; defaults to the routine. */
  readonly summary?: string
  /** The instruction injected into the Member's Session. */
  readonly body: string
}

/** What a delivered wake did, for the producer's log. */
export interface AgentTeamWakeResult {
  readonly delivered: true
  readonly mode: AgentTeamWakeMode
  readonly memberId: AgentTeamMemberId
  readonly memberHandle: string
  readonly sessionId: AgentTeamAgentMember['sessionId']
  readonly routine: string
  /** The bound summary actually injected, so the log and the context agree. */
  readonly summary: string
}

/**
 * A wake that did not land, with the operational reason kept apart from the
 * message. The caller decides what a refusal means: an unknown Member is a
 * schedule typo, while a missing live session may simply be a Member that has
 * not been activated in this Host yet.
 */
export class AgentTeamWakeDeliveryError extends Error {
  constructor(
    readonly reason: AgentTeamWakeRefusalReason,
    readonly memberId: AgentTeamMemberId | undefined,
    readonly memberHandle: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'AgentTeamWakeDeliveryError'
  }
}

/** One handle, normalized the way Member handles compare: no `@`, case folded. */
export function normalizeWakeHandle(handle: string): string {
  return handle.replace(/^@/, '').trim().toLowerCase()
}

/**
 * Resolve the target Member from the durable roster.
 * @param members - every durable Member, whatever its lifecycle state.
 * @param request - the wake's target: an exact id, or a display handle.
 * @returns the target Member.
 * @throws AgentTeamWakeDeliveryError with reason `unknown-member`.
 */
export function resolveWakeMember(members: readonly AgentTeamAgentMember[], request: AgentTeamWakeRequest): AgentTeamAgentMember {
  if (request.memberId !== undefined) {
    const member = members.find(candidate => candidate.memberId === request.memberId)
    if (member === undefined) {
      throw new AgentTeamWakeDeliveryError('unknown-member', request.memberId, undefined, `no Team Member has id '${request.memberId}'`)
    }
    return member
  }
  const wanted = request.handle === undefined ? undefined : normalizeWakeHandle(request.handle)
  const member = wanted === undefined || wanted === '' ? undefined : members.find(candidate => normalizeWakeHandle(candidate.handle) === wanted)
  if (member === undefined) {
    throw new AgentTeamWakeDeliveryError('unknown-member', undefined, request.handle, `no Team Member has handle '${request.handle ?? ''}'`)
  }
  return member
}

/** The lane a Member's current status deserves, matching DM relay and continuations. */
export function wakeModeFor(status: AgentHandle['agent']['status']): AgentTeamWakeMode {
  return status === 'idle' ? 'followup' : 'steer'
}

/**
 * Build the injected notice for one wake.
 *
 * The summary is bounded by the Harness bound rather than by a second copy of
 * it here: a `notice`'s one-line account goes into the durable log, and a
 * producer's routine name has no length of its own. The bound value is returned
 * so the producer's log records exactly what the Member sees.
 * @param request - the wake being delivered.
 * @returns the message to inject and the bound summary it carries.
 */
export function wakeNotice(request: AgentTeamWakeRequest): { readonly message: UserMessage; readonly summary: string } {
  const summary = boundContextSummary(request.summary ?? `Routine fired: ${request.routine}`)
  // The producer declares its own source kind (see the module comment); the
  // Host passes it through rather than mapping it onto a kind of its own.
  const source = { kind: request.plugin, form: 'notice', summary } as unknown as UserMessage['source']
  return { message: createUserMessage({ content: [{ type: 'text', text: request.body }], source }), summary }
}

/**
 * Deliver one resolved wake into a live Member session.
 *
 * Refusing a Member that is not `enabled` and reporting an injection failure as
 * `wake-failed` happen here, so both are covered without a Host: the caller only
 * has to find the live handle.
 * @param member - the resolved target Member.
 * @param handle - that Member's live handle in this Host.
 * @param request - the wake being delivered.
 * @returns what the wake did, including the lane and the injected summary.
 * @throws AgentTeamWakeDeliveryError with reasons `member-not-enabled` or `wake-failed`.
 */
export function deliverWake(member: AgentTeamAgentMember, handle: AgentHandle, request: AgentTeamWakeRequest): AgentTeamWakeResult {
  if (member.state !== 'enabled') {
    throw new AgentTeamWakeDeliveryError('member-not-enabled', member.memberId, member.handle, `Agent Member '${member.handle}' is ${member.state}; only an enabled Member can be woken`)
  }
  const { message, summary } = wakeNotice(request)
  const mode = wakeModeFor(handle.agent.status)
  try {
    if (mode === 'followup') handle.agent.followup(message)
    else handle.agent.steer(message)
  } catch (error) {
    throw new AgentTeamWakeDeliveryError('wake-failed', member.memberId, member.handle, `Agent Member '${member.handle}' could not be woken: ${error instanceof Error ? error.message : String(error)}`)
  }
  return Object.freeze({
    delivered: true,
    mode,
    memberId: member.memberId,
    memberHandle: member.handle,
    sessionId: member.sessionId,
    routine: request.routine,
    summary,
  })
}
