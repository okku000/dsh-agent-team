# Routines created from the Team GUI — confirmed scope

Written 2026-09-25, updated twice the same day: first after the Human redirected the UI shape and asked for
agent-created routines, then after they narrowed the feature to waking a Member. This is the decision snapshot;
where it and `packages/` disagree, the code wins.

## Withdrawn later the same day: the `post` action

The Human chose one lane — 「各エージェントをwakeするやり方一本で行こうと思う」 — so the `post` action described in the
withdrawn bullets below was removed from the engine, the store contract, the `team_routine` tool, and the docs. A
routine now wakes one named Member and does nothing else. Everything about UI placement, creator attribution, and
the trigger survives; the sections that argued for posting as the Human are kept as the reasoning of a decision that
was made and then withdrawn. Nothing was lost in the real environment, which held no stored routine.

## Scope, as the Human confirmed it

- A routine is scheduled work the Human can see and create **in the Team GUI**, and **any Agent Member can create
  through a tool** — the Human's own words: they want a global cron viewer that is also where crons are created,
  they want each agent to be able to create one, and the payoff they named is *creating crons conversationally*
  ("毎朝9時にこれを投稿して" said to an agent, which then schedules it).
- Its one action is **wake**: the routine names one Member and one instruction, and the instruction is injected into
  that Member's own Session. The Member then decides what to do — including saying something in a Channel, if that
  is what the instruction asks for.
- ~~Its action is **post**: one Message into one Channel, chosen per routine at creation time.~~ Withdrawn with the
  `post` action, together with its body-verbatim, posted-as-the-Human, and mention-delivery rules.
- `wake` is now the engine's only lane, and it is what the GUI creates as well as what an operator's
  `config.routines` may declare. It is the natural action for an *agent-created* routine ("every morning, check the
  catalog") precisely because no ledger artifact and no impersonation are involved.
- The schedule is one trigger: `everySeconds` (integer ≥ 60, phased from `anchorAt`) or one absolute RFC 3339 `at`.

## UI placement — resolved

**A global surface beside the Inbox**, reached by Team navigation, that both lists every routine and creates one.
Not a settings section, not a left-rail plugin panel: those were my two proposals and the Human rejected both in
favour of "Inbox のように global".

The mechanism already exists: the Team Client's navigation snapshot carries an `inbox?: boolean` mode and
`TeamConversation.tsx` renders the Inbox page for it. A routines surface is a sibling mode in that same snapshot,
so it needs no new slot, no new rail entry, and no profile patch — which is also why it satisfies "global".

## Agent-created routines: the authority decision to be explicit about

Any Agent Member can create a routine. As long as the action was `post`, that meant an agent could make the Team
speak in the Human's name on a schedule; with the wake-only redirect the reachable risk is smaller but real — an
agent can make another Member start a turn on a schedule, spending its context unattended. The design therefore
records the creator on every stored routine (who saved it, and when) and shows it, so the Human can always answer
"who scheduled this?" and delete it. Nothing blocks an agent from creating one.

## Why a wake is the delivery mechanism

A wake needs no Channel, no mention, and no new Thread: it reaches any activated Member with a live Session,
including one that shares no Channel with the producer. It also leaves no ledger artifact — what arrives is context
that Member reads, framed as unattended — so a routine cannot quietly author Team facts, and a refusal is a
structured reason in the fire log rather than a Message nobody received.

## Reconnaissance: mentions, Inbox, and followers

Still true of the Team, and still relevant if a routine ever grows a way to say something: a Channel member who is
not mentioned and does not already follow the Thread is not notified and does not find the Message in their Inbox,
because Inbox candidates come only from attention, direct, and activity markers, and reading a Thread does not start
a follow. Two consequences shaped the withdrawn design and would shape a future one:

- Replying into an **existing** Thread notifies all of its followers, and mentioning a non-follower there needs a
  Human confirmation token. So a Message a routine commits always opens a **new** Thread.
- A mention the Host cannot deliver is refused (the mentioned Member must be an active Channel member). That
  refusal would have to be a recorded fire outcome, not a silent no-op.

## Why the action was `post` rather than a wake — withdrawn

This was the withdrawn case: `post` reached a Human-visible Thread and could notify several Members at once, which a
wake cannot do. It bought that at the price of impersonating the Human on the ledger and of needing a Channel and a
deliverable mention, so a fire could fail for reasons outside the routine's own declaration. The Human's redirect
traded the reach for the simpler contract.

## Settled implementation questions

- No Channel-name resolution helper, and no per-routine `workspaceId` in the declaration: with `post` gone nothing
  in a routine names a Workspace, and the saving call's own Workspace is used only to authorize the Member.
- Routine operations need **no `requestId`**: the routine *name* is the identity, so saving is an upsert and
  deleting is idempotent by construction. They are Host configuration, not ledger operations, so they cannot use
  the ledger's request-id dedupe anyway.
