/**
 * Images in notes: pasted or dropped images are saved under the attachments
 * folder, `![[name.png]]` / `![](path)` are resolved like Obsidian does, and
 * files are served with a sandboxing CSP so an image can never run script
 * in the app's origin (an SVG opened directly included).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, posix } from 'node:path';
import { Hono } from 'hono';
import { HttpError, type VaultService } from './vault-service.ts';

export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};
/** what may be uploaded: raster formats only (an uploaded SVG is a script carrier) */
const UPLOAD_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const MAX_UPLOAD = 25 * 1024 * 1024;

const isImage = (path: string) => extname(path).toLowerCase() in IMAGE_TYPES;

/** `Pasted image 20261007153012.png`, like Obsidian, in local time */
function pastedName(ext: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `Pasted image ${stamp}${ext}`;
}

/** a file name that is safe on Windows and in a wikilink */
function cleanName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
}

/** Every image in the vault by lower-case file name (for `![[name.png]]`). */
const nameIndex = new WeakMap<VaultService, { at: number; byName: Map<string, string[]> }>();
function imagesByName(v: VaultService, fresh = false): Map<string, string[]> {
  const hit = nameIndex.get(v);
  if (hit && !fresh) return hit.byName;
  const byName = new Map<string, string[]>();
  const skip = new Set([v.config.folders.private.toLowerCase()]);
  const walk = (rel: string, depth: number) => {
    if (depth > 12) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(join(v.root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!(rel === '' && skip.has(e.name.toLowerCase()))) walk(path, depth + 1);
      } else if (isImage(e.name)) {
        const key = e.name.toLowerCase();
        byName.set(key, [...(byName.get(key) ?? []), path]);
      }
    }
  };
  walk('', 0);
  nameIndex.set(v, { at: Date.now(), byName });
  return byName;
}

/**
 * Where an image reference in `from` points: a path relative to the note,
 * then to the vault root, then (bare names) the attachments folder, the
 * note's folder, and finally any image of that name in the vault.
 */
export function resolveImage(v: VaultService, ref: string, from: string | null): string | null {
  let target = ref.trim().replace(/\\/g, '/');
  try {
    target = decodeURIComponent(target);
  } catch {
    /* not URI-encoded */
  }
  target = target.replace(/^<|>$/g, '').replace(/^\.\//, '');
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || !isImage(target)) return null;
  const exists = (p: string) => {
    try {
      const safe = v.safePath(p);
      return existsSync(join(v.root, safe)) ? safe : null;
    } catch {
      return null;
    }
  };
  const noteDir = from ? posix.dirname(from) : '.';
  const candidates = target.includes('/')
    ? [posix.normalize(posix.join(noteDir, target)), posix.normalize(target.replace(/^\/+/, ''))]
    : [`${v.config.folders.attachments}/${target}`, posix.join(noteDir, target), target];
  for (const c of candidates) {
    const hit = c.startsWith('..') ? null : exists(c);
    if (hit) return hit;
  }
  if (target.includes('/')) return null;
  const key = target.toLowerCase();
  let paths = imagesByName(v).get(key);
  // a new image since the last walk: look again, at most every few seconds
  const idx = nameIndex.get(v);
  if (!paths && idx && Date.now() - idx.at > 3000) paths = imagesByName(v, true).get(key);
  return paths?.[0] ?? null;
}

export function attachmentRoutes(v: VaultService): Hono {
  const app = new Hono();

  /** Save a pasted/dropped image; returns the name to embed. */
  app.post('/', async (c) => {
    const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const ext = UPLOAD_TYPES[type];
    if (!ext) throw new HttpError(415, 'only PNG, JPEG, GIF and WebP images can be added');
    const size = Number(c.req.header('content-length') ?? 0);
    if (size > MAX_UPLOAD) throw new HttpError(413, 'images up to 25 MB');
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (!body.length) throw new HttpError(400, 'empty image');
    if (body.length > MAX_UPLOAD) throw new HttpError(413, 'images up to 25 MB');

    const wanted = cleanName(c.req.query('name') ?? '');
    const base = wanted ? `${wanted.replace(/\.[a-z0-9]+$/i, '')}${ext}` : pastedName(ext);
    const folder = v.safePath(v.config.folders.attachments);
    mkdirSync(join(v.root, folder), { recursive: true });
    let name = base;
    for (let i = 2; existsSync(join(v.root, folder, name)); i++)
      name = `${base.slice(0, -ext.length)} ${i}${ext}`;
    writeFileSync(join(v.root, folder, name), body, { flag: 'wx' });
    imagesByName(v, true);
    return c.json({ path: `${folder}/${name}`, name }, 201);
  });

  /** `![[ref]]` / `![](ref)` in note `from` → the image's vault path. */
  app.get('/resolve', (c) => {
    const ref = c.req.query('ref') ?? '';
    const from = c.req.query('from') ?? null;
    const path = resolveImage(v, ref, from);
    if (!path) throw new HttpError(404, `no image "${ref}"`);
    return c.json({ path });
  });

  /** The image bytes; never executable in this origin. */
  app.get('/file', (c) => {
    const path = v.safePath(c.req.query('path') ?? '');
    if (!isImage(path)) throw new HttpError(400, 'not an image');
    const abs = join(v.root, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new HttpError(404, `not found: ${path}`);
    const st = statSync(abs);
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    const headers = {
      'Content-Type': IMAGE_TYPES[extname(path).toLowerCase()] as string,
      'Cache-Control': 'no-cache',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': `inline; filename="${encodeURIComponent(basename(path))}"`,
    };
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
    return c.body(readFileSync(abs), 200, headers);
  });

  return app;
}
