/** The OOO / support-rota table and what it does to each sprint. */
import { type AvailabilityEntry, adjustCapacity } from '@corpobrain/core';
import { Hono } from 'hono';
import {
  archiveAvailability,
  readAvailability,
  resolveAvailability,
  saveAvailability,
} from './availability.ts';
import { buildBoard } from './plan-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

export interface AvailabilityRow {
  person: string;
  name: string;
  path: string | null;
  sprint: string;
  ooo: number;
  support: number;
  total: number;
  available: number;
  capacity: number | null;
  adjusted: number | null;
  /** a manual per-sprint override is in force, so the suggestion is not applied */
  overridden: boolean;
}

export interface AvailabilityResponse {
  file: string;
  entries: AvailabilityEntry[];
  warnings: string[];
  unit: string;
  supportFactor: number;
  people: { path: string; name: string }[];
  sprints: string[];
  rows: AvailabilityRow[];
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function availabilityRoutes(v: VaultService): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const board = buildBoard(v);
    const spans = board.sprints.map((s) => ({ name: s.name, start: s.start, end: s.end }));
    const resolved = resolveAvailability(v, spans, board.people);
    const rows: AvailabilityRow[] = [];
    for (const p of board.people) {
      const perSprint = resolved.byPerson.get(p.path);
      if (!perSprint) continue;
      for (const s of spans) {
        const a = perSprint.get(s.name);
        if (!a) continue;
        rows.push({
          person: p.path,
          name: p.name,
          path: p.path,
          sprint: s.name,
          ooo: a.ooo,
          support: a.support,
          total: a.total,
          available: a.available,
          capacity: p.capacity,
          adjusted: p.capacity === null ? null : adjustCapacity(p.capacity, a),
          overridden: p.overrides[s.name] !== undefined,
        });
      }
    }
    const body: AvailabilityResponse = {
      file: v.config.availability.file,
      entries: readAvailability(v).entries,
      warnings: resolved.warnings,
      unit: board.unit,
      supportFactor: v.config.availability.supportFactor,
      people: board.people.map((p) => ({ path: p.path, name: p.name })),
      sprints: spans.map((s) => s.name),
      rows: rows.sort((a, b) => a.sprint.localeCompare(b.sprint) || a.name.localeCompare(b.name)),
    };
    return c.json(body);
  });

  /** Replace the whole table; the note keeps everything around it. */
  app.put('/', async (c) => {
    const body = (await c.req.json()) as { entries?: unknown };
    if (!Array.isArray(body.entries)) throw new HttpError(400, 'entries must be an array');
    const entries: AvailabilityEntry[] = [];
    for (const raw of body.entries) {
      const e = raw as Record<string, unknown>;
      const person = typeof e.person === 'string' ? e.person.trim() : '';
      if (!person) throw new HttpError(400, 'every row needs a person');
      if (!isDate(e.from)) throw new HttpError(400, `"${person}": from must be YYYY-MM-DD`);
      const to = isDate(e.to) ? e.to : e.from;
      if (to < e.from) throw new HttpError(400, `"${person}": ${to} is before ${e.from}`);
      entries.push({
        person,
        from: e.from,
        to,
        kind: e.kind === 'support' ? 'support' : 'ooo',
        note: typeof e.note === 'string' ? e.note : '',
      });
    }
    const file = saveAvailability(v, entries);
    return c.json({ ok: true, file, count: entries.length });
  });

  /** Move entries older than `months` (default 3) into per-year archive notes. */
  app.post('/archive', async (c) => {
    let months = 3;
    try {
      const body = (await c.req.json()) as { months?: number };
      if (body.months !== undefined) {
        if (!(Number(body.months) > 0) || Number(body.months) > 60)
          throw new HttpError(400, 'months must be between 1 and 60');
        months = Number(body.months);
      }
    } catch (e) {
      if (e instanceof HttpError) throw e; // empty body is fine
    }
    return c.json({ ok: true, ...archiveAvailability(v, months) });
  });

  // Accepting a suggestion is just a capacity override: PUT /api/plan/person.
  return app;
}
