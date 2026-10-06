# Teambook org import

Teambook is the source of truth for PODs and their members; your organization
and person notes are the source of truth for everything you know beyond that.
The importer proposes Teambook's view as a list of reviewable changes and
writes only what you approve. It complements the hand-built organization map
([Organization mapping](ORGANIZATION.md)); it never replaces it.

## Using it

1. Settings → **Teambook import**: API URL, token (stored in
   `.corpobrain/secrets.json`, or `CORPOBRAIN_TEAMBOOK_TOKEN`), and a **root
   POD id**. Only that POD and everything below it is imported; set it.
2. **Preview from Teambook** fetches, validates and plans. Nothing in your
   notes changes. The raw data is kept under
   `.corpobrain/teambook-cache/snapshots/` (last 10).
3. Review. Recommended changes are pre-selected; conflicts, departures and
   blocked items are not. Tick a conflict to take Teambook's value, or tick
   **keep mine, stop asking** to silence it until Teambook changes again.
4. **Apply**. The vault is committed to git first (when it is a repository).
5. **Undo** in *Past imports* restores every note the import changed, except
   notes you edited since, which are listed and left alone. Notes it created
   go to `.trash`.

Re-running the same import after applying it shows nothing to do except the
conflicts you kept.

## What it changes, and what it never does

It writes only these frontmatter keys, plus `teambook_id` (and `type` on new
notes):

| Note | Keys |
|---|---|
| organization (`org_unit`) | `title`, `org_kind` (new notes only), `parent`, `leads`, `status`, `mandate` |
| person | `title`, `email`, `role`, `country`, `primary_pod`, `secondary_pods`, `active` (only when you tick a departure) |

It never: deletes a note, clears a value, renames or moves a file, touches a
note body, edits `functional_manager` / `entity_manager`, headcounts, counted
groups, capacity, region, team, tags or any other key; changes the level of an
existing organization note; writes to a note whose frontmatter does not parse.

## How it stays safe

**Matching** (in order; ambiguity is never resolved by guessing):

- `teambook_id` in the note's frontmatter;
- people: the same email (any of the note's `email:` values);
- a unique exact title or alias among notes not yet linked. A person whose
  note has a different email is not matched by name.

Two notes that could match → the item is reported as ambiguous and skipped.
Two notes with the same `teambook_id` → both are left alone with a warning.
Matching by email or title produces a **link** change (adding `teambook_id`);
every other change to that note depends on it.

**Three-way merge per field.** The importer remembers what it last wrote
(`.corpobrain/teambook-cache/baseline.json`) and compares three values:
yours, Teambook's, and the last import's.

| Your note | Teambook | Result |
|---|---|---|
| empty | has a value | **fill**, selected |
| same as Teambook | — | nothing to do |
| unchanged since the last import | changed | **update**, selected |
| edited since the last import | unchanged | nothing: your edit stands |
| differs (edited, or never imported) | differs | **conflict**, not selected |
| has a value | empty | nothing: values are never cleared |

Lists (`leads`, `email`, `secondary_pods`) only grow, and an item you removed
after an import is not added back. Countries compare loosely (`PL` = Poland).
References compare by Teambook id, so `[[execution]]` and
`[[organization/execution]]` both agree with the same POD.

**Departures.** A linked person missing from their primary POD in the fetched
tree, or marked inactive by Teambook, gets a `left` change (set `active:
false`), never pre-selected. People outside the fetched subtree are not
judged.

**Levels.** Teambook nodes become Departments, Product Areas or PODs: as
Teambook states it (`kindOf` in the adapter), otherwise from the tree (root
with children → Department, inner node → Product Area, leaf → POD). A parent
that corpoBrain's levels cannot express is a blocked change, not a silent
flattening.

**Apply re-checks everything.** Each selected change is re-checked against
the file as it is now; a value edited since the preview, a note created or
linked meanwhile, or unparseable frontmatter skips that change (and whatever
depends on it). Then the whole organization map is rebuilt with the new
notes, and if that would add any relationship problem anywhere — a cycle, a
POD under a POD, a link that becomes ambiguous because a new note shares a
title — nothing at all is written and the problems are listed.

**Journal.** Every apply is recorded in
`.corpobrain/teambook-cache/imports/<id>.json`: the exact previous content of
each note, and a hash of what was written. Undo uses it; the baseline is
restored with it.

## Completing the adapter

*For the agent completing the Teambook connection on the work machine.*

Only `packages/core/src/teambook/parse.ts` knows Teambook's wire format. Fill
in every `TODO(teambook)` there:

- `authHeaders(token)` — the auth scheme.
- `endpoints.hierarchy(rootId)`, `endpoints.members(podId)`, and
  `endpoints.pods()` (return `null` if the hierarchy already carries names and
  status). Paths are relative to the configured base URL; encode ids with
  `encodeURIComponent`.
- `nextPage(request, body, headers)` if any endpoint paginates.
- `parseHierarchy`, `parsePods`, `parseMembers` → the types in
  `packages/core/src/teambook/types.ts`.
- `kindOf(level)` if Teambook labels levels (department/area/team…).
- Set `TEAMBOOK_ADAPTER_READY = true`.

Rules:

- Use the guards in `parse.ts` (`asObject`, `asArray`, `asId`, `asText`,
  `asOptionalText`, `asOptionalBool`) for every field. An unexpected shape must
  throw a `TeambookSchemaError` naming the path; never default a missing id or
  name, never coerce silently.
- Ids are Teambook's stable ids, never display names. User ids must be the
  same in every POD's member list.
- Set `primary`, `lead`, `kind`, `active` only from what Teambook states;
  `null` means unknown and is handled downstream. Do not infer them.
- Emails as Teambook has them; matching lower-cases.
- Do not change `client.ts`, `plan.ts`, `apply.ts` or the server to fit the
  API; if the API needs something they cannot express, add it to `parse.ts`
  (e.g. a richer `nextPage`) and keep the normalized types unchanged.
- Add redacted response fixtures under `packages/core/test/fixtures/teambook/`
  (fake names, emails and ids, the real structure) and replace the `it.todo`
  entries in `packages/core/test/teambook-parse.test.ts`. Never commit real
  responses. Run `npm run check`.

Before the first real import, test without the API: write a snapshot in the
`TeambookSnapshot` shape (see `types.ts`) to
`.corpobrain/teambook-cache/fixture.json` and use **Preview from fixture**. A
real preview's snapshot (in `snapshots/`) can be copied there too.
