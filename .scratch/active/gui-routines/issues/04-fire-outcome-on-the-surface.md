# 04 — the last fire's outcome, where the routine was created

**What to build:** the routine surface answers what happened the last time a routine fired instead of only what is
scheduled — delivered, or refused with the Host's own reason (an unknown Member, a Member that is not enabled, a
Member with no live session) — so a routine that quietly stopped working is visible where the Human set it up, and
not only in a log file on the Host.
**Blocked by:** None — the routine store, the wake-only engine, the Host routine API, and the global surface have
landed.
**Status:** ready

- [ ] A read-only Remote reports recent fire records (newest first, bounded) to a client bound to a Workspace that exists, without exposing the log path or letting a caller write to it.
- [ ] Each routine's line on the global surface states its newest fire outcome and when, and distinguishes a refusal from a delivery.
- [ ] A routine that has never fired, and a fire log that cannot be read, each render as their own state rather than as a refusal.
- [ ] The surface re-reads the outcome after a save and when it opens, on the same terms it re-reads the schedule, because a fire emits no Team `changes` event either.
- [ ] The renewed criteria in `03` that this ticket now owns are stated in the maintained documents, and `CHANGELOG.md` records the fire outcome becoming visible.

## Why this is its own ticket

It is the only remaining part of the feature that needs a new Host-facing read: the schedule is served by the
routine API, but a fire's outcome is a line the producer appends to `$DSH_HOME/agent-team/routines/fires.jsonl`,
and nothing reads that file today. Folding it into the surface ticket would have hidden a Host API, a generated
Remote artifact, and their tests inside what was supposed to be a Client slice.

## Open question for the Human

The outcome could instead be dropped as a requirement, leaving the fire log as the operator's own view. That is a
smaller feature; it also re-opens the completion condition the Human stated for this work item ("a refused fire is
visible to the Human as an outcome, not only as a line in the fire log"). Default if nobody answers: build it as
ticket `04` above.
