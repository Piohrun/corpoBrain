/** corpobrain CLI: data-layer commands (SPEC Phase 1). */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_CONFIG,
  Indexer,
  loadConfig,
  openDb,
  resetDb,
  SPEC_VERSION,
} from '@corpobrain/core';

const args = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a.startsWith('--')) {
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(a.slice(2), next);
      i++;
    } else flags.set(a.slice(2), 'true');
  } else positional.push(a);
}
const [command = 'help'] = positional;

const vaultRoot = resolve(flags.get('vault') ?? process.env.CORPOBRAIN_VAULT ?? process.cwd());

function withIndexer(): Indexer {
  if (!existsSync(vaultRoot)) {
    console.error(`vault not found: ${vaultRoot}`);
    process.exit(1);
  }
  const config = loadConfig(vaultRoot);
  const db = openDb(join(vaultRoot, '.corpobrain', 'index.sqlite'));
  return new Indexer(vaultRoot, config, db);
}

switch (command) {
  case 'version':
    console.log(`corpobrain spec ${SPEC_VERSION}`);
    break;

  case 'init': {
    mkdirSync(join(vaultRoot, '.corpobrain'), { recursive: true });
    for (const folder of Object.values(DEFAULT_CONFIG.folders))
      mkdirSync(join(vaultRoot, folder), { recursive: true });
    const cfgPath = join(vaultRoot, '.corpobrain', 'config.json');
    if (!existsSync(cfgPath))
      writeFileSync(cfgPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    const gi = join(vaultRoot, '.gitignore');
    if (!existsSync(gi))
      writeFileSync(gi, '.corpobrain/index.sqlite*\n.corpobrain/secrets.json\nprivate/\n');
    console.log(`initialized vault at ${vaultRoot}`);
    break;
  }

  case 'index': {
    const s = withIndexer().update();
    console.log(
      `indexed ${s.indexed.length}, removed ${s.removed.length}, unchanged ${s.unchanged}` +
        (s.idsAssigned ? `, ids assigned ${s.idsAssigned}` : ''),
    );
    break;
  }

  case 'rebuild': {
    const idx = withIndexer();
    resetDb(idx.db);
    const s = idx.rebuild();
    console.log(
      `rebuilt: ${s.indexed.length} notes` +
        (s.idsAssigned ? `, ids assigned ${s.idsAssigned}` : ''),
    );
    break;
  }

  case 'search': {
    const q = positional.slice(1).join(' ');
    if (!q) {
      console.error('usage: corpobrain search <query>');
      process.exit(1);
    }
    for (const hit of withIndexer().search(q, Number(flags.get('limit') ?? 20)))
      console.log(`${hit.path}\t${hit.title}\t${hit.snippet.replace(/\n/g, ' ')}`);
    break;
  }

  case 'backlinks': {
    const target = positional[1];
    if (!target) {
      console.error('usage: corpobrain backlinks <path>');
      process.exit(1);
    }
    for (const b of withIndexer().backlinks(target))
      console.log(`${b.srcPath}:${b.line}\t${b.srcTitle}\t(${b.kind})`);
    break;
  }

  case 'links': {
    const idx = withIndexer();
    if (flags.has('unresolved')) {
      for (const u of idx.unresolved())
        console.log(`${u.srcPath}:${u.line}\t[[${u.target}]]${u.ambiguous ? '\tAMBIGUOUS' : ''}`);
    } else {
      const rows = idx.db
        .prepare('SELECT src_path, dst_target, dst_path, kind FROM links ORDER BY src_path')
        .all() as { src_path: string; dst_target: string; dst_path: string | null; kind: string }[];
      for (const r of rows)
        console.log(`${r.src_path}\t${r.dst_target}\t→ ${r.dst_path ?? '∅'}\t(${r.kind})`);
    }
    break;
  }

  case 'tags': {
    const rows = withIndexer()
      .db.prepare('SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag')
      .all() as { tag: string; n: number }[];
    for (const r of rows) console.log(`${r.n}\t#${r.tag}`);
    break;
  }

  default:
    console.log(`corpobrain <command> [--vault <path>]

Commands:
  init                create vault folders and default config
  index               incremental reindex
  rebuild             drop and rebuild the index
  search <query>      full-text search
  backlinks <path>    list notes linking to <path> (vault-relative, with .md)
  links [--unresolved]  list link table / unresolved links
  tags                tag counts
  version             print spec version
`);
}
