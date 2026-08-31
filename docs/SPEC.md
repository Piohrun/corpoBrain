# corpoBrain Vault Format Specification

Version: 0.2.0 (draft, 2026-08-31)

This document is the contract that every package depends on. Change it
deliberately, bump the version, and update the golden tests.

Key words MUST / SHOULD / MAY are used as in RFC 2119.

---

## 1. Principles

1. **Files are canonical.** A vault is a directory of Markdown files. Anything
   the tool knows can be recomputed from those files. The SQLite index MAY be
   deleted at any time.
2. **Round-trip fidelity.** Reading a file and writing it back without edits
   MUST produce a byte-identical file. The tool never reformats user text.
3. **Never lose user text.** Any automated write (Jira sync, agent, migration)
   that cannot prove it is only touching tool-owned regions MUST refuse and warn.
4. **Plain text wins.** Everything is readable and editable in any editor; the
   vault remains useful if this tool disappears.

---

## 2. Vault layout

```
<vault>/
  daily/               YYYY-MM-DD.md, one per day
  notes/               free-form notes, arbitrary subfolders
  people/              type: person
  jira/                one file per mirrored issue, KEY.md
  planning/            saved views and scenarios
  templates/           note templates
  private/             *.md.enc — encrypted, never indexed
  attachments/         binary files referenced from notes
  .corpobrain/
    config.json        vault settings (no secrets)
    index.sqlite       rebuildable index (+ -wal/-shm)
    jira-cache/        raw issue JSON keyed by issue key
    secrets.json       encrypted credentials (Phase 3)
  .gitignore
  .git/
```

- Folder names above are defaults; `config.json` MAY remap them.
- The tool MUST ignore: `.corpobrain/`, `.git/`, dotfiles, `node_modules/`,
  and any path matched by `config.ignore` globs.
- Only `*.md` files are indexed as notes. `*.md.enc` are recognised as
  protected notes but their content is never read by the indexer.

---

## 3. Note file

A note is UTF-8 text with LF or CRLF line endings (the indexer accepts both;
a writer MUST preserve whatever the file already uses, and use LF for new
files).

```
---
<YAML frontmatter>
---
<Markdown body>
```

Frontmatter is optional. If present it MUST start on line 1 with `---` and end
with the next line consisting solely of `---`.

### 3.1 Identity

A note is identified by three things, in order of stability:

| Identifier | Source | Stability |
|---|---|---|
| `id` | frontmatter, ULID | permanent; assigned by the indexer on first sight if missing (see 3.4) |
| path | filesystem path relative to vault root, without `.md` | changes on move/rename |
| title | frontmatter `title`, else first `# H1`, else file basename | user-facing only |

Link resolution (Section 5) uses path and title/aliases, never `id`. `id`
exists so that backlinks, revisions and agents can refer to a note across
renames.

### 3.2 Reserved frontmatter keys

All reserved keys are optional unless stated.

| Key | Type | Meaning |
|---|---|---|
| `id` | string (ULID) | stable identity |
| `type` | string | object type: `note` (default), `person`, `meeting`, `decision`, `project`, `topic`, `jira`, `view`, `scenario`. Unknown types are allowed and treated like `note`. |
| `title` | string | display title; overrides H1 |
| `aliases` | string[] | alternative link targets |
| `tags` | string[] | the note's authoritative tag set, without `#`. Inline `#tags` in the body are rendered with tag styling but are NOT part of the note's tags. |
| `created` | ISO-8601 datetime | |
| `updated` | ISO-8601 datetime | maintained by the tool on save; not authoritative (mtime wins for indexing) |
| `template` | string | path of the template this note was created from |
| `parent` | wikilink string | places this note under another note in the hierarchy tree (§3.5). Any note may be a parent; the tree is derived, files never move. |
| `order` | number | sort position among siblings in the tree; ties sort by title |
| `plan` | object | local planning overlay (Section 7). Only meaningful for `type: jira`. |
| `jira` | object | tool-owned mirror metadata (Section 6). Only for `type: jira`. |

Any other key is a **property** and is indexed as `properties(note, key, value_json)`.

Property values MAY be scalars, lists, or objects. A string value that is
exactly a wikilink (`"[[Target]]"`) or a list of them is indexed as a link of
type `property` in addition to being a property.

### 3.3 Body conventions

