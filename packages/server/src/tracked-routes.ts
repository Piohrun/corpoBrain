/** Evidence-backed commitments, decisions, risks, and assumptions. */
import { generateUlid, parseFrontmatter, setFrontmatterKey } from '@corpobrain/core';
import { Hono } from 'hono';
import { HttpError, type VaultService } from './vault-service.ts';

const TRACK_KINDS = ['commitment', 'decision', 'risk', 'assumption'] as const;
type TrackKind = (typeof TRACK_KINDS)[number];
type SourceState = 'unchanged' | 'edited' | 'removed' | 'missing' | 'unanchored';

const INITIAL_STATUS: Record<TrackKind, string> = {
  commitment: 'open',
  decision: 'active',
  risk: 'open',
  assumption: 'active',
};

interface TrackRange {
  id: string;
  kind: TrackKind;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  content: string;
}

const TRACK_RANGE =
  /<!--\s*cb-track:([0-9A-Z]+):(commitment|decision|risk|assumption)\s*-->([\s\S]*?)<!--\s*\/cb-track:\1\s*-->/gi;

function isTrackKind(value: unknown): value is TrackKind {
  return typeof value === 'string' && TRACK_KINDS.includes(value as TrackKind);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanEvidence(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function titleOf(statement: string): string {
  const plain = statement
    .replace(/^\s*[-*+>]\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 100 ? `${plain.slice(0, 97).trimEnd()}…` : plain;
}

function slugOf(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'item'
  );
}

function sourceTarget(path: string): string {
  return path.replace(/\.md$/i, '');
}

function evidenceQuote(excerpt: string): string {
  return excerpt
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function openMarker(id: string, kind: TrackKind): string {
  return `<!-- cb-track:${id}:${kind} -->`;
}

function closeMarker(id: string): string {
  return `<!-- /cb-track:${id} -->`;
}

function trackRanges(content: string): TrackRange[] {
  const ranges: TrackRange[] = [];
  TRACK_RANGE.lastIndex = 0;
  for (let match = TRACK_RANGE.exec(content); match; match = TRACK_RANGE.exec(content)) {
    const whole = match[0];
    const evidence = match[3];
    if (!whole || evidence === undefined || !isTrackKind(match[2])) continue;
    const openEnd = whole.indexOf('-->') + 3;
    const closeStart = whole.lastIndexOf('<!--');
    ranges.push({
      id: match[1] as string,
      kind: match[2],
      from: match.index,
      to: match.index + whole.length,
      contentFrom: match.index + openEnd,
      contentTo: match.index + closeStart,
      content: evidence,
    });
  }
  return ranges;
}

function rangeFor(content: string, id: string): TrackRange | null {
  return trackRanges(content).find((range) => range.id.toLowerCase() === id.toLowerCase()) ?? null;
}

/**
 * Block syntax at the start of a line: list bullets and numbers, task boxes,
 * heading hashes, blockquote chevrons. A marker in front of these would turn
 * the line into a paragraph for every Markdown parser, so an anchor that
 * starts on such a line starts after the syntax instead.
 */
const BLOCK_PREFIX = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+|>[ \t]+)/;

export function pastBlockSyntax(content: string, from: number): number {
  const lineStart = content.lastIndexOf('\n', from - 1) + 1;
  const lineEnd = content.indexOf('\n', lineStart);
  const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
  const m = BLOCK_PREFIX.exec(line);
  const prefixEnd = lineStart + (m ? m[0].length : 0);
  return from < prefixEnd ? prefixEnd : from;
}

/**
 * Where a record's evidence lives now. The index knows every anchor by id,
 * so a source note that was renamed or moved is still found; without an
 * anchor, fall back to the recorded path, then to resolving the [[source]]
 * link the way the editor would.
 */
function locateSource(
  v: VaultService,
  fm: Record<string, unknown>,
  trackId: string | null,
): { path: string | null; anchor: { line: number; content: string } | null } {
  if (trackId) {
    const row = v.indexer.db
      .prepare('SELECT path, line, content FROM track_anchors WHERE id = ? LIMIT 1')
      .get(trackId.toUpperCase()) as { path: string; line: number; content: string } | undefined;
    if (row) return { path: row.path, anchor: { line: row.line, content: row.content } };
  }
  const exists = (path: string) =>
    v.indexer.db.prepare('SELECT 1 FROM notes WHERE path = ?').get(path) !== undefined;
  const recorded = stringValue(fm.source_path);
  if (recorded && exists(recorded)) return { path: recorded, anchor: null };
  const link = stringValue(fm.source);
  const target = link ? /^\[\[([^\]|#]+)/.exec(link)?.[1]?.trim() : null;
  if (target) {
    const r = v.resolve(target);
    if (r.exists) return { path: r.path, anchor: null };
  }
  return { path: recorded, anchor: null };
}

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function nearestOccurrence(content: string, excerpt: string, preferredLine: number): number | null {
  let best: { at: number; distance: number } | null = null;
  for (let at = content.indexOf(excerpt); at >= 0; at = content.indexOf(excerpt, at + 1)) {
    const distance = Math.abs(lineAt(content, at) - preferredLine);
    if (!best || distance < best.distance) best = { at, distance };
  }
  return best?.at ?? null;
}

function insertMarkers(
  content: string,
  from: number,
  to: number,
  id: string,
  kind: TrackKind,
): string {
  if (trackRanges(content).some((range) => from < range.to && to > range.from))
    throw new HttpError(409, 'tracked evidence cannot overlap another tracked passage');
  return `${content.slice(0, from)}${openMarker(id, kind)}${content.slice(from, to)}${closeMarker(id)}${content.slice(to)}`;
}

export function trackedRoutes(v: VaultService): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const rows = v.indexer.db
      .prepare(
        `SELECT path, title, type, mtime, frontmatter_json
         FROM notes
         WHERE type IN ('commitment', 'decision', 'risk', 'assumption')
           AND protected = 0
         ORDER BY mtime DESC, title COLLATE NOCASE`,
      )
      .all() as {
      path: string;
      title: string;
      type: TrackKind;
      mtime: number;
      frontmatter_json: string;
    }[];

    const sourceMeta = v.indexer.db.prepare('SELECT title, mtime FROM notes WHERE path = ?');
    // sources without an anchor are read at most once per request
    const contentCache = new Map<string, string | null>();
    const contentOf = (path: string): string | null => {
      if (!contentCache.has(path)) {
        try {
          contentCache.set(path, v.read(path).content);
        } catch {
          contentCache.set(path, null);
        }
      }
      return contentCache.get(path) ?? null;
    };
    return c.json(
      rows.map((row) => {
        const fm = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
        const original = stringValue(fm.excerpt) ?? '';
        const explicitTrackId = stringValue(fm.track_id);
        const trackId = explicitTrackId ?? stringValue(fm.id);
        const originalLine =
          typeof fm.source_line === 'number' && Number.isInteger(fm.source_line)
            ? fm.source_line
            : null;
        const located = locateSource(v, fm, trackId);
        const sourcePath = located.path;
        const source = sourcePath
          ? (sourceMeta.get(sourcePath) as { title: string; mtime: number } | undefined)
          : undefined;
        let sourceState: SourceState = 'missing';
        let currentExcerpt: string | null = null;
        let currentLine: number | null = null;
        if (located.anchor) {
          currentExcerpt = located.anchor.content;
          currentLine = located.anchor.line;
          sourceState =
            currentExcerpt === ''
              ? 'removed'
              : currentExcerpt === cleanEvidence(original)
                ? 'unchanged'
                : 'edited';
        } else if (sourcePath && original && !explicitTrackId) {
          const content = contentOf(sourcePath);
          const occurrence =
            content === null ? null : nearestOccurrence(content, original, originalLine ?? 1);
          if (content !== null && occurrence !== null) {
            sourceState = 'unanchored';
            currentExcerpt = original;
            currentLine = lineAt(content, occurrence);
          }
        }
        return {
          path: row.path,
          title: row.title,
          kind: row.type,
          mtime: row.mtime,
          status: stringValue(fm.status) ?? INITIAL_STATUS[row.type],
          owner: stringValue(fm.owner),
          due: stringValue(fm.due),
          review: stringValue(fm.review),
          created: stringValue(fm.created),
          trackId,
          sourcePath,
          sourceTitle: source?.title ?? sourcePath,
          sourceLine: originalLine,
          currentLine,
          sourceMtime: source?.mtime ?? null,
          sourceState,
          excerpt: original,
          currentExcerpt,
        };
      }),
    );
  });

  app.post('/', async (c) => {
    const body = (await c.req.json()) as {
      kind?: unknown;
      statement?: unknown;
      excerpt?: unknown;
      sourcePath?: unknown;
      sourceLine?: unknown;
      sourceFrom?: unknown;
      sourceTo?: unknown;
      owner?: unknown;
      date?: unknown;
    };
    if (!isTrackKind(body.kind))
      throw new HttpError(400, 'kind must be commitment, decision, risk, or assumption');
    const statement = stringValue(body.statement);
    const selected = stringValue(body.excerpt);
    const sourcePath = stringValue(body.sourcePath);
    if (!statement || !selected || !sourcePath)
      throw new HttpError(400, 'statement, excerpt, and sourcePath are required');
    if (statement.length > 2_000 || selected.length > 4_000)
      throw new HttpError(400, 'tracked text is too long');
    if (
      typeof body.sourceLine !== 'number' ||
      !Number.isInteger(body.sourceLine) ||
      body.sourceLine < 1
    )
      throw new HttpError(400, 'sourceLine must be a positive integer');
    if (
      typeof body.sourceFrom !== 'number' ||
      !Number.isInteger(body.sourceFrom) ||
      body.sourceFrom < 0 ||
      typeof body.sourceTo !== 'number' ||
      !Number.isInteger(body.sourceTo) ||
      body.sourceTo <= body.sourceFrom
    )
      throw new HttpError(400, 'sourceFrom and sourceTo must describe the selected range');
    const owner = stringValue(body.owner);
    if (owner && owner.length > 200) throw new HttpError(400, 'owner is too long');
    const date = stringValue(body.date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new HttpError(400, 'date must be YYYY-MM-DD');

    const source = v.read(sourcePath);
    const lineCount = source.content.split(/\r?\n/).length;
    if (body.sourceLine > lineCount) throw new HttpError(409, 'source line no longer exists');
    if (
      body.sourceTo > source.content.length ||
      source.content.slice(body.sourceFrom, body.sourceTo) !== body.excerpt
    )
      throw new HttpError(409, 'selected evidence no longer matches the source note');
    // never wrap list/heading/quote syntax: the anchor starts after it
    const anchorFrom = pastBlockSyntax(source.content, body.sourceFrom);
    if (anchorFrom >= body.sourceTo)
      throw new HttpError(400, 'select some text after the list or heading marker');
    const excerpt = cleanEvidence(source.content.slice(anchorFrom, body.sourceTo));
    if (!excerpt) throw new HttpError(400, 'selected evidence is empty');

    const title = titleOf(statement);
    if (!title) throw new HttpError(400, 'statement has no visible text');
    const id = generateUlid();
    const path = `tracked/${body.kind}-${slugOf(title)}-${id.toLowerCase()}.md`;
    const created = new Date().toISOString();
    const target = sourceTarget(source.path);
    const dateKey = body.kind === 'commitment' ? 'due' : 'review';
    const fields = [
      `id: ${id}`,
      `type: ${body.kind}`,
      `title: ${JSON.stringify(title)}`,
      `status: ${INITIAL_STATUS[body.kind]}`,
      `created: ${JSON.stringify(created)}`,
      `track_id: ${id}`,
      `source: ${JSON.stringify(`[[${target}]]`)}`,
      `source_path: ${JSON.stringify(source.path)}`,
      `source_line: ${body.sourceLine}`,
      `excerpt: ${JSON.stringify(excerpt)}`,
    ];
    if (owner) fields.push(`owner: ${JSON.stringify(owner)}`);
    if (date) fields.push(`${dateKey}: ${JSON.stringify(date)}`);
    const content = `---\n${fields.join('\n')}\n---\n\n# ${title}\n\n> [!quote] Original evidence\n> [[${target}]] · line ${body.sourceLine}\n>\n${evidenceQuote(excerpt)}\n\n## Notes\n\n`;
    const sourceContent = insertMarkers(source.content, anchorFrom, body.sourceTo, id, body.kind);
    v.write(source.path, sourceContent);
    try {
      v.create(path, title, content, body.kind);
    } catch (error) {
      v.write(source.path, source.content);
      throw error;
    }
    return c.json(
      {
        path,
        title,
        kind: body.kind,
        status: INITIAL_STATUS[body.kind],
        trackId: id,
        sourceContent,
      },
      201,
    );
  });

  /** Upgrade a pre-anchor record when its original evidence still exists. */
  app.post('/anchor', async (c) => {
    const body = (await c.req.json()) as { path?: unknown };
    const path = stringValue(body.path);
    if (!path) throw new HttpError(400, 'path required');
    const record = v.read(path);
    const parsed = parseFrontmatter(record.content);
    if (parsed.error) throw new HttpError(409, 'tracked record frontmatter cannot be parsed');
    const kind = parsed.data.type;
    if (!isTrackKind(kind)) throw new HttpError(400, 'path is not a tracked record');
    const excerpt = stringValue(parsed.data.excerpt);
    const trackId =
      stringValue(parsed.data.track_id) ?? stringValue(parsed.data.id) ?? generateUlid();
    const sourcePath = locateSource(v, parsed.data, trackId).path;
    if (!sourcePath || !excerpt) throw new HttpError(409, 'tracked record has no source evidence');
    const preferredLine = typeof parsed.data.source_line === 'number' ? parsed.data.source_line : 1;
    const source = v.read(sourcePath);
    const existing = rangeFor(source.content, trackId);
    if (existing)
      return c.json({
        sourcePath: source.path,
        sourceContent: source.content,
        trackId,
      });
    const at = nearestOccurrence(source.content, excerpt, preferredLine);
    if (at === null) throw new HttpError(409, 'original evidence no longer exists in the source');
    const from = pastBlockSyntax(source.content, at);
    const to = at + excerpt.length;
    if (from >= to) throw new HttpError(409, 'original evidence is only list or heading syntax');
    const sourceContent = insertMarkers(source.content, from, to, trackId, kind);
    v.write(source.path, sourceContent);
    const anchored = cleanEvidence(source.content.slice(from, to));
    v.patchNote(path, (text) => {
      let next = text;
      if (stringValue(parsed.data.track_id) !== trackId)
        next = setFrontmatterKey(next, 'track_id', trackId);
      if (source.path !== stringValue(parsed.data.source_path))
        next = setFrontmatterKey(next, 'source_path', source.path);
      if (anchored !== excerpt) next = setFrontmatterKey(next, 'excerpt', anchored);
      return next;
    });
    return c.json({ sourcePath: source.path, sourceContent, trackId });
  });

  return app;
}
