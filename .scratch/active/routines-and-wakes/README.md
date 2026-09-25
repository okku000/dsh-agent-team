# Routines and producer-triggered wakes

Status: open — both sides implemented in this package; probe verification pending.
Last checked: 2026-09-25.

## Current frontier

Both halves live in this repository now. The Host side is `wakeMember`
(`packages/agent-team/src/member-wake.ts`, the service method in `src/index.ts`, and
`tests/member-wake.spec.ts`): one producer-triggered turn in a named Member's own Session, on the same
idle/busy lanes DM relay uses, with refusals carried as reasons.

The producer is the Team's own row, `wowyuarm-agent-team-routines` (`src/routine-schedule.ts`,
`src/routines.ts`, `cordis.patch.yml`, exported as `@wowyuarm/dsh-agent-team/routines`):
`config.routines` declares one trigger per routine — `everySeconds` aligned to `anchorAt`, or a single
RFC 3339 `at` — plus a target Member by handle or branded id and the instruction; the row fires it through
`wakeMember`, frames it as an unattended `[ROUTINE FIRE]`, and appends every outcome to
`$DSH_HOME/agent-team/routines/fires.jsonl`. The row ships unconfigured, so an operator supplies a
schedule by patching its id in their profile.

Pending: the probe run named in the completion conditions, and retiring the now-redundant `routines/`
plugin from the separate `ifpf-harness` repository. The operator rejected that standalone producer
precisely because the producer belongs in this package.

## Completion conditions

- A routine can be configured in a profile, fires at its scheduled instant, and the named Member starts a
  turn that carries the routine's instruction and a one-line account of why it arrived.
- Every refusal path reaches the producer's fire log with its reason kept apart: unknown Member, Member not
  enabled, no live session, failed injection.
- One verification run on a probe host records a real fire and the Member turn it started.

## Formal-doc exit

Done: the wake contract, the built-in producer, its configuration, and the fire log are recorded in
`docs/team-collaboration/attention-and-messaging.md` ("Producer-injected wakes"), and the package README
pair documents the row ("Routines"). Archive this item once the probe run has recorded a real fire and the
Member turn it started.
