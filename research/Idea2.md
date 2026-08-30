# Local PKM + Jira Planning Tool — Design Brief

**Status:** design agreed, not started. This document is the handoff to the coding agent.

---

## 1. Context and constraints

Author is an IT middle manager at a Tier 1 investment bank (Cash Equities electronic trading). Environment constraints drive every decision below:

- **No approved PKM tooling.** OneNote only. Obsidian, Notion, Capacities, Tana etc. are unavailable — closed source, so they fail third-party software review regardless of price.
- **Fully local only.** No cloud sync, no telemetry, no outbound network except the corporate Jira instance.
- **Open source stack required** so the whole thing can be reviewed internally.
- Jira's own planning UI is inadequate for the author's team-planning workflow.
- Author already uses Copilot agents at work; agent access to notes is a first-class requirement.

## 2. Requirements

| # | Requirement | Priority |
|---|---|---|
| R1 | Intuitive note-taking with wikilinks, backlinks, tags, daily notes | Must |
| R2 | Fully local, no cloud dependency | Must |
| R3 | Encrypted, password-protected notes for sensitive material (1:1s, performance, comp) | Must |
| R4 | Jira integration — MVP is read-only sync of all issues in the author's project | Must |
| R5 | A fast planning surface over team Jira issues that beats native Jira | Must |
| R6 | API for Copilot agents to read and safely, reversibly modify note content | Should |

## 3. Prior art considered and rejected

- **Obsidian** — best-in-class editor, Bases (table/board/gallery views over frontmatter), ~2,700 plugins, free for commercial use since Feb 2025. Rejected: proprietary, and community plugins are unsigned JS with full filesystem access. Fails corporate review. *Still the best reference implementation to study.*
- **Trilium / TriliumNext** — AGPL, native protected notes, ETAPI REST API, built-in MCP server. Rejected as a base, but **its encryption design is worth copying** (see §7).
- **Logseq 2.0** — moved from Markdown files to canonical SQLite in the July 2026 DB beta; years of delay, product split in two, features lost, data-loss warnings during migration. **Treat as a cautionary tale: do not make the database canonical.**
- **VS Code + Foam / markdown-oxide** — lowest-effort path (wikilinks, backlinks, graph inside already-approved VS Code). Rejected in favour of a purpose-built tool, because R5 (planning surface) is the real value and no extension provides it.

## 4. Stack

**Agreed:**

```
Tauri (desktop shell)
  └─ Rust backend
       └─ SQLite
React + TypeScript frontend
  └─ CodeMirror 6 editor
```

**Rationale:** Rust/Tauri gives a small signed-able binary with no localhost listener, a system tray, and a global capture hotkey. It also keeps the door open to Loro for CRDT sync later — Loro is Rust-native and its movable-tree CRDT is the only mainstream option that models hierarchical/outliner data properly.

**Deviation from the original proposal: CodeMirror 6, not TipTap/ProseMirror.**

TipTap is a rich-text editor over a ProseMirror document model. With Markdown files as the source of truth, that forces a lossless Markdown ↔ ProseMirror serializer for every custom node — wikilinks, embeds, block anchors, callouts, frontmatter, task lists. Round-trip fidelity is where this class of project dies; one bad serialization pass silently corrupts a thousand notes. Obsidian's editor is CodeMirror 6 for exactly this reason: Live Preview is CM6 decorations rendered over the raw Markdown, so the file is always the truth and the editor never serializes. Use CM6 with decoration-based live preview.

**Blocking environment question the author must answer before work starts:** can a self-compiled, unsigned binary run on the work endpoint? If publisher-certificate allowlisting is enforced, a Tauri `.exe` is dead on arrival and the fallback is a local FastAPI/uvicorn app under an already-approved Python interpreter, served at `127.0.0.1`. Same data model, same file format, same build order — only the shell changes.

## 5. Core architectural decision: files are canonical

**Markdown files on disk are the source of truth. SQLite is a rebuildable index.** Delete the DB, rebuild it by walking the vault folder. Nothing is lost.