- CommonMark + GFM (tables, task lists, strikethrough).
- Wikilinks and embeds per Section 5.
- Inline tag tokens: `#tag`, `#nested/tag`. Must be preceded by start-of-line
  or whitespace and followed by whitespace, punctuation or EOL. Not recognised
  inside code spans, code fences, or URLs. Recognition is for RENDERING only —
  a note's tags come exclusively from frontmatter `tags:` (§3.2).
- Block IDs: a line MAY end with ` ^blockid` (space, caret, `[A-Za-z0-9-]+`).
  The ID addresses that block (paragraph, list item, heading, table row).
- Tasks: GFM `- [ ]` / `- [x]`. The indexer records each task with its text,
  state, containing note, block ID (if any), and any `📅 YYYY-MM-DD` or
  `@due(YYYY-MM-DD)` token.
- Callouts: `> [!type] Title` (Obsidian syntax) are rendered but carry no
  semantics.
- Inline secrets: a fenced block with info string `secret` holds a base64
  CBV1 container (§9 key hierarchy, plaintext padded to 64-byte multiples)
  encrypted under the protected-notes data key. Only ciphertext ever touches
  disk, the index, or agents; the UI decrypts to memory on demand while the
  private session is unlocked.

### 3.4 Indexer writes

The indexer is read-only **except** for one case: assigning a missing `id`.
When it does so it MUST:

- insert `id: <ulid>` as the first key of the frontmatter, creating a
  frontmatter block if none exists;
- change nothing else in the file (byte-for-byte outside the inserted line(s));
- skip files in `jira/` (the Jira renderer owns their frontmatter) and skip
  any file that fails to parse.

This is opt-in per vault (`config.index.assignIds`, default `true`).

### 3.5 Hierarchy

Notes form a forest derived from the `parent` frontmatter key. `parent` holds
a wikilink resolved with the standard rules (§5.2). A note whose `parent` is
missing, unresolvable, or part of a cycle is a root. Children sort by `order`
(ascending, missing last), then title. `type: jira` notes use `parent` for
the Jira issue hierarchy and are excluded from the notes tree.

---

## 4. Frontmatter handling

- Parsed as YAML 1.2 (core schema). Dates that YAML would auto-convert are
  kept as **strings**; the tool never turns `2026-08-30` into a Date object at
  the storage layer.
- Serialisation MUST be minimal-diff: when the tool updates a key it rewrites
  only that key's line(s), preserving key order, comments, quoting style and
  blank lines elsewhere. Implementation: line-level patching of the
  frontmatter block, not re-emitting the whole document from a parsed object.
- If a frontmatter block cannot be parsed the note is still indexed (title,
  body, links) and flagged `frontmatter_error` in the index. The tool MUST NOT
  write to such a file.

---

## 5. Links

### 5.1 Grammar

```
wikilink  = "[[" target [ "#" fragment ] [ "|" alias ] "]]"
embed     = "!" wikilink
target    = 1*( any char except "[", "]", "#", "|" )   ; trimmed
fragment  = "^" blockid | heading-text
```

- `target` MAY be empty when a fragment is present: `[[#Heading]]` links
  within the current note.
- Links are not recognised inside inline code, fenced code blocks, or
  frontmatter values other than as described in 3.2.
- Markdown links `[text](path.md)` to a vault-relative `.md` path are ALSO
  indexed as links (type `md`) so imported vaults keep their graph.
- A bare Jira key in body text (`EXEC-1834`, regex `\b[A-Z][A-Z0-9_]+-\d+\b`,
  restricted to configured project keys) is indexed as an **implicit link**
  of type `mention` to `jira/EXEC-1834` but is not rendered as a link unless
  `config.jira.autolinkMentions` is true.

### 5.2 Resolution

Given `target`, resolve in this order; first match wins:

1. Exact vault-relative path (with or without `.md`), e.g. `notes/arch/gateway`.
2. Jira key pattern → `jira/<KEY>` (even if the file does not exist yet).
3. Case-insensitive match on `title` or any `aliases` of exactly one note.
4. Case-insensitive match on file basename of exactly one note.
5. If more than one note matches at step 3 or 4, the link is **ambiguous**:
   indexed as unresolved with `ambiguous = 1` and rendered with a warning.
6. Otherwise **unresolved**: indexed as such, rendered as a placeholder.
   Clicking creates `notes/<target>.md` (or `config.links.newNoteFolder`) with
   `title: <target>`.

