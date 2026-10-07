import { createContext, useContext } from 'react';

/** A link target (`people/anna`, `people/anna.md`, `anna`) → that note's title, if known. */
export type TitleFor = (target: string) => string | null;

const Ctx = createContext<TitleFor>(() => null);
export const NoteTitlesProvider = Ctx.Provider;

/** Show `[[people/person-12]]` as "Anna Kowalska" wherever a link has no alias. */
export const useNoteTitle = (): TitleFor => useContext(Ctx);

export function titleResolver(notes: readonly { path: string; title: string }[]): TitleFor {
  const byPath = new Map<string, string>();
  // a bare name only resolves when exactly one note has it
  const byName = new Map<string, string | null>();
  for (const n of notes) {
    const key = n.path.toLowerCase().replace(/\.md$/, '');
    byPath.set(key, n.title);
    const name = key.slice(key.lastIndexOf('/') + 1);
    byName.set(name, byName.has(name) ? null : n.title);
  }
  return (target) => {
    const key = target.trim().replace(/#.*$/, '').toLowerCase().replace(/\.md$/, '');
    return byPath.get(key) ?? byName.get(key) ?? null;
  };
}
