# corpoBrain

Local-first second brain for engineering managers: Markdown notes with wikilinks and
backlinks, a read-only Jira mirror, and a team-bandwidth planning workbench. Runs
entirely on `127.0.0.1` from a folder you can copy to a locked-down laptop. No cloud,
no telemetry, no native binaries — plain Node.

- Plan: [docs/PLAN.md](docs/PLAN.md) · Vault format contract: [docs/SPEC.md](docs/SPEC.md)

## What's in the repo vs. what's yours

The repo contains **only the application**. Your notes live in a separate *vault*
folder that is never committed here (`vault/` is gitignored — as are Jira tokens,
which stay in `<vault>/.corpobrain/secrets.json`). The vault is plain Markdown: it
can be its own git repo (the app auto-commits it for history) or just a folder.

## Setting up on the work machine (Windows)

Prerequisites: **Node.js ≥ 22.13** (`node --version`) and ideally git.

**Option A — build on the machine** (needs npm access to the internet/proxy once):

```bat
git clone <your-repo-url> corpoBrain
cd corpoBrain
npm install
npm run build
```

On a machine where vite/rollup cannot be installed (quarantined packages), install
without dev dependencies and use the esbuild-only build — this is why `esbuild` is a
runtime dependency, not a dev one:

```bat
npm install --omit=dev --ignore-scripts
npm run build:work
```

**Option B — no npm on the work machine**: run `npm run build` on any machine,
copy the resulting `dist\` folder over (USB, share, artifact). `dist\` is fully
self-contained — `corpobrain.js`, `corpobrain-cli.js`, `ui\` — no `node_modules`
needed at runtime.

**Create your vault** (once), then start:

```bat
node dist\corpobrain-cli.js init --vault %USERPROFILE%\corpobrain-vault
node dist\corpobrain.js %USERPROFILE%\corpobrain-vault
```

Open http://127.0.0.1:4747 — or just double-click `scripts\start.cmd`, which does
the init-if-missing and launch for you (set `CORPOBRAIN_VAULT` to override the
vault location, `CORPOBRAIN_PORT` for the port).

**Connect Jira** from the app: ⚙ page → Connection settings → URL, auth
(Bearer PAT for Data Center, email + API token for Cloud), token, project keys,
a sync profile with your JQL and board id → *Test connection* → *Sync now*.
If Jira is only reachable through the corporate proxy, fill the **proxy** field
in the same settings (or set `HTTPS_PROXY`). If TLS fails behind interception,
`start.cmd` auto-uses the Windows cert store on newer Node; otherwise set
`NODE_EXTRA_CA_CERTS=C:\path\to\ca.pem`.

**Updating**: `git pull` + `npm run build` (option A), or copy a fresh `dist\`
(option B). Your vault is untouched by updates; the index rebuilds itself when
the schema changes.

## Using it

The left rail is the set of panels: Notes, Planning, Projects, Availability, Digest,
Tasks, Tracked, Objects, Jira, Settings, Protected notes. Two things work the same
everywhere:

**Find (Ctrl+F, also Ctrl+P / Ctrl+K).** One overlay whose sections depend on the
panel you are on. Type, ↑↓ to move, Tab to jump between sections, Enter for the
first action, → for the others, Space to select several where a section allows it,
Esc to back out. Prefixes: `/` this note only, `#` tags, `>` commands.

| Panel | What Find offers |
|---|---|
| Notes | matches in this note (highlighted live), notes by title then body text, create a note, insert a `[[link]]` or wrap the selection, commands |
| Projects | Jira issues to add in bulk (clicking an empty calendar day opens it aimed at that day), epics and labels as project rules, people for the roster |
| Planning | issues with *move to sprint…* / *assign to…* follow-ups, people (jump to row), sprints (filter) |
| Availability | people: jump to their row, add time off or support for today |
| Tracked | items: open the record or its source, filter the list |

**Keys.** `?` (or Ctrl+/) shows the full list, generated from the same registry the
bindings come from. The ones worth knowing:

| Keys | Does |
|---|---|
| Alt+↑ / Alt+↓ | previous / next panel in the rail |
| Alt+Shift+↑ / ↓ | open the note above / below in the sidebar |
| Alt+← / Alt+→ | back / forward through panels and notes (⌘[ / ⌘] on a Mac) |
| Ctrl+D | today's daily note |
| g then n / p / j / a / t / k … | go to Notes / Planning / Projects / Availability / Tasks / Tracked…; g e focuses the editor |
| F3 | next match of the last find, inside the editor |

Bare keys and `g` sequences only fire when you are not typing; modifier chords work
everywhere, including inside the editor.

## Develop

```sh
npm install
npm run check        # lint + typecheck + tests
npm run dev          # server on http://127.0.0.1:4747 (vault = cwd or CORPOBRAIN_VAULT)
npm run dev -w @corpobrain/ui   # vite dev server, proxies /api
npm run build        # -> dist/corpobrain.js, dist/corpobrain-cli.js, dist/ui/
```

## CLI

```
node dist/corpobrain-cli.js <command> [--vault <path>]
  init | index | rebuild | search <q> | backlinks <path> | links [--unresolved]
  tags | jira probe | jira sync [--profile <name>] | mcp | version
```

`mcp` runs a stdio MCP server over the vault for coding agents: read tools plus
allowlisted note writes; edits are proposed on `agent/*` git branches for review.
