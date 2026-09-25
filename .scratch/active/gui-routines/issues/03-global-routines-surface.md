# 03 — a global Team surface that views and creates routines

**What to build:** one global surface in the Team Client — the Human's own words: "Inbox のように global" — that
lists every routine and its schedule, shows who created each one and where it came from, and creates, edits, and
deletes one without a profile edit or a Host restart.
**Blocked by:** `02` (the Host API it calls) — landed.
**Status:** complete

- [x] The surface is reached from the Team's own navigation, beside the Inbox, and lists routines from every Workspace the Human participates in.
- [x] Each row states the trigger in Human terms, the Member the routine wakes, and the creator; a declaration that came from the operator's own `config.routines` is marked as such rather than offered for edit.
- [x] Creating a routine is a form in the same surface: name, the Member to wake, the instruction to inject, and one trigger, with nothing written by hand in a profile.
- [x] The form refuses what the Host would refuse — an empty instruction, an unknown or unactivated Member, an interval under a minute, no trigger — and names the offending field before the save is attempted.
- [x] The surface refreshes when it opens and after its own saves and deletes, because a routine save emits no Team `changes` event.
- [x] `npm run test:browser` passes, the screenshots are inspected at desktop and 390×844, and the Human previews it on the `web-dev` profile.

**Moved out, not satisfied here:** the criterion "a routine saved here fires at its instant, and the newest fire
outcome is visible where the Human created it". Nothing reads the Host's fire log — the routine API answers the
schedule, and a fire's outcome is a file the Host appends to — so no amount of Client work satisfies it. It is now
[`04-fire-outcome-on-the-surface.md`](04-fire-outcome-on-the-surface.md), and the shortfall is stated in the
maintained documents rather than papered over.

## What landed

Routines became the Inbox's sibling global face: a `routines` flag on the Client navigation snapshot beside
`inbox`, a second card above the Workspace selector with a second rail icon, and a page that reads the Host's whole
schedule through one fence Workspace and writes it through `saveRoutine` and `deleteRoutine`.

The read is fenced rather than scoped — the Host answers the same whole list to every Workspace — so the page reads
once through the first visible Workspace instead of merging a slice per Workspace, which would repeat every row,
and it picks its wake target from the global Member catalog rather than a Workspace roster. Both global faces share
one seat rule: the seat's auto-select must not reconcile the remembered Workspace out from under either of them,
which the Inbox already relied on and this surface initially did not.

## Reconnaissance already done (do not re-derive)

- The Team Client's navigation snapshot already carries an `inbox?: boolean` mode; `TeamConversation.tsx` renders
  the Inbox page for it. A routines surface is a sibling mode in that same snapshot — no new slot, no rail entry,
  no profile patch. That is what makes it "global".
- Client surface modules live in `packages/client-agent-team/src/client/` (page component, its `*.module.css`,
  locale entries via `ctx.locale.register(NS, { zh, en })`).
- Remote bindings are collected in one `sharedRemotes` object in `packages/client-agent-team/src/client/index.ts`;
  a surface-specific extra is injected per slot.
- Do not copy private shipped UI, and do not redeclare a slot parent's `children` — the slot parent owns render
  authority.
