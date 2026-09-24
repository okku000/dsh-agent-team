import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { CONTEXT_SUMMARY_MAX_CHARS } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import AgentTeam, { AgentTeamWakeDeliveryError, type AgentTeamWakeRequest, type Config } from '../src/index.ts'
import { deliverWake, normalizeWakeHandle, resolveWakeMember, wakeModeFor } from '../src/member-wake.ts'
import type { AgentTeamAgentMember, AgentTeamMemberId } from '../src/types.ts'

const MEMBER_ID = 'member:wakee' as AgentTeamMemberId
const OTHER_ID = 'member:other' as AgentTeamMemberId

function member(overrides: Partial<AgentTeamAgentMember> = {}): AgentTeamAgentMember {
  return {
    memberId: MEMBER_ID,
    sessionId: SessionId('session:wakee'),
    workspaceId: WorkspaceId('workspace:alpha'),
    handle: 'wakee@harness',
    description: '',
    presetId: 'team-member',
    privateMemoryPath: '/tmp/wakee',
    state: 'enabled',
    ...overrides,
  }
}

/** One live handle whose Agent records what a wake did to it. */
function liveHandle(status: 'idle' | 'running', fail = false) {
  const calls: Array<['followup' | 'steer', unknown]> = []
  const handle = {
    agent: {
      status,
      followup(message: unknown) { if (fail) throw new Error('session is gone'); calls.push(['followup', message]) },
      steer(message: unknown) { if (fail) throw new Error('session is gone'); calls.push(['steer', message]) },
    },
  } as unknown as AgentHandle
  return { handle, calls }
}

const request: AgentTeamWakeRequest = {
  memberId: MEMBER_ID,
  routine: 'model-bump-check',
  plugin: 'ifpf-routines',
  summary: 'Routine fired: model-bump-check',
  body: '[ROUTINE FIRE] model-bump-check\ncheck the model catalog',
}

/** The same wake aimed by handle: the target key differs, nothing else does. */
const byHandle = (handle: string): AgentTeamWakeRequest => ({
  handle,
  routine: request.routine,
  plugin: request.plugin,
  summary: 'Routine fired: model-bump-check',
  body: request.body,
})

describe('wake target resolution', () => {
  it('normalizes a handle the way Member handles compare', () => {
    expect(normalizeWakeHandle('@Wakee@HARNESS')).toBe('wakee@harness')
    expect(normalizeWakeHandle('  wakee@harness  ')).toBe('wakee@harness')
  })

  it('resolves an exact Member id, and a handle with or without the @', () => {
    const members = [member(), member({ memberId: OTHER_ID, handle: 'other@harness' })]
    expect(resolveWakeMember(members, request).memberId).toBe(MEMBER_ID)
    expect(resolveWakeMember(members, byHandle('wakee@harness')).memberId).toBe(MEMBER_ID)
    expect(resolveWakeMember(members, byHandle('@WAKEe@harness')).memberId).toBe(MEMBER_ID)
  })

  it('refuses an unknown id and an unknown handle as unknown-member', () => {
    const members = [member()]
    expect(() => resolveWakeMember(members, { ...request, memberId: OTHER_ID })).toThrow(AgentTeamWakeDeliveryError)
    expect(() => resolveWakeMember(members, { ...request, memberId: OTHER_ID })).toThrow(/no Team Member has id/)
    expect(() => resolveWakeMember(members, byHandle('nobody'))).toThrow(/no Team Member has handle/)
    try {
      resolveWakeMember(members, byHandle('nobody'))
    } catch (error) {
      expect((error as AgentTeamWakeDeliveryError).reason).toBe('unknown-member')
      expect((error as AgentTeamWakeDeliveryError).memberHandle).toBe('nobody')
    }
  })
})

