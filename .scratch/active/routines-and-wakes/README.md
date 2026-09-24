# Routines and producer-triggered wakes

Status: open — Host side implemented, producer side not yet wired.
Last checked: 2026-09-25.

## Current frontier

The Host side landed with `wakeMember` (`packages/agent-team/src/member-wake.ts`, the service method in
`src/index.ts`, and `tests/member-wake.spec.ts`): one producer-triggered turn in a named Member's own
Session, on the same idle/busy lanes DM relay uses, with refusals carried as reasons.

Not done: the producer. `ifpf-routines` (a Host plugin that fires a scheduled instruction into one named
Member) lives in the separate `ifpf-harness` repository, was deleted there on 2026-09-25 when this
repository became the owner of the wake, and is recoverable from that repository's history
(`487b86c:routines/`). Until it is restored and installed, nothing calls `wakeMember` in production, and
no profile has been verified end to end.

## Completion conditions

- A routine can be configured in a profile, fires at its scheduled instant, and the named Member starts a
  turn that carries the routine's instruction and a one-line account of why it arrived.
- Every refusal path reaches the producer's fire log with its reason kept apart: unknown Member, Member not
  enabled, no live session, failed injection.
- One verification run on a probe host records a real fire and the Member turn it started.

## Formal-doc exit

The delivery lanes and the wake contract belong in `docs/team-collaboration/attention-and-messaging.md`
once a producer ships; the package README already states the Host-side contract. Close this item after
that document records the producer, or delete it if the feature is abandoned.
