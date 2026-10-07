import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { type HomeResponse, workWeek } from '../src/home-routes.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

beforeEach(() => {
  root = join(tmpdir(), `cb-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  write(
    '.corpobrain/jira-cache/sprints.json',
    JSON.stringify([
      { id: 2, name: 'Sprint 37', state: 'active', startDate: '2026-10-05', endDate: '2026-10-16' },
    ]),
  );
  write('people/anna.md', '---\ntype: person\ntitle: Anna\ncountry: PL\n---\n');
  write('people/bob.md', '---\ntype: person\ntitle: Bob\n---\n');
  write(
    'planning/availability.md',
    '| Person | From | To | Type | Note |\n| --- | --- | --- | --- | --- |\n| [[Bob]] | 2026-10-08 | 2026-10-20 | ooo | leave |\n| [[Anna]] | 2026-11-01 | 2026-11-02 | ooo | |\n',
  );
  write(
    'planning/holidays.md',
    '| Country | From | To | Name |\n| --- | --- | --- | --- |\n| PL | 2026-10-09 | 2026-10-09 | Test day |\n',
  );
  write(
    'meetings/late.md',
    '---\ntype: meeting\ntitle: Late one\ndate: 2026-10-07\nstart: 2026-10-07T14:00:00Z\nend: 2026-10-07T15:00:00Z\n---\n',
  );
  write(
    'meetings/early.md',
    '---\ntype: meeting\ntitle: Early one\ndate: 2026-10-07\nstart: 2026-10-07T07:00:00Z\nlocation: Room 4\n---\n',
  );
  write('meetings/other-day.md', '---\ntype: meeting\ntitle: Tomorrow\ndate: 2026-10-08\n---\n');
  write(
    'notes/work.md',
    [
      '# Work',
      '- [ ] overdue thing 📅 2026-10-01',
      '- [ ] due today 📅 2026-10-07',
      '- [ ] next week 📅 2026-10-12',
      '- [ ] far away 📅 2026-12-01',
      '- [x] done already 📅 2026-10-02',
      '- [ ] no date',
    ].join('\n'),
  );
  write('tracked/c1.md', '---\ntype: commitment\ntitle: Send the budget\ndue: 2026-10-09\n---\n');
  write(
    'tracked/c2.md',
    '---\ntype: commitment\ntitle: Done one\ndue: 2026-10-09\nstatus: done\n---\n',
  );
  write('tracked/r1.md', '---\ntype: risk\ntitle: Vendor risk\nreview: 2026-10-01\n---\n');
  write('tracked/r2.md', '---\ntype: risk\ntitle: Later risk\nreview: 2026-11-01\n---\n');
  vault = new VaultService(root, ':memory:');
  vault.indexer.rebuild();
  vault.indexer.loadSprints();
});
afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

const home = async (day: string) =>
  (await (await createApp(vault).request(`/api/home?day=${day}`)).json()) as HomeResponse;

describe('Home', () => {
  it('collects the day: meetings, tasks due, tracked items, who is away, the sprint', async () => {
    const h = await home('2026-10-07');
    expect(h.meetings.map((m) => m.title)).toEqual(['Early one', 'Late one']);
    expect(h.meetings[0]).toMatchObject({ location: 'Room 4', allDay: false });
    expect(h.tasks.map((t) => t.text)).toEqual(['overdue thing', 'due today', 'next week']);
    expect(h.overdueCount).toBe(1);
    expect(h.tracked.map((t) => t.title)).toEqual(['Vendor risk', 'Send the budget']);
    expect(h.week).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    expect(h.away).toEqual([
      {
        path: 'people/anna.md',
        name: 'Anna',
        kind: 'holiday',
        days: ['2026-10-09'],
        note: 'Test day',
      },
      {
        path: 'people/bob.md',
        name: 'Bob',
        kind: 'ooo',
        days: ['2026-10-08', '2026-10-09'],
        note: 'leave',
      },
    ]);
    expect(h.sprint).toMatchObject({ name: 'Sprint 37', daysLeft: 9 });
  });

  it('rejects a malformed day and knows weekends belong to the week before', async () => {
    expect((await createApp(vault).request('/api/home?day=tomorrow')).status).toBe(400);
    expect(workWeek('2026-10-11')).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
  });
});
