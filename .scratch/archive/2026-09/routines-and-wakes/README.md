# Routines and producer-triggered wakes

Status: closed 2026-09-25 — both sides implemented in this package and verified end to end on a probe host.
Last checked: 2026-09-25.

## Where it landed

Both halves shipped in this repository. The Host side is `wakeMember`
(`packages/agent-team/src/member-wake.ts`, the service method in `src/index.ts`, `tests/member-wake.spec.ts`):
one producer-triggered turn in a named Member's own Session, on the same idle/busy lanes DM relay uses, with
refusals carried as reasons.

The producer is the Team's own row, `wowyuarm-agent-team-routines` (`src/routine-schedule.ts`,
`src/routines.ts`, `cordis.patch.yml`, exported as `@wowyuarm/dsh-agent-team/routines`):
`config.routines` declares one trigger per routine — `everySeconds` aligned to `anchorAt`, or a single
RFC 3339 `at` — plus a target Member by handle or branded id and the instruction; the row fires it through
`wakeMember`, frames it as an unattended `[ROUTINE FIRE]`, and appends every outcome to
`$DSH_HOME/agent-team/routines/fires.jsonl`. The row ships unconfigured, so an operator supplies a
schedule by patching its id in their profile.

Commits: `b774a65` (the row, its tests, the docs) and `bf695f9` (the scheduler takes the Host's synchronous
wake result — a type error the first commit's checks missed). The standalone `routines/` plugin this
replaced was retired from `ifpf-harness` (`0ae5697`), recoverable at `a27f5f2:routines/`.

## Verification evidence

- Unit: `tests/routine-schedule.spec.ts` (11) and `tests/routines.spec.ts` (20) — arming, the phase after a
  slow delivery, refusal reasons, `once`, a spent one-shot, `dispose`, two independent grids, and the fire
  log's append / trim / unwritable paths. Full repository gate `npm test` green (783 passed, 1 skipped).
- End to end, 2026-09-25 on a copy of the real DSH home (separate home, port 3099, real profile untouched):
  the built tgz installed into the copied profile, the profile layer patching the row's id with a one-shot
  `at` about five minutes ahead; `fires.jsonl` recorded
  `{"routine":"probe-one-shot","outcome":"delivered","mode":"followup","sessionId":"agent-team-0afba9ea-…"}`,
  the woken Member's `session.v4.jsonl.zstd` carried the notice with
  `source.kind = wowyuarm-agent-team-routines` via `agent/inbox/spliced`, and the Member ran a real turn
  answering `ROUTINE-PROBE-OK`.

## Completion conditions

All three met:

- A routine configured in a profile fired at its instant, and the named Member started a turn carrying the
  instruction and its one-line account.
- The refusal paths reach the fire log with the reason kept apart (unit-covered: `unknown-member`,
  `member-not-enabled`, `no-live-session`, `wake-failed`).
- One verification run on a probe host recorded a real fire and the Member turn it started.

## Formal-doc exit

Done: the wake contract, the built-in producer, its configuration, and the fire log are recorded in
`docs/team-collaboration/attention-and-messaging.md` ("Producer-injected wakes"), the package README pair
documents the row ("Routines"), and the CHANGELOG carries the user-visible entry.
