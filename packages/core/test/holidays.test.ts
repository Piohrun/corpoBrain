import { describe, expect, it } from 'vitest';
import { type AvailabilityEntry, absencesBySprint } from '../src/availability.ts';
import {
  BUILTIN_HOLIDAYS,
  normalizeCountry,
  parseHolidays,
  replaceHolidaysTable,
} from '../src/holidays.ts';

describe('parseHolidays', () => {
  it('reads country, inclusive dates and names', () => {
    const doc =
      '| Country | From | To | Name |\n| --- | --- | --- | --- |\n| Poland | 2026-11-11 |  | Independence Day |\n| China | 2026-10-01 | 2026-10-07 | National Day |\n';
    const { entries, warnings } = parseHolidays(doc);
    expect(warnings).toEqual([]);
    expect(entries).toEqual([
      { country: 'Poland', from: '2026-11-11', to: '2026-11-11', name: 'Independence Day' },
      { country: 'China', from: '2026-10-01', to: '2026-10-07', name: 'National Day' },
    ]);
  });

  it('round-trips through the table writer', () => {
    const doc = replaceHolidaysTable('# Holidays\n\nprose stays\n', [
      { country: 'UK', from: '2026-12-25', to: '2026-12-25', name: 'Christmas' },
    ]);
    expect(doc).toContain('prose stays');
    expect(parseHolidays(doc).entries).toHaveLength(1);
    expect(replaceHolidaysTable(doc, parseHolidays(doc).entries)).toBe(doc);
  });
});

describe('normalizeCountry', () => {
  it('maps the usual aliases onto one key', () => {
    for (const [raw, want] of [
      ['United Kingdom', 'uk'],
      ['GB', 'uk'],
      ['US', 'usa'],
      ['United States', 'usa'],
      ['polska', 'poland'],
      ['CN', 'china'],
      ['France', 'france'],
    ] as const) {
      expect(normalizeCountry(raw)).toBe(want);
    }
  });
});

describe('holiday absences', () => {
  const SPRINTS = [{ name: 'S1', start: '2026-08-31T00:00:00Z', end: '2026-09-11T00:00:00Z' }];
  it('counts once with leave > holiday > support precedence', () => {
    const entries: AvailabilityEntry[] = [
      { person: 'p', from: '2026-09-01', to: '2026-09-02', kind: 'holiday', note: 'bank' },
      { person: 'p', from: '2026-09-02', to: '2026-09-03', kind: 'ooo', note: 'leave' },
      { person: 'p', from: '2026-09-01', to: '2026-09-04', kind: 'support', note: '' },
    ];
    const a = absencesBySprint(entries, SPRINTS).get('p')?.get('S1');
    // day1 holiday, day2+3 ooo, day4 support = 4 away days total
    expect(a).toMatchObject({ ooo: 2, holiday: 1, support: 1, available: 6 });
  });
});

describe('BUILTIN_HOLIDAYS', () => {
  it('covers all six countries across 2026 and 2027 with sane dates', () => {
    const byCountry = new Map<string, number>();
    for (const h of BUILTIN_HOLIDAYS) {
      expect(h.from <= h.to).toBe(true);
      expect(h.from >= '2026-01-01' && h.to <= '2027-12-31').toBe(true);
      byCountry.set(h.country, (byCountry.get(h.country) ?? 0) + 1);
    }
    for (const c of ['China', 'India', 'Poland', 'UK', 'USA', 'Canada']) {
      expect(byCountry.get(c) ?? 0).toBeGreaterThanOrEqual(10);
    }
  });
});
