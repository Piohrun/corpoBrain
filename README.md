# corpoBrain

Local-first second brain for engineering managers: Markdown notes with wikilinks and
backlinks, a read-only Jira mirror, and a team-bandwidth planning workbench. Runs
entirely on `127.0.0.1` from a folder you can copy to a locked-down laptop.

- Plan: [docs/PLAN.md](docs/PLAN.md)
- Vault format contract: [docs/SPEC.md](docs/SPEC.md)

## Develop

```sh
npm install
npm run check        # lint + typecheck + tests
npm run dev          # server on http://127.0.0.1:4747
npm run dev -w @corpobrain/ui   # vite dev server, proxies /api
```

## Ship to a laptop

```sh
npm run build        # -> dist/corpobrain.js, dist/corpobrain-cli.js, dist/ui/
```

Copy `dist/` and run `node corpobrain.js`. No `node_modules`, no native addons.
