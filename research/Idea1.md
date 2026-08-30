# Project Summary: Local-First Engineering Manager Second Brain

## Product Vision

Build a fully local, open-source knowledge and planning workspace designed primarily for technical leads and engineering managers.

It should combine:

* Obsidian-style note taking and linking
* Capacities/Tana-style structured objects
* strong local privacy and encrypted notes
* Jira read integration and better planning UX
* safe APIs/MCP access for coding/AI agents
* reversible, reviewable AI modifications

The product should NOT be another generic open-source Notion clone.

The core product positioning is:

**A local-first knowledge and planning workbench for technical leads and engineering managers.**

Or more broadly:

**A local-first, typed, agent-native second brain where humans own the data and AI can safely help maintain it.**

---

# Primary User Problem

At work, many modern second-brain tools are unavailable because:

* they are cloud-first
* they are proprietary
* they may not pass enterprise security requirements
* data cannot leave the workstation/company network

The available alternative may be something like OneNote, which lacks:

* wikilinks
* backlinks
* structured metadata
* powerful queries
* good task/planning capabilities
* Jira integration
* agent/API integration

Jira itself is also poor as a personal/team planning UI.

The product should therefore become the layer between:

**personal/team knowledge**
+
**Jira work tracking**
+
**AI/copilot agents**

while remaining entirely local.

---

# Core Product Principles

## 1. Local-first

The application must work completely without:

* a cloud account
* an external server
* proprietary SaaS dependencies
* internet connectivity, except when explicitly accessing Jira or configured AI services

Local-first is an architectural principle, not merely an "offline mode".

---

## 2. User owns the data

Avoid proprietary data lock-in.

Recommended approach:

* SQLite or equivalent structured local database as operational storage
* attachments stored as ordinary files
* revision/change history
* deterministic export to Markdown and JSON
* documented workspace format

Example conceptual workspace:

/workspace
database
attachments/
exports/
markdown/
json/
history/

Markdown should be a supported representation/export format, but probably not the entire primary database because the system will eventually need:

* typed objects
* stable IDs
* relationships
* block identities
* revision history
* encrypted content
* transactions
* agent diffs
* potentially CRDT/sync later

---

# Core Knowledge Model

Everything should conceptually be an Object.

Example:

Object

* stable ID
* type(s)
* title
* content / blocks
* properties
* relations to other objects
* tags
* sources/provenance
* attachments
* revision history
* optional spatial context
* optional encryption state

Objects could include:

* Note
* Person
* Project
* Meeting
* Decision
* Task
* JiraIssue
* Team
* Topic
* Document

The system should allow gradual structure.

A user should be able to create a normal note first and only later turn it into a typed object.

Do NOT require ontology/schema design before taking notes.

Principle:

**capture first, structure later**

---

# Note-Taking UX

The basic experience should feel closer to Obsidian than Notion.

Required features:

* fast rich-text / Markdown-like editor
* [[wikilinks]]
* backlinks
* tags
* properties/metadata
* folders or hierarchical navigation where useful
* Daily Notes
* Inbox / quick capture
* templates
* tasks/checklists
* full-text search
* command palette
* file attachments
* note version history
* embedded links to typed objects
* table/card/Kanban views over objects

Potential future features:

* graph view
* semantic search
* visual canvas
* calendar
* timeline
* map
* saved queries

Views should not duplicate objects.

A single object should be displayable as:

* document
* table row
* Kanban card
* calendar item
* graph node
* canvas card

---

# Wikilinks and Object Resolution

Example note:

# Alice 1:1

We discussed [[EXEC-1834]].

Alice thinks [[EXEC-1942]] is blocked by APAC.

Here:

[[EXEC-1834]]

should resolve directly to the corresponding JiraIssue object.

Hovering or clicking can show something like:

EXEC-1834
Reduce tick-to-trade latency
In Progress
John
5 points
Sprint 37

Backlinks for the Jira issue could show:

Referenced by:

* Alice 1:1 — 26 Aug
* Execution Weekly — 22 Aug
* APAC Capacity Planning

This creates meaningful connections between human notes and Jira work.

---

# Jira Integration

## Key architectural rule

Jira remains the authoritative system.

Our application maintains a local read cache/mirror and adds a local planning/knowledge overlay.

Do NOT initially attempt to replace Jira.

---

# Jira MVP

Allow configuration of:

* Jira URL
* authentication
* project
* saved JQL queries

Example:

project = EXEC

Fetch and locally cache Jira issues.

Basic local JiraIssue representation:

JiraIssue

* key
* summary
* description
* status
* assignee
* reporter
* priority
* sprint
* epic
* labels
* story points
* created
* updated
* issue links
* comments if permitted
* remote URL