Resolution is recomputed on every index update; renaming a note re-resolves
all links to it and the tool SHOULD offer to rewrite affected link text.

### 5.3 Index representation

```
links(src_path, dst_target, dst_path NULL, kind, fragment NULL,
      alias NULL, line, col, ambiguous)
kind ∈ { link, embed, property, md, mention }
```

Backlinks of a note = `SELECT … FROM links WHERE dst_path = ?`.

---

## 6. Jira mirror files

One file per issue at `jira/<KEY>.md`. The file has two regions separated
by the **marker line**:

```
<!-- jira:end -->
```

- The marker MUST appear exactly as above, alone on its line.
- **Above** the marker (frontmatter + generated body) is owned by the sync
  and is rewritten on every sync.
- **Below** the marker is owned by the user and MUST be carried over
  byte-for-byte.
- Exception within the frontmatter: the `plan:` object is **user-owned** and
  MUST be carried over unchanged even though it lives above the marker.

### 6.1 Rendered layout

```markdown
---
id: 01J…                      # carried over
type: jira
key: EXEC-1834
summary: Reduce tick-to-trade latency
status: In Progress
status_category: indeterminate      # new | indeterminate | done
issue_type: Story
priority: High
assignee: jdoe                      # account id / username (see people mapping)
assignee_name: John Doe
reporter: asmith
sprint: Sprint 37
sprint_id: 412
sprints: [Sprint 36, Sprint 37]     # full history when available
epic: "[[EXEC-1700]]"
parent: "[[EXEC-1700]]"
labels: [latency, apac]
components: [gateway]
fix_versions: [2026.9]
estimate: 5                         # numeric, in config.jira.estimateField units
estimate_field: customfield_10016
created: 2026-08-01T09:00:00Z
updated: 2026-08-28T10:12:00Z
resolved: null
url: https://jira.example.com/browse/EXEC-1834
links:
  - { type: blocks, dir: outward, key: "[[EXEC-1900]]" }
  - { type: is blocked by, dir: inward, key: "[[EXEC-1790]]" }
jira:
  synced: 2026-08-30T07:00:00Z
  profile: exec-team
  render: 1                         # renderer version
plan:                               # carried over verbatim
  sprint: Sprint 39
  assignee: anna
  rank: 12
  risk: high
  effort: 3
  blocked_on: ["[[EXEC-1790]]"]
  note: John is at capacity in 38
---

# EXEC-1834 — Reduce tick-to-trade latency

**Status:** In Progress · **Assignee:** John Doe · **Sprint:** Sprint 37 · **Estimate:** 5

## Description

<description converted from Jira wiki/ADF to Markdown; on conversion
failure, fenced as ```text>

## Links

- blocks [[EXEC-1900]]
- is blocked by [[EXEC-1790]]

## Comments

<only when config.jira.syncComments is true; each as "**author** · date" + body>

<!-- jira:end -->

## My notes

Anything here survives every sync.
```

Rules:

- Field names in frontmatter are stable across DC and Cloud; the adapter
  normalises.
- Values that are Jira keys are written as wikilinks so they join the graph.
- Text from Jira is **untrusted**. The renderer MUST neutralise anything that
  would be interpreted by this spec: the marker line itself (`<!-- jira:end -->`
  inside a description is rewritten to `<!-- jira:end (escaped) -->`), and
  leading `---` lines. Wikilinks in Jira text are left as-is (they are just
  text) but MUST NOT be indexed as links from the generated region — the
  indexer skips link extraction above the marker except for frontmatter.
- The generated region MUST NOT contain inline tags that get indexed.

### 6.2 Sync write algorithm

```
existing = read(file) or null
if existing is null:
    write(render(issue, plan = {}, userRegion = "\n## My notes\n\n"))
else:
    fm = parseFrontmatter(existing)
    plan = fm.plan ?? {}
    id = fm.id
    markerIdx = indexOf(existing, "\n<!-- jira:end -->\n")   # also accept CRLF, EOF
    if markerIdx == -1:
        policy = config.jira.missingMarker   # "skip" (default) | "append" | "overwrite"
        skip:      log warning, do not write, count in sync report
        append:    write(render(...) + existing body)   # user text kept, moved below marker
        overwrite: refuse unless issue file hash matches jira-cache render hash
    else:
        userRegion = existing[markerIdx + len(marker):]
        write(render(issue, plan, id, userRegion))
