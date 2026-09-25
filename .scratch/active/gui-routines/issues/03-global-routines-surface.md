# 03 — a global Team surface that views and creates routines

**What to build:** one global surface in the Team Client — the Human's own words: "Inbox のように global" — that
lists every routine and its schedule, shows who created each one and where it came from, and creates, edits, and
deletes one without a profile edit or a Host restart.
**Blocked by:** `02` (the Host API it calls) — landed.
**Status:** ready

- [ ] The surface is reached from the Team's own navigation, beside the Inbox, and lists routines from every Workspace the Human participates in.
- [ ] Each row states the trigger in Human terms, the Member the routine wakes, and the creator; a declaration that came from the operator's own `config.routines` is marked as such rather than offered for edit.
- [ ] Creating a routine is a form in the same surface: name, the Member to wake, the instruction to inject, and one trigger, with nothing written by hand in a profile.
- [ ] The form refuses what the Host would refuse — an empty instruction, an unknown or unactivated Member, an interval under a minute, no trigger — and names the offending field before the save is attempted.
- [ ] A routine saved here fires at its instant, and the newest fire outcome is visible where the Human created it, so a refused fire is not something only the fire log knows about.
- [ ] The surface refreshes when it opens and after its own saves and deletes, because a routine save emits no Team `changes` event.
- [ ] `npm run test:browser` passes, the screenshots are inspected at desktop and 390×844, and the Human previews it on the `web-dev` profile.

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