describe('wake delivery', () => {
  it('gives an idle Member one ordinary turn and steers a busy one', () => {
    expect(wakeModeFor('idle')).toBe('followup')
    expect(wakeModeFor('running')).toBe('steer')

    const idle = liveHandle('idle')
    expect(deliverWake(member(), idle.handle, request).mode).toBe('followup')
    expect(idle.calls[0]![0]).toBe('followup')

    const busy = liveHandle('running')
    expect(deliverWake(member(), busy.handle, request).mode).toBe('steer')
    expect(busy.calls[0]![0]).toBe('steer')
  })

  it('reports what the producer logs: target, Session, routine and the bound summary', () => {
    const { handle } = liveHandle('idle')
    const result = deliverWake(member(), handle, request)
    expect(result).toEqual({
      delivered: true,
      mode: 'followup',
      memberId: MEMBER_ID,
      memberHandle: 'wakee@harness',
      sessionId: 'session:wakee',
      routine: 'model-bump-check',
      summary: 'Routine fired: model-bump-check',
    })
  })

  it('injects the producer instruction under the producer own source kind', () => {
    const { handle, calls } = liveHandle('idle')
    deliverWake(member(), handle, request)
    const message = calls[0]![1] as { role: string; source: Record<string, unknown>; content: readonly { type: string; text: string }[] }
    expect(message.role).toBe('user')
    // The producer declares its own kind; the Host passes it through unchanged.
    expect(message.source).toEqual({ kind: 'ifpf-routines', form: 'notice', summary: 'Routine fired: model-bump-check' })
    expect(message.content).toEqual([{ type: 'text', text: request.body }])
  })

  it('falls back to the routine name, and bounds any summary the Harness would reject', () => {
    const { handle, calls } = liveHandle('idle')
    const fallback = deliverWake(member(), handle, { memberId: MEMBER_ID, routine: request.routine, plugin: request.plugin, body: request.body })
    expect(fallback.summary).toBe('Routine fired: model-bump-check')

    const long = deliverWake(member(), handle, { ...request, summary: 'x'.repeat(500) })
    expect(long.summary.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS)
    const last = calls.at(-1)![1] as { source: { summary: string } }
    expect(last.source.summary).toBe(long.summary)
  })

  it('refuses a Member that is not enabled, without touching its Agent', () => {
    const suspended = liveHandle('idle')
    for (const state of ['suspended', 'archived', 'inactive'] as const) {
      try {
        deliverWake(member({ state }), suspended.handle, request)
        throw new Error('expected a refusal')
      } catch (error) {
        expect(error).toBeInstanceOf(AgentTeamWakeDeliveryError)
        expect((error as AgentTeamWakeDeliveryError).reason).toBe('member-not-enabled')
        expect((error as AgentTeamWakeDeliveryError).memberHandle).toBe('wakee@harness')
      }
    }
    expect(suspended.calls).toEqual([])
  })

  it('reports a failed injection as wake-failed, keeping the Session error', () => {
    const broken = liveHandle('idle', true)
    try {
      deliverWake(member(), broken.handle, request)
      throw new Error('expected a refusal')
    } catch (error) {
      expect((error as AgentTeamWakeDeliveryError).reason).toBe('wake-failed')
      expect((error as AgentTeamWakeDeliveryError).message).toMatch(/session is gone/)
    }
  })
})

describe('AgentTeam.wakeMember', () => {
  /** The service's collaborators, fenced behind one cast: this contract is about delivery, not boot. */
  interface WakeHarness {
    accepting: boolean
    domain: unknown
    ledger: { getMember(id: AgentTeamMemberId): AgentTeamAgentMember | undefined; listMembers(): readonly AgentTeamAgentMember[] }
    handles: Map<AgentTeamMemberId, AgentHandle>
  }

  function harness(members: readonly AgentTeamAgentMember[], live: Map<AgentTeamMemberId, AgentHandle> = new Map()) {
    const ctx = new Context()
    const team = new AgentTeam(ctx, {} as Config)
    const internals = team as unknown as WakeHarness
    internals.domain = {}
    internals.ledger = {
      getMember: id => members.find(candidate => candidate.memberId === id),
      listMembers: () => members,
    }
    internals.handles = live
    return team
  }

  it('wakes an enabled Member that has a live session', () => {
    const { handle, calls } = liveHandle('idle')
    const team = harness([member()], new Map([[MEMBER_ID, handle]]))
    expect(team.wakeMember(request).memberHandle).toBe('wakee@harness')
    expect(calls).toHaveLength(1)
  })

  it('refuses an enabled Member with no live session, naming the Member', () => {
    const team = harness([member()])
    try {
      team.wakeMember(request)
      throw new Error('expected a refusal')
    } catch (error) {
      expect((error as AgentTeamWakeDeliveryError).reason).toBe('no-live-session')
      expect((error as AgentTeamWakeDeliveryError).memberId).toBe(MEMBER_ID)
    }
  })

  it('refuses every wake while the service is shutting down', () => {
    const { handle } = liveHandle('idle')
    const team = harness([member()], new Map([[MEMBER_ID, handle]]))
    ;(team as unknown as WakeHarness).accepting = false
    expect(() => team.wakeMember(request)).toThrow(/shutting down/)
  })

  it('resolves a handle from the durable roster rather than from live handles', () => {
    const { handle, calls } = liveHandle('idle')
    const team = harness([member(), member({ memberId: OTHER_ID, handle: 'other@harness' })], new Map([[OTHER_ID, handle]]))
    const result = team.wakeMember(byHandle('@other@harness'))
    expect(result.memberId).toBe(OTHER_ID)
    expect(calls).toHaveLength(1)
  })
})