This is the single most important constraint in the document. It buys:

- Durability and portability — notes survive the tool
- Copilot agents read notes natively as workspace files, no API needed
- `git` provides versioning, audit trail, diffs, and one-command rollback for free
- Immunity to the Logseq migration failure mode

**Rejected alternative:** canonical SQLCipher database. It solves R3 more elegantly (whole-DB encryption at rest, FTS works inside the encrypted DB, no per-note nonce management) — but it breaks R6. If the DB is canonical and encrypted, agents can't read files, `git diff` is meaningless, and "safe and reversible" stops being free and becomes a bespoke API with its own audit layer. R3 and R6 genuinely conflict here; this brief resolves the conflict in favour of R6 and scopes encryption to a subfolder instead.

### Vault layout

```
vault/
  daily/2026-08-29.md
  notes/*.md
  jira/PROJ-123.md
  private/*.md.enc        # encrypted, excluded from index and agent access
  .index/index.sqlite     # rebuildable
  .git/
```

### Index schema (SQLite, unencrypted, disposable)

```
notes(path PK, title, hash, mtime, frontmatter_json)
notes_fts               -- FTS5 over title + body
links(src, dst, type)   -- type: link | embed | anchor
tags(note, tag)
jira(key PK, status, assignee, sprint, points, epic,
     rank_local, plan_bucket, confidence, blocked_on, updated_at)
```

Backlinks are a reverse query on `links`. File watching via `notify` (Rust) for live reindex.

### Link syntax to parse

`[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target#^blockid]]`, `![[embed]]`.

Unresolved targets render as clickable placeholders that create the note on click. This is the feature that makes wikilinks feel good rather than tedious — do not skip it.

## 6. Jira sync (R4)

- Fetch via `POST /rest/api/2/search` with JQL, paginated on `startAt`, with an explicit `fields=` allowlist to keep payloads small.
- **Auth is configured explicitly, never autodetected.** Data Center: Bearer PAT against `/rest/api/2/`. Cloud: Basic auth, email + API token, against v3.
- Incremental sync off a stored watermark: `project = X AND updated >= "<last_sync>"`.
- Cache raw issue JSON so files can be re-rendered without re-fetching.
- Multiple named JQL profiles, each with its own target folder and sync interval.

### File format — the memo marker is critical

Each issue is one Markdown file. A generated block is terminated by `<!-- jira:end -->`. **Everything above the marker is rewritten on every sync. Everything below it is the user's and is never touched.**

```markdown
---
jira_key: PROJ-123
title: "Fix login bug on SSO redirect"
status: In Progress
assignee: alice
sprint: "Sprint 42"
epic: "[[SSO Hardening]]"
jira_url: https://jira.internal/browse/PROJ-123
# local-only planning fields, never sent to Jira:
rank_local: 12
plan_bucket: "Q3 risk reduction"
confidence: medium
blocked_on: "[[PROJ-119]]"
---

# PROJ-123: Fix login bug on SSO redirect

<generated body>

<!-- jira:end -->

## My notes
Preserved across every sync.
```

Get the marker logic exactly right on day one, including the "marker missing" fallback (options: overwrite / skip and warn / append). This is what makes the tool trustworthy. If it eats someone's notes once, it's dead.

Selected field values should be wrappable as `[[wikilinks]]` so Jira data joins the note graph.

## 7. Planning surface (R5) — the actual product

This is where the value is. Everything else is table stakes.

**The key idea: local-only planning fields.** Jira owns status, assignee, sprint. The tool adds `rank_local`, `plan_bucket`, `confidence`, `blocked_on`, `owner_note` — fields that live only in frontmatter and that Jira never sees. This lets the author re-rank the whole backlog by their own logic, bucket work by theme rather than sprint, and flag risk, **without touching the shared board or renegotiating workflow config with anyone.**