write is atomic: temp file + rename.
Only write if output != existing (no mtime churn).
```

A sync report lists created / updated / unchanged / skipped files.

### 6.3 People mapping

`people/<slug>.md` with `type: person`. Frontmatter:

```yaml
type: person
title: Anna Kowalska
jira: akowalska            # Jira account id or username; MAY be a list
email: anna@example.com
role: Senior Engineer
capacity: 8                # per sprint, in config.capacity.unit
capacity_overrides:
  Sprint 39: 4             # leave, on-call, etc.
active: true
```

The sync creates missing person files for any assignee seen (with `capacity`
left unset) unless `config.jira.createPeople` is false. Issues refer to people
by the Jira account id; the UI resolves to the person note via `jira:`.

---

## 7. Planning overlay (`plan:`)

Lives in the frontmatter of `jira/*.md`, is written only by this tool's
planning UI (or the user by hand), and is never sent to Jira.

| Key | Type | Meaning |
|---|---|---|
| `sprint` | string | proposed sprint name (must match a known sprint or `Backlog`) |
| `assignee` | string | proposed assignee (person `jira` id) |
| `rank` | number | local ordering within the backlog; lower = higher |
| `effort` | number | local effort estimate in `capacity.unit`; overrides Jira estimate for planning |
| `risk` | `low` \| `medium` \| `high` | |
| `confidence` | `low` \| `medium` \| `high` | |
| `bucket` | string | free-text theme / initiative |
| `blocked_on` | wikilink[] | local dependencies, in addition to Jira links |
| `note` | string | manager's note |

Effective planning values (used by the bandwidth grid):

```
effectiveSprint   = plan.sprint   ?? jira sprint   ?? "Backlog"
effectiveAssignee = plan.assignee ?? jira assignee ?? null
effectiveEffort   = plan.effort   ?? convert(estimate, estimate_unit → capacity.unit) ?? null
```

Conversion uses `config.capacity.pointsPerDay` etc.; unknown → `null` and the
item counts as **unestimated** in the risk strip.

### 7.1 Scenarios

`planning/<name>.md` with `type: scenario` holds a set of overrides:

```yaml
type: scenario
title: Marek out in Sprint 39
base: current           # or another scenario
overrides:
  EXEC-1834: { sprint: Sprint 40 }
  EXEC-1901: { assignee: anna }
capacity_overrides:
  mkowalski: { Sprint 39: 0 }
```

Scenario overrides are applied on top of `plan.*` at query time and are never
written into `jira/*.md` unless the user "applies" the scenario.

### 7.2 Saved views

`planning/<name>.md` with `type: view`:

```yaml
type: view
title: Sprint 39 candidates
source: jira                       # jira | notes | tasks
filter: 'status_category != done AND (effectiveSprint = "Sprint 39" OR plan.bucket = "latency")'
sort: [{ field: plan.rank, dir: asc }]
group: effectiveAssignee
layout: table                      # table | board | grid | list
columns: [key, summary, effectiveAssignee, status, effectiveEffort, plan.risk]
```

Filter grammar (Phase 4): field comparisons with `=`, `!=`, `<`, `>`, `in`,
`contains`, combined with `AND` / `OR` / `NOT` and parentheses. Fields are
frontmatter keys, `plan.*`, `effective*`, `file.*` (path, mtime), `tags`.

---

## 8. Daily notes and templates

- Daily note path: `daily/YYYY-MM-DD.md`, created from
  `templates/daily.md` if present.
- Template variables: `{{date}}`, `{{date:FORMAT}}`, `{{title}}`,
  `{{time}}`, `{{yesterday}}`, `{{tomorrow}}`, `{{cursor}}`. Unknown
  variables are left verbatim.
- `templates/<type>.md` is the default template for `type: <type>` notes.

---

## 9. Protected notes (`private/`)

Defined here so the layout is fixed; implemented in Phase 7.

- Files: `private/<opaque-id>.md.enc`. Filenames carry no meaning.
- Container: `CBV1` magic (4 bytes) · version u8 · 12-byte nonce ·
  AES-256-GCM ciphertext+tag of the plaintext Markdown note (which has its
  own frontmatter including the human title).
- Key hierarchy: passphrase → scrypt(N=2^15, r=8, p=1, salt) → master key;
  master key wraps a random 32-byte data key stored in
  `private/.keystore.json` (`{ version, salt, wrappedKey, nonce }`).
- Locked state: the index contains only the path and the fact that it is
  protected. No title, size, mtime or count is exposed through the API or MCP.
- Unlocked state: plaintext exists in memory only; an in-memory FTS table is
  built and dropped on lock. Auto-lock after `config.private.lockAfterMinutes`
  (default 10).

---

## 10. Index schema (SQLite)

Schema version stored in `meta(key, value)`; mismatch → full rebuild.

```sql
notes(path TEXT PRIMARY KEY, id TEXT, type TEXT, title TEXT, mtime INTEGER,
      size INTEGER, hash TEXT, frontmatter_json TEXT, frontmatter_error INTEGER,
      protected INTEGER DEFAULT 0);
CREATE INDEX notes_id ON notes(id); CREATE INDEX notes_type ON notes(type);
aliases(path, alias);                    -- includes title, lowercased
notes_fts USING fts5(path UNINDEXED, title, body, tokenize='unicode61');
links(src_path, dst_target, dst_path, kind, fragment, alias, line, col, ambiguous);
tags(path, tag);                         -- lowercased, from frontmatter and body
properties(path, key, value_json);
tasks(path, line, block_id, text, done INTEGER, due TEXT);
headings(path, level, text, line);
blocks(path, block_id, line);
jira(key PRIMARY KEY, path, summary, status, status_category, issue_type,
     priority, assignee, reporter, sprint, sprint_id, epic, parent, labels_json,
     estimate, created, updated, resolved, synced, profile);
plan(key PRIMARY KEY, sprint, assignee, rank REAL, effort REAL, risk,
     confidence, bucket, blocked_on_json, note);
sprints(id PRIMARY KEY, name, state, start, end, board_id, goal);
people(path PRIMARY KEY, jira_id, name, capacity REAL, overrides_json, active);
meta(key PRIMARY KEY, value);
```

Everything in this schema is derivable from vault files plus
`.corpobrain/jira-cache/`.

---

## 11. `config.json`

```jsonc
{
  "version": 1,
  "folders": { "daily": "daily", "notes": "notes", "jira": "jira",
               "people": "people", "planning": "planning",
               "templates": "templates", "private": "private",
               "attachments": "attachments" },
  "ignore": ["**/*.tmp"],
  "index": { "assignIds": true },
  "links": { "newNoteFolder": "notes" },
  "capacity": { "unit": "days", "pointsPerDay": 1, "hoursPerDay": 8,
                "sprintLengthDays": 10 },
  "jira": {
    "baseUrl": "https://jira.example.com",
    "deployment": "auto",          // auto | datacenter | cloud
    "auth": "bearer",              // bearer (PAT) | basic (email + token)
    "projectKeys": ["EXEC"],
    "estimateField": "customfield_10016",
    "estimateUnit": "points",
    "syncComments": false,
    "createPeople": true,
    "autolinkMentions": false,
    "missingMarker": "skip",
    "profiles": [
      { "name": "exec-team", "jql": "project = EXEC AND updated >= -90d",
        "folder": "jira", "intervalMinutes": 15,
        "boards": [42], "futureSprints": 3 }
    ]
  },
  "private": { "lockAfterMinutes": 10 },
  "git": { "autoCommit": true, "intervalMinutes": 10 }
}
```

Secrets (Jira token, etc.) are never in `config.json`. They live in
`.corpobrain/secrets.json`, encrypted with a key held in the OS user profile
(`%APPDATA%/corpobrain/key` / `~/.config/corpobrain/key`), or are supplied via
the `CORPOBRAIN_JIRA_TOKEN` environment variable.

---

## 12. Golden tests (required from Phase 1)

`packages/core/test/golden/` contains pairs of input and expected JSON:

- `frontmatter/*.md` → parsed frontmatter, body offset, and round-trip
  byte-equality after `setKey` / `deleteKey` operations.
- `links/*.md` → list of link records (all grammar forms, code-span
  exclusions, CRLF files, ambiguous and unresolved cases).
- `tags/*.md`, `tasks/*.md`, `blocks/*.md`.
- `jira/*.json` (raw issue) + optional existing `*.md` → rendered file; cases:
  no existing file, marker present, marker missing under each policy, `plan:`
  carried over, hostile description containing the marker and `---`.

A change to this spec that alters any golden output MUST bump the spec
version.
