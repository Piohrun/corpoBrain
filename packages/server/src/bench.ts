/**
 * corpoBrain benchmark: how fast is this app on THIS machine with THIS vault?
 *
 *   node dist\corpobrain-bench.js --vault %USERPROFILE%\corpobrain-vault
 *   npm run bench -- --vault ~/corpobrain-vault            (from a checkout)
 *
 * Read-only for the vault: everything runs on a temporary copy (without .git,
 * .trash, private notes, the index and secrets), which is deleted afterwards.
 * The report holds only counts and timings — no titles, paths or text — so it
 * can be shared as is.
 *
 * Options:
 *   --runs N        repetitions per measurement (default 7)
 *   --with-jira     also time a full Jira sync INTO THE COPY (reads Jira only;
 *                   uses the vault's Jira settings and token)
 *   --out FILE      where to write the JSON report (default: current folder)
 *   --keep          keep the temporary copy (for inspection)
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { loadConfig } from '@corpobrain/core';
import { createApp } from './app.ts';
import { syncService } from './jira-sync-service.ts';
import { VaultService } from './vault-service.ts';

// ------------------------------------------------------------------ options

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const vaultArg =
  option('vault') ?? process.env.CORPOBRAIN_VAULT ?? argv.find((a) => !a.startsWith('--'));
if (!vaultArg || flag('help')) {
  console.log(
    'usage: corpobrain-bench --vault <path> [--runs N] [--with-jira] [--out file] [--keep]',
  );
  process.exit(vaultArg ? 0 : 1);
}
const source = resolve(vaultArg);
if (!existsSync(join(source, '.corpobrain'))) {
  console.error(`not a corpoBrain vault (no .corpobrain folder): ${source}`);
  process.exit(1);
}
const RUNS = Math.max(3, Number(option('runs') ?? 7) || 7);

// ------------------------------------------------------------------ helpers

const ms = (n: number) => Math.round(n * 10) / 10;
const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
interface Timing {
  first: number;
  median: number;
  p90: number;
  max: number;
  kb?: number;
  n: number;
}
function summarize(times: number[], kb?: number): Timing {
  const [first = 0] = times;
  const sorted = [...times].sort((a, b) => a - b);
  return {
    first: ms(first),
    median: ms(percentile(sorted, 0.5)),
    p90: ms(percentile(sorted, 0.9)),
    max: ms(sorted.at(-1) ?? 0),
    ...(kb !== undefined ? { kb } : {}),
    n: times.length,
  };
}
const log = (line: string) => process.stdout.write(`${line}\n`);

/** Error text without the Jira address, so the report stays shareable. */
function scrubJira(message: string): string {
  let out = message;
  const base = loadConfig(resolve(vaultArg as string), () => {}).jira.baseUrl;
  if (base) {
    out = out.split(base).join('<jira>');
    try {
      const { host, hostname } = new URL(base);
      out = out.split(host).join('<jira>').split(hostname).join('<jira>');
    } catch {
      /* not a URL: the full string was removed above */
    }
  }
  return out;
}

// ------------------------------------------------------------------ copy

const config = loadConfig(source, () => {});
const tmp = mkdtempSync(join(os.tmpdir(), 'corpobrain-bench-'));
const copy = join(tmp, 'vault');
const SKIP_TOP = new Set(['.git', '.trash', 'node_modules', config.folders.private]);
const SKIP_IN_CB = /^\.corpobrain[\\/](index\.sqlite.*|secrets\.json)$/;
let copiedFiles = 0;
let copiedBytes = 0;
const cleanup = () => {
  if (!flag('keep')) rmSync(tmp, { recursive: true, force: true });
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

const report: Record<string, unknown> = {
  version: 1,
  at: new Date().toISOString(),
  machine: {
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1e9),
  },
};

