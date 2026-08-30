# corpoBrain — Build Plan

Status: proposed, 2026-08-30. Synthesised from `research/Idea1.md`, `research/Idea2.md`
and a short verification pass on current tooling. Decisions below are made; open
questions are at the end.

## 1. What we are building

A local-first second brain for an engineering manager that can be **copied as a
folder to a locked-down Windows work laptop and run without installing anything
proprietary**. Three layers:

1. **Notes** — Obsidian-grade capture: Markdown files, `[[wikilinks]]`, backlinks,
   tags, properties, daily notes, full-text search, command palette.
2. **Jira mirror** — read-only sync of the team's sprints and backlog into the
   vault as first-class objects that notes can link to (`[[EXEC-1834]]`).
3. **Planning workbench** — the differentiator. A team-bandwidth view across the
   current and upcoming sprints, with *local-only* planning fields
   (proposed sprint / assignee / rank / risk / notes) that never go back to Jira.

Later: agent access (MCP + git-based reversibility), encrypted private notes,
optional desktop shell, Jira write-back staging.

## 2. Decisions (where the two research docs disagreed)

| Topic | Decision | Why |
|---|---|---|
| Canonical store | **Markdown files + YAML frontmatter are canonical. SQLite is a rebuildable index** (Idea2). | Survives the tool, `git` gives history/diff/rollback for free, Copilot-style agents read files natively, immune to the Logseq migration failure. Idea1's wants (stable IDs, typed objects, revisions) are met with an `id:`/`type:` in frontmatter + git — no canonical DB needed. |
| Editor | **CodeMirror 6 with decoration-based live preview** (Idea2). | Files are the truth, so the editor must never serialise. TipTap/ProseMirror ↔ Markdown round-tripping is where these projects die. Obsidian made the same call. |
| Runtime | **TypeScript end-to-end: Node ≥ 24 backend (Fastify/Hono) serving a React UI at `127.0.0.1`.** No native npm addons: `node:sqlite` for the index, `node:crypto` for encryption, `fs.watch` for reindex. Desktop shell (Tauri) is an *optional later wrapper*, not the foundation. | The hard constraint is "copy to the work laptop and run". A self-compiled unsigned `.exe` is the most likely thing to be blocked by AppLocker/SmartScreen; a script run by an already-approved `node.exe` is the most likely thing to work. Zero native modules means zero unsigned DLLs. One language keeps the codebase small and agent-friendly. Ship as a bundled single-file `server.js` + static `ui/` — no `node_modules` on the laptop. |
| Jira API | Adapter with two backends: **Data Center** `GET/POST /rest/api/2/search` (`startAt` paging, Bearer PAT) and **Cloud** `/rest/api/3/search/jql` (`nextPageToken` paging, Basic email+token). Sprints via Agile API `/rest/agile/1.0/board/{id}/sprint` and `/sprint/{id}/issue`. | Cloud removed the legacy search endpoint in Aug 2025; a bank is almost certainly on Data Center. Auth mode is configured explicitly, never autodetected. |
| Encryption | Per-file AES-256-GCM in `private/`, scrypt-derived master key wrapping a random data key (Trilium design). Not whole-DB. Built at phase 7, not phase 1. | Whole-DB encryption breaks the "files are canonical / agents read files / git diffs" story. It is also the module most likely to lose data, so everything around it should be stable first. |
| Agent writes | Read via MCP (or files directly). Writes land on a **git branch** (`agent/*`), user reviews the diff and merges. `private/` excluded in code. Synced Jira text is fenced as untrusted before reaching any agent. | ~30 lines of git gives Idea1's full "propose → diff → accept → undo" model. |

If Node turns out not to be available on the work laptop, the backend is small
(index, Jira sync, git, crypto — no business logic in the UI) and ports to
Python/FastAPI; the UI and the file format are unchanged. That is the only
fallback we plan for.

## 3. Vault format (the contract — write `docs/SPEC.md` before code)

```
vault/
  daily/2026-08-30.md
  notes/**/*.md
  people/*.md              # type: person  (team members; capacity lives here)
  jira/EXEC-1834.md        # generated above marker, yours below it
  planning/*.md            # saved views / scenarios
  templates/*.md
  private/*.md.enc         # encrypted; never indexed, never visible to agents
  attachments/
  .corpobrain/
    index.sqlite           # disposable, rebuilt by walking the vault
    jira-cache/*.json      # raw issue JSON, re-render without re-fetch
    config.json            # profiles, capacities, settings (no secrets)
  .git/
```

