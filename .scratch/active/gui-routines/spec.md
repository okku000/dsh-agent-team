# Routines created from the Team GUI — confirmed scope

Written 2026-09-25, after the Human confirmed the v1 shape in session. This is the decision snapshot; where it and
`packages/` disagree, the code wins.

## v1 scope, as the Human confirmed it

- A routine is created in the Team GUI (not by hand-writing the row's `config`).
- Its action is **post**: one Message into one Channel, chosen per routine at creation time.
- The Message is committed **as the Human**. A routine belongs to the Human who created it, and the Human stays
  answerable for what it says.
- The body is posted **verbatim**, with no engine-added marker saying a machine sent it. What wakes a Member is a
  body `@mention`, rendered by the engine only where the declared body does not already carry the handle.
- The `wake` action stays in the engine (an operator's own `config.routines` may still declare it) but is **not**
  exposed in the GUI in v1.
- The routine's schedule is one trigger: `everySeconds` (integer ≥ 60, phased from `anchorAt`) or one absolute
  RFC 3339 `at`. There is no cron expression and none is planned.

## Why a mention is the delivery mechanism

A Channel member who is not mentioned and does not already follow the Thread is not notified and does not find the
Message in their Inbox: Inbox candidates come only from attention, direct, and activity markers, and reading a
Thread does not start a follow. So a mention of exactly one Member on a **newly created taskless Thread** notifies
exactly that Member — which makes per-Member Channels unnecessary, and makes `mention ≈ wake` for the Human's
purpose.

Two consequences shaped v1:

- Replying into an **existing** Thread notifies all of its followers, and mentioning a non-follower there needs a
  Human confirmation token. So a fire always opens a **new** Thread.
- A mention the Host cannot deliver throws and the send is refused (the mentioned Member must be an active Channel
  member). That refusal is a recorded fire outcome, not a silent no-op.

## Why posting as the Human rather than waking

`wake` remains the engine's other lane and keeps properties a post cannot have: no ledger artifact, explicit
unattended framing, structured refusal reasons in the fire log, targeting without Channel membership, and no
`From: human` impersonation. A DM would be the true private mailbox but needs Member sender authority, so it is
deferred rather than approximated.

## Open question, resolved

Committing a Message needs a `workspaceId` as well as a Channel ref. Resolved by carrying **both** the branded
`workspace:<uuid>` and `channel:<uuid>` on the post action, filled by the GUI's Channel picker, rather than adding a
Channel-name resolution helper to the Host: resolving a name would mean a second authority on ref syntax and a new
failure mode at fire time.

## UI placement (still the Human's to confirm)

The stated default is a Team **settings section** (`settings.section`), which is where the Team's other
operator-owned configuration already lives. The alternative the Human may prefer is a left-rail panel like
`ifpf-harness/ui-jobs`. The engine and the Remote CRUD surface do not depend on this choice.
