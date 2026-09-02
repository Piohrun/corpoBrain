import type { ReactNode } from 'react';

/** A row the Finder can show. `data` is whatever the section needs to act on it. */
export interface FinderItem<T = unknown> {
  id: string;
  label: string;
  /** secondary text: path, status, person… */
  detail?: string;
  /** small right-aligned text, e.g. a status or a count */
  hint?: string;
  /** one-glyph kind marker (📄, ◈, 👤…) or a node */
  icon?: ReactNode;
  data: T;
  /** rank from the matcher; lower is better. Sections may pre-rank. */
  score?: number;
}

export interface FinderAction<T = unknown> {
  id: string;
  label: string;
  /** shortcut shown in the row hint / action menu, e.g. 'Enter', 'Ctrl+L' */
  keys?: string;
  /** false when the action does not apply to this selection (hidden) */
  when?: (items: FinderItem<T>[]) => boolean;
  /** runs with the highlighted item, or every selected item in a multi section */
  run: (items: FinderItem<T>[], ctx: FinderRunContext) => void | Promise<void> | FinderFollowUp;
}

/** An action may hand the Finder a second step: pick one item from another section. */
export interface FinderFollowUp {
  pick: {
    title: string;
    section: FinderSection;
    onPick: (picked: FinderItem) => void | Promise<void>;
  };
}

export interface FinderRunContext {
  query: string;
  close: () => void;
  /** whatever the page passed to open() — e.g. the calendar day that was clicked */
  context: Record<string, unknown>;
}

export interface FinderSection<T = unknown> {
  id: string;
  title: string;
  /** lower renders first */
  order: number;
  /** Space toggles rows into a chip list; the primary action gets them all */
  multi?: boolean;
  /** how many rows to show before "more…" */
  limit?: number;
  /**
   * Sync sections run on every keystroke. Mark `async: true` for sections that
   * hit the server: they run after a short pause and their results are merged
   * in when they arrive (previous results stay visible meanwhile).
   */
  search: (query: string) => FinderItem<T>[] | Promise<FinderItem<T>[]>;
  async?: boolean;
  /** shown with an empty query? default true for sync sections */
  showEmpty?: boolean;
  actions: FinderAction<T>[];
  /** a `/`-style prefix that restricts the Finder to this section */
  prefix?: string;
  emptyText?: string;
}

/** What a page asks the Finder to open with. */
export interface FinderRequest {
  /** restrict to one section (e.g. the projects "people" picker) */
  section?: string;
  /** pre-filled query */
  query?: string;
  /** free-form context handed to actions through `getContext()` */
  context?: Record<string, unknown>;
}

/** Erase the item type so sections with different `data` can live in one list. */
export function section<T>(s: FinderSection<T>): FinderSection {
  return s as unknown as FinderSection;
}
