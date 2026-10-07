import { describe, expect, it } from 'vitest';
import { titleResolver } from '../src/note-titles.tsx';

describe('link target → note title', () => {
  const titleFor = titleResolver([
    { path: 'people/person-12.md', title: 'Anna Kowalska' },
    { path: 'organization/area-0.md', title: 'Area 0' },
    { path: 'notes/plan.md', title: 'Q4 plan' },
    { path: 'archive/plan.md', title: 'Old plan' },
  ]);

  it('resolves paths with or without .md, any case, ignoring a heading', () => {
    expect(titleFor('people/person-12')).toBe('Anna Kowalska');
    expect(titleFor('People/Person-12.md')).toBe('Anna Kowalska');
    expect(titleFor('organization/area-0#Mandate')).toBe('Area 0');
  });

  it('resolves a bare name only when one note has it', () => {
    expect(titleFor('person-12')).toBe('Anna Kowalska');
    expect(titleFor('plan')).toBeNull();
    expect(titleFor('missing/note')).toBeNull();
  });
});
