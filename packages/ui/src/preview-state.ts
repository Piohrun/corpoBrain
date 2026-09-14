/** A pinned reference stays put while the other preview follows links. */
export interface PreviewState {
  pinned: string | null;
  history: string[];
  index: number;
}

export const emptyPreview: PreviewState = { pinned: null, history: [], index: -1 };
export type PreviewAction =
  | { type: 'open'; path: string }
  | { type: 'pin' }
  | { type: 'unpin' }
  | { type: 'close-pinned' }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'close-current' }
  | { type: 'close' };

export function previewPath(state: PreviewState): string | null {
  return state.history[state.index] ?? null;
}

export function previewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  const current = previewPath(state);
  switch (action.type) {
    case 'open': {
      if (action.path === current || action.path === state.pinned) return state;
      const history = [...state.history.slice(0, state.index + 1), action.path].slice(-30);
      return { ...state, history, index: history.length - 1 };
    }
    case 'pin':
      return current ? { pinned: current, history: [], index: -1 } : state;
    case 'unpin':
      return current
        ? { ...state, pinned: null }
        : {
            pinned: null,
            history: state.pinned ? [state.pinned] : [],
            index: state.pinned ? 0 : -1,
          };
    case 'back':
      return { ...state, index: state.history.length ? Math.max(0, state.index - 1) : -1 };
    case 'forward':
      return { ...state, index: Math.min(state.history.length - 1, state.index + 1) };
    case 'close-current':
      return { ...state, history: [], index: -1 };
    case 'close-pinned':
      return { ...state, pinned: null };
    case 'close':
      return emptyPreview;
  }
}

/** Preview rendering never edits the original Markdown. */
export function previewBody(content: string, title?: string): string {
  let body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
  const heading = /^\s*# (.+)\r?\n/.exec(body);
  if (heading && title && heading[1]?.trim() === title.trim()) body = body.slice(heading[0].length);
  return body.replace(/^<!-- jira:end -->[ \t]*\r?\n?/gm, '');
}
