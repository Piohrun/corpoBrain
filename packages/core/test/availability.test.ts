import { describe, expect, it } from 'vitest';
import {
  type AvailabilityEntry,
  absencesBySprint,
  adjustCapacity,
  parseAvailability,
  personCell,
  renderAvailabilityTable,
  replaceAvailabilityTable,
  weekdaysIn,
} from '../src/availability.ts';

const NOTE = `---
type: availability
---

# Availability

Dates are inclusive.

| Person | From | To | Type | Note |
| --- | --- | --- | --- | --- |
| [[Anna Kowalska]] | 2026-09-07 | 2026-09-11 | ooo | annual leave |
| Marek Nowak | 2026-09-14 | 2026-09-18 | support | L2 rota |
| [[John Doe]] | 2026-09-02 |  | ooo | one day |

## Notes below the table survive
`;

describe('parseAvailability', () => {
  it('reads people, inclusive dates, kinds and notes', () => {
    const { entries, warnings } = parseAvailability(NOTE);
    expect(warnings).toEqual([]);
    expect(entries).toEqual([
      {
        person: 'Anna Kowalska',
        from: '2026-09-07',
        to: '2026-09-11',
        kind: 'ooo',
        note: 'annual leave',
      },
      {
        person: 'Marek Nowak',
        from: '2026-09-14',
        to: '2026-09-18',
        kind: 'support',
        note: 'L2 rota',
      },
      { person: 'John Doe', from: '2026-09-02', to: '2026-09-02', kind: 'ooo', note: 'one day' },
    ]);
  });

  it('tolerates spreadsheet dates and reports rows it cannot read', () => {
    const { entries, warnings } = parseAvailability(
      '| Person | From | To | Type |\n| --- | --- | --- | --- |\n| Anna | 07/09/2026 | 08/09/2026 | ooo |\n| Bob | soon | | ooo |\n',
    );
    expect(entries[0]).toMatchObject({ from: '2026-09-07', to: '2026-09-08' });
    expect(warnings[0]).toContain('Bob');
  });

  it('ignores tables inside code fences and unrelated tables', () => {
    const doc =
      '```\n| Person | From | To |\n| --- | --- | --- |\n| Ghost | 2026-01-01 | |\n```\n\n| Key | Value |\n| --- | --- |\n| a | b |\n';
    expect(parseAvailability(doc).entries).toEqual([]);
  });

  it('treats rota wording as support and anything else as time off', () => {
    const doc =
      '| Person | From | To | Type |\n| --- | --- | --- | --- |\n| A | 2026-09-01 | | Support |\n| B | 2026-09-01 | | rota |\n| C | 2026-09-01 | | holiday |\n';
    expect(parseAvailability(doc).entries.map((e) => e.kind)).toEqual([
      'support',
      'support',
      'ooo',
    ]);
  });

  it('unwraps wikilinks and aliases in the person cell', () => {
    expect(personCell('[[Anna Kowalska]]')).toBe('Anna Kowalska');
    expect(personCell('[[people/anna.md|Anna]]')).toBe('people/anna.md');
    expect(personCell('**Bob**')).toBe('Bob');
  });
});

describe('writing the table back', () => {
  it('replaces the table in place and leaves the prose alone', () => {
    const { entries } = parseAvailability(NOTE);
    const next = replaceAvailabilityTable(NOTE, [
      ...entries,
      { person: 'Bob', from: '2026-10-01', to: '2026-10-02', kind: 'ooo', note: '' },
    ]);
    expect(next).toContain('# Availability');
    expect(next).toContain('## Notes below the table survive');
    expect(next).toContain('| [[Bob]] | 2026-10-01 | 2026-10-02 | ooo |  |');
    expect(parseAvailability(next).entries).toHaveLength(4);
    // rewriting is stable
    expect(replaceAvailabilityTable(next, parseAvailability(next).entries)).toBe(next);
  });

  it('appends a table when the note has none', () => {
    const next = replaceAvailabilityTable('# Availability\n\nnothing yet\n', [
      { person: 'Anna', from: '2026-09-07', to: '2026-09-07', kind: 'ooo', note: '' },
    ]);
    expect(next).toContain('nothing yet');
    expect(parseAvailability(next).entries).toHaveLength(1);
  });

  it('escapes pipes in free text', () => {
    const table = renderAvailabilityTable([
      { person: 'Anna', from: '2026-09-07', to: '2026-09-07', kind: 'ooo', note: 'a | b' },
    ]);
    expect(table).toContain('a \\| b');
    expect(parseAvailability(table).entries[0]?.note).toBe('a | b');
  });
});