Frontmatter every note may carry: `id` (ULID, assigned on first index), `type`,
`title`, `tags`, `aliases`, `created`, `updated`, plus type-specific properties.
Untyped notes are the default: **capture first, structure later**.

Link syntax: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`,
`[[target#^block]]`, `![[embed]]`. Unresolved links render as clickable
placeholders that create the note on click.

Jira file: generated block terminated by `<!-- jira:end -->`. Above the marker
is rewritten each sync; below is the user's forever. Local planning fields live
in frontmatter under a `plan:` key so they are visually separate from mirrored
Jira fields:

```yaml
---
type: jira
key: EXEC-1834
summary: Reduce tick-to-trade latency
status: In Progress
assignee: john
points: 5
sprint: Sprint 37
epic: "[[EXEC-1700]]"
updated: 2026-08-28T10:12:00Z
plan:                       # local only — Jira never sees this
  sprint: Sprint 39
  assignee: anna
  rank: 12
  risk: high
  blocked_on: ["[[EXEC-1790]]"]
  note: John is already at capacity in 38
---
```

Marker-missing fallback is decided and tested on day one: skip + warn (never
overwrite user text silently).

## 4. Planning workbench (what "best possible UI for work planning" means here)

**Bandwidth grid** — rows = people (from `people/`, each with a `capacity`
in points or days per sprint, overridable per sprint for leave), columns =
current sprint + N future sprints + Backlog. Each cell shows committed points
(Jira sprint+assignee) vs planned points (`plan.sprint`/`plan.assignee`
overrides), a capacity bar, and over/under colouring. Drag an issue card between
cells → writes `plan.*` frontmatter → reindex → grid updates. Nothing goes to Jira.

**Backlog rail** — filterable, groupable (epic / priority / label), rank by
`plan.rank` with drag-reorder, quick-filter by JQL profile.

**Sprint table** — columns: local rank, key, summary, assignee (Jira / planned),
status, points, sprint (Jira / planned), blocked_on, risk, note. Inline edit of
`plan.*` fields.

**Risk strip** — computed, not stored: unestimated, unassigned, stale (> N days),
blocked on unresolved dependency, person over capacity, high priority with no
activity, sprint ending soon with open items.

**Dependency view** — Jira issue links + `plan.blocked_on`, drawn as a small DAG.

**Scenarios** (later) — a `planning/*.md` file that snapshots a set of `plan.*`
overrides so "what if Marek is out for sprint 39" can be compared.

Every issue is also a note: hover-card on `[[EXEC-1834]]` in any note, backlinks
from 1:1 notes and meeting notes to the issue, and the issue's own "My notes"
section below the marker.

## 5. Build order

Each phase ships something usable on its own and is a stable base for the next.
Do not start a phase until the previous one is boring.

> **Status (2026-08-30):** Phases 0–7 are implemented and tested (93 tests).
> Remaining from Phase 8: desktop shell, graph view, Jira write-back staging,
> semantic search. See git history for the phase-by-phase commits.

### Phase 0 — Spec and scaffold (½ day)
- `docs/SPEC.md`: frontmatter schema, link grammar, marker semantics, index schema.
- Monorepo: `packages/core` (pure TS, no I/O beyond fs), `packages/server`,
  `packages/ui`, `packages/cli`. npm workspaces, Vitest, esbuild, Biome.
- CI: lint + test; `npm run build` emits `dist/corpobrain.js` + `dist/ui/`.

### Phase 1 — Core library + CLI, no UI (1–2 weeks)
- Vault walker, frontmatter parse/serialise (round-trip exact, golden tests).
- Wikilink parser (all five forms), tag extraction, block-id extraction.
- SQLite index: `notes`, `notes_fts` (FTS5), `links`, `tags`, `properties`,
  `jira`, `plan`. Full rebuild + incremental on `fs.watch`.
- CLI: `corpobrain index`, `search`, `backlinks`, `links`, `rebuild`.
- Exit criterion: golden-file tests on parser and frontmatter; delete the index,
  rebuild, identical result.

### Phase 2 — Notes app (2–3 weeks)
- Server: JSON API over core, static UI, single-port `127.0.0.1`.
- UI: file tree, CM6 editor with live-preview decorations (headings, links,
  tasks, code, tables), wikilink autocomplete, unresolved-link create-on-click,
  backlinks panel, tags panel, properties panel, daily note, quick capture
  (Inbox), command palette, full-text search, templates, attachments (drag-in).
- Exit criterion: you use it instead of OneNote for a week.

### Phase 3 — Jira read sync (1–2 weeks)
- Adapter (DC / Cloud), explicit auth config, corporate proxy + custom CA
  support (`NODE_EXTRA_CA_CERTS`), field allowlist, raw JSON cache.
- Named JQL profiles with target folder + interval; incremental watermark.
- Boards → sprints (current, future, closed-N) → issues; people discovered
  from assignees and reconciled to `people/`.
- Renderer with memo marker; `[[KEY]]` resolution and hover-card.
- Table + Kanban views over the `jira` index table.
- Exit criterion: 3 syncs in a row never touch text below the marker; a note
  linking `[[EXEC-1834]]` shows as a backlink on the issue.

### Phase 4 — Planning workbench (3–4 weeks) — **the payoff**
- Bandwidth grid, backlog rail, sprint table, risk strip, dependency view,
  saved views. `plan.*` writes via frontmatter, never via Jira.
- Exit criterion: you run sprint planning from this screen.

### Phase 5 — Structure without ceremony (1–2 weeks)
- Typed objects via `type:` (person, meeting, decision, project, topic) with
  per-type templates and property hints; Bases-style table/card/board views over
  any folder or query; task roll-up (`- [ ]` across notes, by person/date).
- Meeting → decisions/actions linking pattern for 1:1s.

### Phase 6 — Agent access (1 week)
- `git init` on vault, auto-commit on timer + on every Jira sync.
- MCP server (stdio, plus localhost with bearer token): `search_notes`,
  `read_note`, `get_backlinks`, `list_jira`, `get_plan`, `create_note`,
  `append_section`, `propose_edit` (→ `agent/*` branch). `private/` excluded
  in code. Jira-generated blocks fenced as untrusted.
- UI: "Proposed changes" panel = branch diff with accept / reject / undo.

### Phase 7 — Private notes (1 week, crypto-only session)
- `private/*.md.enc`, scrypt + AES-256-GCM, wrapped data key, unlock with
  passphrase, in-memory-only decrypt, in-memory FTS while unlocked, auto-lock
  10 min. Locked notes do not exist to search or agents — not even as a count.

### Phase 8 — Optional / later
- Desktop shell (Tauri v2 or Electron) for tray + global capture hotkey, if a
  signed binary becomes possible.
- Graph view, calendar/timeline view, canvas.
- Jira write-back staging: select → diff table → confirm → batched REST with
  rollback log. Agents may only *propose* into this stage.
- Local embeddings / semantic search; optional LLM providers.

## 6. Non-negotiables for the coding agent
- Files are canonical. Never add state that only lives in SQLite.
- Golden-file tests on frontmatter round-trip, link parsing and the Jira
  renderer from the first commit.
- No native npm addons. Check `npm ls --all` for anything with a `binding.gyp`.
- Never touch crypto and UI in the same change.
- Do not build an editor; configure CodeMirror 6.
- All network calls go only to the configured Jira host. No telemetry, no
  update checks, no CDN assets — the UI must load fully offline.

## 7. Environment answers (2026-08-30)
- Node and Python are both on the work laptop → **Node backend confirmed**; Python fallback not needed.
- Jira: DC vs Cloud unknown; **token auth**. The adapter supports both; a `corpobrain jira probe` command will
  hit `/rest/api/2/serverInfo` and report deployment type so the user only has to paste URL + token.
- `git.exe` available → git-based history and agent-proposal branches as planned.
- Locally encrypted `private/` is acceptable under policy.
- Capacity unit: **person-days by default**, but the unit is a per-vault setting
  (`capacity.unit: days | points | hours`) with a per-issue effort field mapped from a configurable
  Jira field (story points, original estimate, or a local `plan.effort` when Jira has none).

## 8. Still open
- Corporate proxy / custom root CA on the path to Jira? (Handled via `NODE_EXTRA_CA_CERTS` /
  `HTTPS_PROXY` either way — just needs confirming when Phase 3 starts.)
- Does `private/` stay outside git? Default: excluded via `.gitignore`, opt-in to include.
