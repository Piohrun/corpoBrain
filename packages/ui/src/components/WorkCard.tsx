import { useCallback, useEffect, useState } from 'react';
import { WORK_STAGE_LABEL, type WorkItem } from '../../../core/src/work-model.ts';
import { workApi } from '../api.ts';
import { useDialogs } from '../dialogs.tsx';
import { useVaultEvents } from '../hooks.ts';
import { ageLabel, isQuiet, needsYou, STAGE_SHORT, workInProgress } from '../work.ts';

/** Copy what a repository's agents need in their instructions to keep the work log. */
export function useCopyAgentInstructions(): () => void {
  const dlg = useDialogs();
  return useCallback(() => {
    workApi
      .instructions()
      .then(async (r) => {
        await navigator.clipboard.writeText(r.text);
        dlg.toast(
          "Copied. Paste it into the repository's agent instructions (AGENTS.md, .github/copilot-instructions.md…).",
        );
      })
      .catch((e: Error) => dlg.alert(`Could not copy the instructions: ${e.message}`));
  }, [dlg]);
}

/** One branch: where it is, what is next, how long since anything was reported. */
export function WorkRow({
  item,
  onOpenNote,
}: {
  item: WorkItem;
  onOpenNote: (path: string) => void;
}) {
  const quiet = isQuiet(item);
  return (
    <li data-path={item.path} className={needsYou(item) ? 'work-mine' : undefined}>
      <span className={`work-stage ${item.stage}`} title={WORK_STAGE_LABEL[item.stage]}>
        {STAGE_SHORT[item.stage]}
      </span>
      <button
        type="button"
        className="text-link"
        onClick={() => onOpenNote(item.path)}
        title={[item.repo, item.branch].filter(Boolean).join(' · ')}
      >
        {item.title}
      </button>
      <span className="work-next muted small" title={item.next ?? item.state ?? ''}>
        {item.next ? `next: ${item.next}` : (item.state ?? '')}
      </span>
      {item.waitingOn !== 'nobody' && (
        <span className={`work-waiting small${needsYou(item) ? ' me' : ''}`}>
          {needsYou(item) ? 'needs you' : `waiting on ${item.waitingOn}`}
        </span>
      )}
      <span
        className={`work-age small${quiet ? ' quiet' : ' muted'}`}
        title={quiet ? 'Nothing reported for a week or more' : 'Last report'}
      >
        {ageLabel(item)}
      </span>
    </li>
  );
}

/**
 * Home: the branches agents are working on, yours to move first. Agents file
 * their reports through the CLI or the MCP server (core/work.ts); this only
 * reads them.
 */
export function WorkCard({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const load = useCallback(() => {
    workApi
      .list()
      .then(setItems)
      .catch(() => setItems((cur) => cur ?? []));
  }, []);
  useEffect(load, [load]);
  useVaultEvents(load);
  const copy = useCopyAgentInstructions();
  if (!items) return null;
  const open = workInProgress(items);
  const mine = open.filter(needsYou).length;
  return (
    <section className="home-card work-card">
      <h2 className="plan-h2">
        Work in progress <span className="health-badge">{open.length}</span>
        {mine > 0 && <span className="health-badge work-mine-count">{mine} need you</span>}
        <span className="spacer" />
        <button
          type="button"
          className="text-link small"
          onClick={copy}
          title="Copy the instructions that make a repository's agents report their progress here"
        >
          agent instructions
        </button>
      </h2>
      {open.length === 0 ? (
        <p className="muted small">
          {items.length === 0
            ? 'Nothing reported yet. Give your coding agents the instructions (top right) and each branch they work on shows up here with where it stopped and what is next.'
            : 'Nothing in progress: every branch is released or parked.'}
        </p>
      ) : (
        <ul className="home-list work-list">
          {open.map((w) => (
            <WorkRow key={w.path} item={w} onOpenNote={onOpenNote} />
          ))}
        </ul>
      )}
    </section>
  );
}