const SPRINTS = [
  { name: 'Sprint 37', start: '2026-08-31T00:00:00Z', end: '2026-09-11T00:00:00Z' },
  { name: 'Sprint 38', start: '2026-09-14T00:00:00Z', end: '2026-09-25T00:00:00Z' },
];

const entry = (over: Partial<AvailabilityEntry>): AvailabilityEntry => ({
  person: 'Anna',
  from: '2026-09-07',
  to: '2026-09-11',
  kind: 'ooo',
  note: '',
  ...over,
});

describe('absencesBySprint', () => {
  it('counts weekdays only, within the sprint that contains them', () => {
    const a = absencesBySprint([entry({})], SPRINTS);
    expect(a.get('Anna')?.get('Sprint 37')).toEqual({
      ooo: 5,
      support: 0,
      total: 10,
      available: 5,
    });
    expect(a.get('Anna')?.get('Sprint 38')).toBeUndefined();
  });

  it('splits an absence that straddles two sprints', () => {
    const a = absencesBySprint([entry({ from: '2026-09-10', to: '2026-09-15' })], SPRINTS);
    expect(a.get('Anna')?.get('Sprint 37')?.ooo).toBe(2); // 10, 11 Sep
    expect(a.get('Anna')?.get('Sprint 38')?.ooo).toBe(2); // 14, 15 Sep
  });

  it('skips weekends and absences outside every sprint', () => {
    // 12–13 Sep 2026 is a weekend between the sprints
    expect(absencesBySprint([entry({ from: '2026-09-12', to: '2026-09-13' })], SPRINTS).size).toBe(
      0,
    );
  });

  it('counts a day claimed by both OOO and support only once, as OOO', () => {
    const a = absencesBySprint(
      [
        entry({ from: '2026-09-07', to: '2026-09-11', kind: 'support' }),
        entry({ from: '2026-09-07', to: '2026-09-08', kind: 'ooo' }),
      ],
      SPRINTS,
    );
    expect(a.get('Anna')?.get('Sprint 37')).toMatchObject({ ooo: 2, support: 3, available: 5 });
  });

  it('lets a support factor give back part of a rota week', () => {
    const a = absencesBySprint([entry({ kind: 'support' })], SPRINTS, 0.5);
    expect(a.get('Anna')?.get('Sprint 37')?.available).toBe(7.5);
  });
});

describe('adjustCapacity', () => {
  it('scales bandwidth by the share of the sprint the person is present', () => {
    expect(adjustCapacity(8, { ooo: 5, support: 0, total: 10, available: 5 })).toBe(4);
    expect(adjustCapacity(6, { ooo: 2, support: 0, total: 10, available: 8 })).toBe(5);
    expect(adjustCapacity(8, { ooo: 10, support: 0, total: 10, available: 0 })).toBe(0);
  });

  it('leaves bandwidth alone when nobody is away', () => {
    expect(adjustCapacity(8, undefined)).toBe(8);
    expect(adjustCapacity(8, { ooo: 0, support: 0, total: 10, available: 10 })).toBe(8);
  });
});

describe('weekdaysIn', () => {
  it('is exclusive of the end and skips weekends', () => {
    expect(weekdaysIn(new Date('2026-08-31'), new Date('2026-09-07'))).toHaveLength(5);
  });
});