- Board view reads from the `jira` index table
- Group by any frontmatter field; saved views are stored queries
- Drag to set bucket and rank → writes frontmatter → reindexes
- **Write-back to Jira is a later phase.** When built: select issues → preview a diff table of old → new → confirm → batched REST calls, with every prior value captured in a rollback log.

## 8. Encryption (R3)

Scoped to `private/` only. Not whole-DB.

Copy Trilium's design, which is sound:

- scrypt (n=2^15, r=8, p=1) derives a master key from the passphrase
- a random 32-byte data key is generated at vault init and stored wrapped by the master key — so a passphrase change re-wraps one key instead of re-encrypting everything
- per-note AES-256-GCM, fresh 12-byte nonce prepended to ciphertext (GCM is authenticated, so tampering is detected)
- decrypt to memory only, never to disk
- auto-lock after 10 minutes of inactivity, timer extended by interaction

Use `ring` or `RustCrypto` (`aes-gcm`, `scrypt`). **Do not implement primitives.**

Accept these three limitations explicitly rather than discovering them later:

1. **Filenames and metadata leak.** Use opaque IDs for `private/` if that matters.
2. **Encrypted blobs diff badly in git.** Keep `private/` out of the repo, or accept the churn.
3. **Encrypted notes cannot be in the persistent FTS index.** Either they are unsearchable, or you build a separate in-memory index that exists only while unlocked and is dropped on lock. There is no third option.

## 9. Agent access (R6)

Most of this is free because files are canonical:

- **`git init` the vault; auto-commit on a timer.** Every agent write becomes a reviewable diff and a one-command revert. This is the entire reversibility and audit story for ~30 lines of code.
- Copilot reads the workspace natively — no API required for the read path.

For structured access, expose an MCP server (bearer token even on localhost):

- **Read tools:** `search_notes`, `read_note`, `list_jira`. `private/` is excluded **in code, not by config.**
- **Write tools:** `create_note`, `append_section` — confined to a path allowlist.
- **`propose_edit`** writes to a git branch rather than main; the user reviews the diff and merges.
- All agent commits prefixed `agent:`.

**Security note that must be respected:** synced Jira text is untrusted input — it contains whatever anyone typed into a ticket, and it lands in the vault verbatim. That is a prompt-injection path straight into a tool-using agent with write access. Strip or fence the generated Jira block before it reaches an agent context.

## 10. Build order

1. **Vault walker + SQLite index + FTS + wikilink parser + backlinks. CLI only, no UI.** Prove the data layer before touching pixels.
2. Tauri shell + React + CodeMirror 6 with decoration-based live preview; note list, backlinks panel, daily note.
3. Jira read sync → files. Memo marker, JQL profiles, incremental watermark.
4. Board view, local planning fields, drag-rank, saved views. *(This is the payoff — everything before it is scaffolding.)*
5. Encryption for `private/`.
6. MCP server + git auto-commit.
7. Graph view, Jira write-back.

Encryption is deliberately at step 5, not step 1. It is the module most likely to lose data; everything around it should be stable first.

## 11. Instructions for the coding agent

- **Write the file-format spec into the repo before writing code.** Frontmatter schema, link syntax, marker semantics. It is the contract everything else depends on.
- **Golden-file tests around the Markdown parser and the Jira renderer.** Round-trip fidelity is the failure mode that kills this project. Test it from commit one.
- **Never touch crypto and UI in the same session.**
- **The scope trap is building the editor.** CodeMirror 6 does the editing. Do not rebuild it.
- Watch for Tauri v1 vs v2 API confusion — training data mixes both. Pin v2 and verify against current docs rather than assuming.
- Each phase in §10 ships independently useful and independently abandonable. Do not begin a phase before the previous one is stable.

## 12. Open decisions

- [ ] Can an unsigned self-compiled binary run on the work endpoint? *(Decides Tauri vs local FastAPI shell.)*
- [ ] Jira Data Center or Cloud? *(Decides auth mode and API version.)*
- [ ] Does `private/` go in the git repo or stay outside it?
- [ ] Check encrypted-notes-the-firm-cannot-read against records retention and eComms policy before relying on it.