try {
  log(`corpoBrain benchmark — your vault is only read; work happens in a temporary copy`);
  let t = performance.now();
  cpSync(source, copy, {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => {
      const rel = relative(source, src);
      if (!rel) return true;
      const top = rel.split(sep)[0] as string;
      if (SKIP_TOP.has(top) || SKIP_IN_CB.test(rel)) return false;
      try {
        const st = statSync(src);
        if (st.isFile()) {
          copiedFiles++;
          copiedBytes += st.size;
        }
      } catch {
        return false;
      }
      return true;
    },
  });
  report.copy = { files: copiedFiles, mb: ms(copiedBytes / 1e6), ms: ms(performance.now() - t) };
  log(
    `copied ${copiedFiles} files (${ms(copiedBytes / 1e6)} MB) in ${Math.round(performance.now() - t)} ms`,
  );

  // ---------------------------------------------------------------- index
  const dbPath = join(tmp, 'index.sqlite');
  t = performance.now();
  let v = new VaultService(copy, dbPath);
  const cold = {
    ms: v.startup.ms,
    notes: v.startup.summary.indexed.length,
    idsAssigned: v.startup.summary.idsAssigned,
  };
  v.stop();
  t = performance.now();
  v = new VaultService(copy, dbPath);
  const warm = { ms: v.startup.ms, totalMs: ms(performance.now() - t) };
  report.index = { cold, warm };
  log(`index: full build ${cold.ms} ms (${cold.notes} notes), warm start ${warm.ms} ms`);

  // ---------------------------------------------------------------- shape
  const db = v.indexer.db;
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const byType = Object.fromEntries(
    (
      db.prepare('SELECT type, COUNT(*) AS n FROM notes GROUP BY type ORDER BY n DESC').all() as {
        type: string;
        n: number;
      }[]
    ).map((r) => [r.type, r.n]),
  );
  const notes = db
    .prepare('SELECT path, type, size FROM notes WHERE protected = 0 ORDER BY path')
    .all() as {
    path: string;
    type: string;
    size: number;
  }[];
  const linksPerNote = db
    .prepare(
      'SELECT src_path AS path, COUNT(*) AS n FROM links GROUP BY src_path ORDER BY n DESC LIMIT 1',
    )
    .get() as { path: string; n: number } | undefined;
  const sizes = notes.map((n) => n.size).sort((a, b) => a - b);
  report.vault = {
    notes: notes.length,
    byType,
    links: one('SELECT COUNT(*) AS n FROM links'),
    tasks: one('SELECT COUNT(*) AS n FROM tasks'),
    jiraIssues: one('SELECT COUNT(*) AS n FROM jira'),
    transitions: one('SELECT COUNT(*) AS n FROM transitions'),
    people: one('SELECT COUNT(*) AS n FROM people'),
    sprints: one('SELECT COUNT(*) AS n FROM sprints'),
    noteKb: {
      median: ms(percentile(sizes, 0.5) / 1024),
      p99: ms(percentile(sizes, 0.99) / 1024),
      max: ms((sizes.at(-1) ?? 0) / 1024),
    },
    maxLinksInOneNote: linksPerNote?.n ?? 0,
  };

  // ---------------------------------------------------------------- endpoints
  const app = createApp(v);
  const call = async (url: string, init?: RequestInit) => {
    const s = performance.now();
    const res = await app.request(url, init);
    const body = await res.arrayBuffer();
    return {
      ms: performance.now() - s,
      kb: Math.round(body.byteLength / 1024),
      status: res.status,
    };
  };
  const timed = async (url: string, runs = RUNS): Promise<Timing | { error: number }> => {
    const times: number[] = [];
    let kb = 0;
    for (let i = 0; i < runs; i++) {
      const r = await call(url);
      if (r.status >= 400) return { error: r.status };
      times.push(r.ms);
      kb = r.kb;
    }
    return summarize(times, kb);
  };
  /** one request per sample item; the label never contains the item */
  const sampled = async (urls: string[]): Promise<Timing | null> => {
    if (!urls.length) return null;
    const times: number[] = [];
    for (const url of urls) {
      const r = await call(url);
      if (r.status < 400) times.push(r.ms);
    }
    return times.length ? summarize(times) : null;
  };
  const every = <T>(list: T[], count: number) =>
    list.length <= count
      ? list
      : Array.from({ length: count }, (_, i) => list[Math.floor((i * list.length) / count)] as T);
  const enc = encodeURIComponent;

  const endpoints: Record<string, unknown> = {};
  for (const [label, url] of [
    ['notes list', '/api/notes'],
    ['notes tree', '/api/tree'],
    ['tags', '/api/tags'],
    ['tasks (open)', '/api/tasks?done=false'],
    ['tasks (all)', '/api/tasks'],
    ['unresolved links', '/api/unresolved'],
    ['planning board', '/api/plan/board'],
    ['sprint health', '/api/plan/health'],
    ['organization', '/api/organization'],
    ['projects', '/api/projects'],
    ['availability', '/api/availability'],
    ['what changed', '/api/digest'],
    ['flow stats', '/api/flow/stats'],
    ['jira issues', '/api/jira/issues'],
    ['tracked', '/api/tracked'],
    ['object types', '/api/objects/types'],
  ] as const) {
    endpoints[label] = await timed(url);
    log(`  ${label.padEnd(18)} ${JSON.stringify(endpoints[label])}`);
  }

  const regular = notes.filter((n) => n.type !== 'jira');
  const sample = every(regular, 30);
  const largest = [...notes].sort((a, b) => b.size - a.size).slice(0, 5);
  const mostLinked = db
    .prepare(
      'SELECT dst_path AS path FROM links WHERE dst_path IS NOT NULL GROUP BY dst_path ORDER BY COUNT(*) DESC LIMIT 5',
    )
    .all() as { path: string }[];
  const people = (db.prepare('SELECT path FROM people').all() as { path: string }[]).map(
    (p) => p.path,
  );
  const projects = notes.filter((n) => n.type === 'project').map((n) => n.path);
  const words = sample
    .map((n) =>
      basename(n.path, '.md')
        .split(/[^A-Za-z]+/)
        .find((w) => w.length >= 5),
    )
    .filter((w): w is string => !!w)
    .slice(0, 10);
  const perItem: Record<string, Timing | null> = {
    'open a note': await sampled(sample.map((n) => `/api/note?path=${enc(n.path)}`)),
    'open a note + context': await sampled(
      sample.map((n) => `/api/note?path=${enc(n.path)}&context=true`),
    ),
    'open the largest notes': await sampled(
      largest.map((n) => `/api/note?path=${enc(n.path)}&context=true`),
    ),
    'backlinks (most linked)': await sampled(
      mostLinked.map((n) => `/api/backlinks?path=${enc(n.path)}`),
    ),
    'person overview': await sampled(every(people, 10).map((p) => `/api/person?path=${enc(p)}`)),
    'project timeline': await sampled(
      every(projects, 5).map((p) => `/api/projects/timeline?path=${enc(p)}`),
    ),
    search: await sampled(words.map((w) => `/api/search?q=${enc(w)}`)),
  };
  report.endpoints = endpoints;
  report.perItem = perItem;
  for (const [label, timing] of Object.entries(perItem))
    log(`  ${label.padEnd(24)} ${JSON.stringify(timing)}`);

  // ---------------------------------------------------------------- saves
  const saveOf = async (path: string) => {
    const content = readFileSync(join(copy, path), 'utf8');
    return (
      await call('/api/note', {
        method: 'PUT',
        body: JSON.stringify({ path, content: `${content}\nbenchmark edit\n` }),
      })
    ).ms;
  };
  const saves: number[] = [];
  for (const n of every(regular, 20)) saves.push(await saveOf(n.path));
  const bigSaves: number[] = [];
  for (const n of largest.filter((x) => x.type !== 'jira').slice(0, 3))
    bigSaves.push(await saveOf(n.path));
  // the board right after a save of a planning note (Jira or person) is rebuilt
  const planningNote = notes.find((n) => n.type === 'person' || n.type === 'jira');
  let boardAfterPlanningSave: number | null = null;
  if (planningNote) {
    await saveOf(planningNote.path);
    boardAfterPlanningSave = ms((await call('/api/plan/board')).ms);
  }
  report.saves = {
    note: summarize(saves),
    largestNotes: bigSaves.length ? summarize(bigSaves) : null,
    boardAfterPlanningSave,
  };
  log(`  save a note             ${JSON.stringify(summarize(saves))}`);

  // ---------------------------------------------------------------- jira
  if (flag('with-jira')) {
    if (!config.jira.baseUrl || !config.jira.profiles.length)
      report.jira = { skipped: 'Jira is not configured' };
    else {
      // the token stays in memory: it is not copied into the temporary vault
      try {
        const secrets = JSON.parse(
          readFileSync(join(source, '.corpobrain', 'secrets.json'), 'utf8'),
        ) as {
          jiraToken?: string;
          jiraEmail?: string;
        };
        if (secrets.jiraToken && !process.env.CORPOBRAIN_JIRA_TOKEN)
          process.env.CORPOBRAIN_JIRA_TOKEN = secrets.jiraToken;
        if (secrets.jiraEmail && !process.env.CORPOBRAIN_JIRA_EMAIL)
          process.env.CORPOBRAIN_JIRA_EMAIL = secrets.jiraEmail;
      } catch {
        /* the env vars may already be set */
      }
      log('jira: full sync into the copy (this reads Jira; it can take a while)…');
      const s = performance.now();
      const service = syncService(v);
      try {
        const reports = await service.start(undefined, true).completion;
        const run = service.history[0];
        report.jira = {
          ms: ms(performance.now() - s),
          retries: run?.retries ?? 0,
          profiles: reports.map((r) => ({
            fetched: r.fetched,
            created: r.created.length,
            updated: r.updated.length,
            unchanged: r.unchanged,
            sprints: r.sprints,
            warnings: r.warnings.length,
          })),
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        report.jira = {
          ms: ms(performance.now() - s),
          error: scrubJira(message),
        };
      }
      log(`  jira sync ${JSON.stringify(report.jira)}`);
    }
  }

  const mem = process.memoryUsage();
  report.memoryMb = { rss: Math.round(mem.rss / 1e6), heapUsed: Math.round(mem.heapUsed / 1e6) };
  v.stop();

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const out = resolve(option('out') ?? `corpobrain-bench-${stamp}.json`);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  log(`\nreport: ${out}`);
  log('nothing in your vault was changed; the report contains only counts and timings.');
} finally {
  cleanup();
}
