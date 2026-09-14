const paths = {
  notes:
    'M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3 M16 3l5 5-9 9-6 1 1-6z M14 5l5 5',
  planning: 'M3 3h18v18H3z M3 9h18 M9 9v12 M15 9v12',
  projects: 'm12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5',
  availability: 'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16 M8 14h3 M8 17h6',
  digest: 'M3 12h4l3-8 4 16 3-8h4',
  tasks: 'M9 5h12 M9 12h12 M9 19h12 M2 4l2 2 3-3 M2 11l2 2 3-3 M2 18l2 2 3-3',
  tracked: 'M4 21V3h13l-2 4 2 4H4',
  objects: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  jira: 'M4 7h16 M17 4l3 3-3 3 M20 17H4 M7 14l-3 3 3 3',
  settings: 'M4 5h16 M4 12h16 M4 19h16 M8 3v4 M16 10v4 M10 17v4',
  private: 'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
  pin: 'm16 3 5 5-5 2-2 6-3-3-7 7 M11 13l-3-3 6-2z',
  close: 'm6 6 12 12 M6 18 18 6',
  back: 'm14 5-7 7 7 7',
  forward: 'm10 5 7 7-7 7',
  expand: 'M14 3h7v7 M21 3l-9 9 M10 3H3v18h18v-7',
  panel: 'M3 3h18v18H3z M15 3v18',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
  plus: 'M12 4v16 M4 12h16',
  check: 'm4 12 5 5L20 6',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="app-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
