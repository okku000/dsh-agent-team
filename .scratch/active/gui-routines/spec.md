# Routines created from the Team GUI — confirmed scope

Written 2026-09-25, updated the same day after the Human redirected the UI shape and asked for agent-created
routines. This is the decision snapshot; where it and `packages/` disagree, the code wins.

## Scope, as the Human confirmed it

- A routine is scheduled work the Human can see and create **in the Team GUI**, and **any Agent Member can create
  through a tool** — the Human's own words: they want a global cron viewer that is also where crons are created,
  they want each agent to be able to create one, and the payoff they named is *creating crons conversationally*
  ("毎朝9時にこれを投稿して" said to an agent, which then schedules it).
- Its action is **post**: one Message into one Channel, chosen per routine at creation time.
- The Message is committed **as the Human**. A routine belongs to the Human who created it, and the Human stays
  answerable for what it says.
- The body is posted **verbatim**, with no engine-added marker saying a machine sent it. What wakes a Member is a
  body `@mention`, rendered by the engine only where the declared body does not already carry the handle.
- `wake` stays in the engine and stays reachable: an operator's `config.routines` may declare it, and it is the
  natural action for an *agent-created* routine ("every morning, check the catalog"). It is not the GUI's default.
- The schedule is one trigger: `everySeconds` (integer ≥ 60, phased from `anchorAt`) or one absolute RFC 3339 `at`.

## UI placement — resolved

**A global surface beside the Inbox**, reached by Team navigation, that both lists every routine and creates one.
Not a settings section, not a left-rail plugin panel: those were my two proposals and the Human rejected both in
favour of "Inbox のように global".

The mechanism already exists: the Team Client's navigation snapshot carries an `inbox?: boolean` mode and
`TeamConversation.tsx` renders the Inbox page for it. A routines surface is a sibling mode in that same snapshot,
so it needs no new slot, no new rail entry, and no profile patch — which is also why it satisfies "global".

## Agent-created routines: the authority decision to be explicit about

Any Agent Member can create a routine, and a routine posts **as the Human**. That is the Human's explicit choice,
but it means an agent can make the Team speak in the Human's name on a schedule. The design therefore records the
creator on every stored routine (who saved it, and when) and shows it, so the Human can always answer "who
scheduled this?" and delete it. Nothing blocks an agent from creating one.

## Naming

The Human says "cron"; the code, docs, fire log, store file, and config key all say **routine**, and the engine has
no cron expression syntax. Renaming is a large churn across a shipped public contract, so the naming stays
`routine` for now; the UI wording is a separate, cheap decision still open.

## Why a mention is the delivery mechanism

A Channel member who is not mentioned and does not already follow the Thread is not notified and does not find the
Message in their Inbox: Inbox candidates come only from attention, direct, and activity markers, and reading a
Thread does not start a follow. So a mention of exactly one Member on a **newly created taskless Thread** notifies
exactly that Member — which makes per-Member Channels unnecessary, and makes `mention ≈ wake` for the Human's
purpose.

Two consequences shaped the design:

- Replying into an **existing** Thread notifies all of its followers, and mentioning a non-follower there needs a
  Human confirmation token. So a fire always opens a **new** Thread.
- A mention the Host cannot deliver is refused (the mentioned Member must be an active Channel member). That
  refusal is a recorded fire outcome, not a silent no-op.

## Why posting as the Human rather than waking

`wake` remains the engine's other lane and keeps properties a post cannot have: no ledger artifact, explicit
unattended framing, structured refusal reasons in the fire log, targeting without Channel membership, and no
`From: human` impersonation.

## Settled implementation questions

- Committing a Message needs a `workspaceId` as well as a Channel ref, so a post action carries **both** the branded
  `workspace:<uuid>` and `channel:<uuid>`, filled by whoever creates the routine. No Channel-name resolution helper:
  that would be a second authority on ref syntax.
- Routine operations need **no `requestId`**: the routine *name* is the identity, so saving is an upsert and
  deleting is idempotent by construction. They are Host configuration, not ledger operations, so they cannot use
  the ledger's request-id dedupe anyway.