Initially Jira integration should be read-only.

---

# Jira Planning Overlay

This is potentially the killer feature.

Users should be able to attach LOCAL metadata to Jira issues without changing Jira.

Example:

EXEC-100
myPriority: 1
targetSprint: Sep-1
ownerConcern: false

EXEC-101
myPriority: 2
targetSprint: Sep-1
ownerConcern: true
managerNote: "John already overloaded"

EXEC-102
dependency: EXEC-109
targetSprint: Sep-2

This metadata remains local.

Jira never sees it unless the user explicitly chooses to synchronize specific fields in a future feature.

---

# Jira Planning Views

Build significantly better team planning views than Jira provides.

Examples:

## Sprint planning table

Columns:

* local priority
* Jira key
* summary
* assignee
* Jira status
* story points
* proposed sprint
* dependencies
* manager note
* risk

---

## Team workload

Example:

Anna     17 pts
John     24 pts    WARNING
Marek    10 pts
Olivia   13 pts

Potential future intelligence:

* workload imbalance
* work-in-progress overload
* stale issues
* blocked dependencies
* missing estimates
* sprint risk

---

## Risk dashboard

Possible automatically computed views:

* blocked > N days
* no update > N days
* no assignee
* no estimate
* sprint ending soon
* unresolved dependency
* too much work assigned to one person
* items likely to slip
* high-priority issue without recent activity

---

## Dependency graph

Example:

EXEC-142
|
EXEC-151
|
EXEC-173

EXEC-191

This should use Jira issue links plus optional local dependency relationships.

---

# Security

Security is a first-class requirement.

There should ideally be two protection layers.

---

# Workspace Encryption

Encrypt the local database at rest.

Possible approach:

SQLite
+
SQLCipher or equivalent

Encryption keys should use secure OS credential/key storage where enterprise policy permits.

Attachments containing sensitive data need consideration as well.

---

# Protected / Sealed Notes

Individual notes or folders should be optionally protected by a separate password/passphrase.

Protected content should encrypt:

* title
* body
* attachments
* sensitive properties
* ideally as much metadata as reasonably possible

When locked, the application should expose almost nothing other than:

"Protected note"

Do not reveal content, titles or useful metadata.

---

# Search Behavior for Protected Notes

Locked notes must NOT participate in:

* full-text search
* semantic search
* agent queries

This is intentional.

Once unlocked, protected content may temporarily join an in-memory search index.

When the protected session expires:

* wipe temporary decrypted indexes
* revoke agent access
* clear cached plaintext where possible

---

# AI / Copilot / Agent Integration

Agent integration should be built around MCP or a similarly simple local API.

The application could expose a local process such as:

brain-mcp

Potential read operations:

search_notes(query)
get_note(id)
get_backlinks(id)
search_objects(query)
query_graph(...)
search_jira(query)
get_jira_issue(key)
get_team_plan()
get_sources(...)

These APIs allow tools such as GitHub Copilot or other local/enterprise-approved agents to use the workspace as context.

Example questions:

"What did we previously decide about the KDB gateway architecture?"

"Find everything involving EXEC-7318 and summarize unresolved issues."

"Look at issues assigned to Tomasz and my recent notes. What delivery risks have I recorded?"

---

# Agent Write Safety Model

Agents should NEVER receive unrestricted write access.

The preferred model is Git-like.

Agents submit proposals.

Example:

propose_note_change(
note = "Execution Architecture",
patch = ...
)

The UI shows a diff:

Execution Architecture

* Gateway will maintain the materialized mapping

- Mapping will be generated on demand

Actions:

Accept
Reject

If accepted, create a revision:

Revision: 8d39ac
Author: Copilot Agent
Timestamp: ...

Undo must always be possible.

---

# Batch Agent Changes

For multiple changes:

"Copilot proposes 14 changes across 7 notes."

Allow:

* Review
* Accept selected
* Accept all
* Reject
* Undo afterward

Every AI change should have:

* source agent
* timestamp
* before/after diff
* revision ID
* optional rationale

Agent modifications should be transactions rather than silent mutations.

---

# Protected Notes and Agents

A locked protected note should effectively NOT EXIST to an agent.

For example:

search_notes("salary")

must not even reveal:

"3 inaccessible results found."

That would leak metadata.

After manually unlocking protected content, the user could optionally grant temporary agent access.

Example permissions:

Allow Copilot for 15 minutes:

[x] Read this note
[ ] Read all protected notes
[ ] Modify protected notes

Default:

Agents cannot modify protected notes.

Modification should require very explicit permission if it is supported at all.

---

# Future Jira Write Support

Do NOT start with this.

Eventually allow planned Jira changes to be staged locally.

Example:

Review Jira Changes

