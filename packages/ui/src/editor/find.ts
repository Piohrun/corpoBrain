/**
 * In-note find, driven by the Finder instead of CodeMirror's stock panel.
 * CodeMirror only highlights matches while a search panel is "open", so a
 * zero-size panel is registered and opened/closed around the Finder session;
 * the query itself is the normal SearchQuery, so F3 / Mod-g keep working.
 */
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  search,
  setSearchQuery,
} from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export function findExtension(): Extension {
  return search({
    createPanel: () => {
      const dom = document.createElement('div');
      dom.className = 'cm-cb-findpanel';
      dom.setAttribute('aria-hidden', 'true');
      return { dom, top: true };
    },
  });
}

export interface FindMatch {
  from: number;
  to: number;
  line: number;
  /** the line's text with the match position, for the result row */
  text: string;
  col: number;
}

/** Every match of `query` (case-insensitive, literal) with its line context. */
export function findMatches(view: EditorView, query: string, limit = 200): FindMatch[] {
  const q = query.trim();
  if (!q) return [];
  const out: FindMatch[] = [];
  const doc = view.state.doc;
  const cursor = new SearchQuery({ search: q, caseSensitive: false, literal: true }).getCursor(doc);
  for (let m = cursor.next(); !m.done && out.length < limit; m = cursor.next()) {
    const line = doc.lineAt(m.value.from);
    out.push({
      from: m.value.from,
      to: m.value.to,
      line: line.number,
      text: line.text,
      col: m.value.from - line.from,
    });
  }
  return out;
}

/** Set the live query (highlights every match) and make sure the panel state is open. */
export function setFind(view: EditorView, query: string): void {
  const q = query.trim();
  const current = getSearchQuery(view.state);
  if (current.search !== q || current.caseSensitive || !current.literal) {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: q, caseSensitive: false, literal: true }),
      ),
    });
  }
  if (q) openSearchPanel(view);
}

export function clearFind(view: EditorView): void {
  closeSearchPanel(view);
}

/** Select one match and scroll to it. */
export function selectMatch(view: EditorView, m: { from: number; to: number }): void {
  view.dispatch({ selection: { anchor: m.from, head: m.to }, scrollIntoView: true });
  view.focus();
}

export const findNextMatch = findNext;
export const findPreviousMatch = findPrevious;
