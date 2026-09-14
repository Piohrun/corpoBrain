import { useEffect, useState } from 'react';
import { lsGet, lsSet } from '../storage.ts';
import { Icon, type IconName } from './Icon.tsx';

export type View =
  | 'notes'
  | 'planning'
  | 'projects'
  | 'availability'
  | 'digest'
  | 'tasks'
  | 'tracked'
  | 'objects'
  | 'jira'
  | 'private'
  | 'settings';
const groups: { label: string; items: { view: View; label: string; key: string }[] }[] = [
  {
    label: 'Workspace',
    items: [
      { view: 'planning', label: 'Planning', key: 'p' },
      { view: 'projects', label: 'Projects', key: 'j' },
      { view: 'availability', label: 'Availability', key: 'a' },
      { view: 'digest', label: 'What changed', key: 'd' },
    ],
  },
  {
    label: 'Notebook',
    items: [
      { view: 'notes', label: 'Notes', key: 'n' },
      { view: 'tasks', label: 'Tasks', key: 't' },
      { view: 'tracked', label: 'Tracked', key: 'k' },
      { view: 'objects', label: 'Objects', key: 'o' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { view: 'jira', label: 'Jira', key: 'i' },
      { view: 'private', label: 'Protected', key: 'l' },
      { view: 'settings', label: 'Settings', key: 's' },
    ],
  },
];

/** Navigation and keyboard traversal share one order and one set of labels. */
export const NAV_VIEWS = groups.flatMap((group) => group.items);

export function WorkspaceNav({
  view,
  onView,
  onFind,
  pinned,
  onPreview,
}: {
  view: View;
  onView: (view: View) => void;
  onFind: () => void;
  pinned: { path: string; title: string }[];
  onPreview: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => lsGet('cb.nav.collapsed') === 'yes');
  useEffect(() => lsSet('cb.nav.collapsed', collapsed ? 'yes' : 'no'), [collapsed]);
  return (
    <nav className={`workspace-nav${collapsed ? ' collapsed' : ''}`} aria-label="Main navigation">
      <div className="workspace-brand">
        <Icon name="notes" />
        <span>corpoBrain</span>
      </div>
      <button
        type="button"
        className="workspace-search"
        onClick={onFind}
        title="Find anything (Ctrl+K)"
        aria-label="Find anything"
      >
        <Icon name="search" />
        <span>Find anything</span>
      </button>
      <div className="workspace-nav-scroll">
        {pinned.length > 0 && (
          <section className="workspace-pins">
            <h2>Pinned notes</h2>
            {pinned.map((n) => (
              <button
                key={n.path}
                type="button"
                className="workspace-nav-item"
                onClick={() => onPreview(n.path)}
                title={`Preview ${n.title}`}
              >
                <Icon name="pin" />
                <span>{n.title}</span>
              </button>
            ))}
          </section>
        )}
        {groups.map((group) => (
          <section key={group.label}>
            <h2>{group.label}</h2>
            {group.items.map((item) => (
              <button
                type="button"
                key={item.view}
                className={`workspace-nav-item${view === item.view ? ' active' : ''}`}
                aria-current={view === item.view ? 'page' : undefined}
                onClick={() => onView(item.view)}
                title={`${item.label} (g ${item.key})`}
              >
                <Icon name={item.view as IconName} />
                <span>{item.label}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
      <button
        type="button"
        className="workspace-collapse"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-expanded={!collapsed}
      >
        <Icon name={collapsed ? 'forward' : 'back'} />
        <span>Collapse</span>
      </button>
    </nav>
  );
}