EXEC-1833
Sprint:
Backlog -> Sprint 42

EXEC-1841
Assignee:
Mark -> Alice

EXEC-1902
Priority:
Medium -> High

[Apply 3 changes to Jira]

AI agents should never directly mutate Jira.

They should propose changes, and the user approves the batch.

---

# Suggested Desktop Architecture

Desktop-first is preferable to browser-first for the initial corporate/local use case.

Suggested stack:

Tauri

* Rust backend
* filesystem / security / Jira access
* encryption
* SQLite

React + TypeScript

* UI

TipTap / ProseMirror

* rich editor

SQLite

* operational local structured storage

Potential:

SQLCipher

* encrypted DB

MCP server

* local sidecar or integrated local endpoint

Reason to prefer Tauri over Electron:

* smaller footprint
* native backend
* better control over local privileges
* smaller browser attack surface
* potentially easier enterprise acceptance

---

# Existing Projects Worth Studying

Do not blindly reinvent everything.

## TriliumNext

Especially relevant because it already includes:

* local desktop notes
* internal links
* relations
* attributes
* note history
* per-note encryption
* scripting
* REST API
* Markdown import/export
* canvases
* graphs
* OneNote import
* Obsidian/Notion/Anytype import

It may be worth studying or borrowing architectural ideas from it.

However, do not automatically fork it.

Potential concerns:

* Electron architecture
* inherited architecture/UX decisions
* security history
* retrofitting a modern typed-object model may be difficult

---

## Other products worth studying

Obsidian:

* local ownership
* wikilinks
* backlinks
* extensions
* Bases

Capacities:

* typed objects
* progressive structure
* good object UX

Tana:

* typed schemas
* agents
* MCP
* proposed AI changes

Mem:

* low-friction capture
* proactive resurfacing

Gemini Notebook / NotebookLM:

* provenance
* citations
* source-grounded AI

Heptabase:

* spatial knowledge and canvas semantics

Anytype:

* local-first object graph and encrypted sync concepts

AFFiNE / AppFlowy / SiYuan:

* open-source implementations to study rather than reinvent infrastructure

---

# MVP Scope

Avoid building everything at once.

The MVP should be useful enough to replace OneNote + part of Jira usage.

## MVP 1: Local Brain + Jira Read

### Notes

* create/edit/delete notes
* rich editor
* wikilinks
* backlinks
* tags
* properties
* folders/navigation
* search
* Daily Note
* attachments
* revision history

### Security

* fully local
* encrypted database
* password-protected/sealed notes

### Jira

* Jira URL/auth configuration
* saved JQL query
* local issue cache
* JiraIssue objects
* [[ABC-123]] references
* issue detail view
* table view
* Kanban view
* local annotations
* local planning metadata

The main UX investment should go into the Jira planning workspace.

---

# MVP 2: Agent Read + Safe Note Writes

Expose MCP:

brain.search
brain.read
brain.get_backlinks
jira.search
jira.read
planning.read

Then add:

brain.propose_edit
brain.propose_create

All writes are diff-based and reversible.

---

# MVP 3: Jira Change Staging

Add:

jira.propose_change

Changes go into a local staging area.

User reviews them before application.

Never give agents uncontrolled Jira modification rights.

---

# Later Features

After the core product proves useful:

* semantic search
* local embeddings
* local LLM support
* OpenAI/Anthropic/etc. optional providers
* semantic canvas
* graph
* calendar
* timeline
* reusable saved queries
* automatic meeting/task extraction
* automatic inbox organization
* agent-proposed types/properties
* plugin SDK
* self-hosted sync
* encrypted multi-device synchronization
* collaboration
* mobile capture

---

# Important Product Philosophy

Do not optimize for "maximum features."

Optimize for:

1. very fast capture
2. very fast retrieval
3. zero cloud requirement
4. powerful linking
5. structured data without forcing structure
6. genuinely useful Jira planning
7. transparent AI behavior
8. complete reversibility
9. strong security boundaries
10. ownership of all data

The application should feel simple when used simply.

Advanced capabilities should appear progressively rather than forcing users to understand schemas, graph databases, AI agents or query languages before writing their first note.

---

# Core Differentiator

The product should NOT primarily be described as:

"An open-source Notion clone"

or:

"An Obsidian alternative"

The strongest differentiator is:

**Local knowledge + Jira planning + agent-safe automation**

The most promising initial niche is:

**technical leads and engineering managers working in security-constrained enterprise environments.**

The ideal outcome is that the user opens this tool each morning instead of opening OneNote and Jira separately.

Jira remains the system of record.

This application becomes the system for:

* thinking
* planning
* remembering
* connecting information
* understanding team workload
* managing delivery risk
* interacting with agents

while everything stays under the user's control.

