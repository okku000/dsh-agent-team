# 03 — a Human creates a routine in the Team GUI

**What to build:** a Human opens the Team's settings, picks one Channel, writes a body, chooses whether to mention anyone, and gives the thing a schedule — then saves it and it fires on its own. This is the slice the whole work item exists for.
**Blocked by:** `02` (the Remote CRUD surface).
**Status:** ready once `02` lands

- [ ] A routine is created end to end in the interface: name, Channel, body, mentions, and one trigger, with nothing written by hand in a profile.
- [ ] The form refuses what the Host would refuse — an empty body, an interval under a minute, no trigger — and says which field is wrong before the save is attempted.
- [ ] A posted routine's mention shows as a real mention chip in the Thread, puts the Message in the named Member's Inbox, and starts that Member's turn.
- [ ] The routine's last fire outcome is visible where the Human created it, so a refused fire is not something only the fire log knows about.
- [ ] `npm run test:browser` passes, the new screenshots are inspected at desktop and 390×844, and the Human previews it on the `web-dev` profile.
