import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  WORK_STAGE_LABEL,
  WORK_STAGES,
  WORK_WAITING,
  type WorkGitFacts,
  type WorkItem,
  type WorkStage,
  type WorkWaiting,
} from '../../../core/src/work-model.ts';
import { workApi } from '../api.ts';
import { useDialogs } from '../dialogs.tsx';
import { ctxTarget } from '../finder/ContextMenu.tsx';
import { rankBy } from '../finder/match.ts';
import { useFinderSections } from '../finder/registry.tsx';
import { type FinderItem, type FinderSection, section } from '../finder/types.ts';
import { useVaultEvents } from '../hooks.ts';
import { lsGet, lsSet } from '../storage.ts';
import { ageLabel, gitNotes, isActive, isQuiet, needsYou, suggestedStage } from '../work.ts';
import { useCopyAgentInstructions } from './WorkCard.tsx';

/** the way to a release, left to right; the last two only on request */
const PATH: WorkStage[] = ['dev', 'in-uat-branch', 'on-uat', 'pr-open'];
const OFF_PATH: WorkStage[] = ['released', 'parked'];
const WAITING_LABEL: Record<WorkWaiting, string> = {
  me: 'needs me',
  agent: 'agent working',
  tester: 'with testers',
  reviewer: 'with reviewers',
  nobody: 'nobody waiting',
};

type Patch = Parameters<typeof workApi.patch>[1];

/** One branch on the board. Dragged between columns, or moved with its stage menu. */
const WorkBoardCard = memo(function WorkBoardCard({
  item,
  facts,
  onOpenNote,
  onPatch,
  onDrag,
}: {
  item: WorkItem;
  facts: WorkGitFacts | undefined;
  onOpenNote: (path: string) => void;
  onPatch: (item: WorkItem, patch: Patch) => void;
  onDrag: (path: string | null) => void;
}) {
  const dlg = useDialogs();
  const notes = gitNotes(facts);
  const suggested = suggestedStage(item, facts);
  const quiet = isQuiet(item);
  const editNext = async () => {
    const next = await dlg.prompt({
      message: `Next step for ${item.title}`,
      initial: item.next ?? '',
    });
    if (next !== null && next.trim() !== (item.next ?? ''))
      onPatch(item, { next: next.trim() || null });
  };
  return (
    <article
      className={`work-item${needsYou(item) ? ' mine' : ''}${quiet ? ' quiet' : ''}`}
      draggable
      data-path={item.path}
      {...ctxTarget('work-items', item.path)}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', item.path);
        e.dataTransfer.effectAllowed = 'move';
        onDrag(item.path);
      }}
      onDragEnd={() => onDrag(null)}
    >
      <header>
        <button
          type="button"
          className="text-link work-item-title"
          onClick={() => onOpenNote(item.path)}
        >
          {item.title}
        </button>
        <span
          className={`small work-age${quiet ? ' quiet' : ' muted'}`}
          title={quiet ? 'Nothing reported for a week or more' : 'Last report'}
        >
          {ageLabel(item)}
        </span>
      </header>
      {(item.repo || item.branch) && (
        <div
          className="work-ref"
          title={facts?.lastCommit ? `last commit: ${facts.lastCommit.subject}` : undefined}
        >
          {[item.repo, item.branch].filter(Boolean).join(' · ')}
          {item.issue ? ` · ${item.issue}` : ''}
        </div>
      )}
      {item.state && <p className="work-state">{item.state}</p>}
      <button
        type="button"
        className="work-next-line"
        onClick={editNext}
        title="Change the next step"
      >
        {item.next ? (
          <>
            <b>Next:</b> {item.next}
          </>
        ) : (
          <span className="muted">+ next step</span>
        )}
      </button>
      {(notes.length > 0 || suggested) && (
        <div className="work-git">
          {notes.map((n) => (
            <span key={n.text} className={`work-git-note ${n.tone}`} title={n.title}>
              {n.text}
            </span>
          ))}
          {suggested && (
            <button
              type="button"
              className="work-suggest"
              title={`git: the branch is already in ${suggested === 'released' ? item.releaseBranch : item.uatBranch}`}
              onClick={() => onPatch(item, { stage: suggested })}
            >
              → {WORK_STAGE_LABEL[suggested]}
            </button>
          )}
        </div>
      )}
      {facts?.available && facts.mergedInto.length > 0 && (
        <div className="work-merged muted small" title={facts.mergedInto.join('\n')}>
          in {facts.mergedInto.slice(0, 3).join(', ')}
          {facts.mergedInto.length > 3 ? ` +${facts.mergedInto.length - 3}` : ''}
        </div>
      )}
      <footer>
        <select
          aria-label={`whose move: ${item.title}`}
          className={`work-select${needsYou(item) ? ' me' : ''}`}
          value={item.waitingOn}
          onChange={(e) => onPatch(item, { waitingOn: e.target.value as WorkWaiting })}
        >
          {WORK_WAITING.map((w) => (
            <option key={w} value={w}>
              {WAITING_LABEL[w]}
            </option>
          ))}
        </select>
        <select
          aria-label={`stage: ${item.title}`}
          className="work-select"
          value={item.stage}
          onChange={(e) => onPatch(item, { stage: e.target.value as WorkStage })}
        >
          {WORK_STAGES.map((s) => (
            <option key={s} value={s}>
              {WORK_STAGE_LABEL[s]}
            </option>
          ))}
        </select>
      </footer>
    </article>
  );
});

/**
 * Work: every branch your agents report on (core/work.ts), laid out along
 * the way to a release. The cards are the work notes; what the local clones
 * say (uncommitted, unpushed, already merged where) is added from git.
 */
export function WorkPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [git, setGit] = useState<Map<string, WorkGitFacts>>(new Map());
  const [gitBusy, setGitBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showDone, setShowDone] = useState(() => lsGet('cb.work.done') === 'yes');
  useEffect(() => lsSet('cb.work.done', showDone ? 'yes' : 'no'), [showDone]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<WorkStage | null>(null);

  const load = useCallback(() => {
    workApi
      .list()
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useVaultEvents(load);

  const loadGit = useCallback((fresh = false) => {
    setGitBusy(true);
    workApi
      .git(fresh)
      .then((facts) => setGit(new Map(facts.map((f) => [f.path, f]))))
      .catch(() => {})
      .finally(() => setGitBusy(false));
  }, []);
  // the list keeps its identity while nothing changed, so this follows real changes only
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the list changes
  useEffect(() => loadGit(), [loadGit, items]);

  const patch = useCallback(
    (item: WorkItem, p: Patch) => {
      workApi
        .patch(item.path, p)
        .then(load)
        .catch((e: Error) => setError(e.message));
    },
    [load],
  );
  const copyInstructions = useCopyAgentInstructions();

  // ---- Ctrl+F here: find a branch, open it, move it, say whose move it is ----
  const finderSections = useMemo<FinderSection[]>(() => {
    const all = items ?? [];
    const itemOf = (w: WorkItem): FinderItem<WorkItem> => ({
      id: w.path,
      label: w.title,
      detail: [w.repo, w.branch].filter(Boolean).join(' · '),
      hint: WORK_STAGE_LABEL[w.stage],
      icon: needsYou(w) ? '●' : '○',
      data: w,
    });
    const choice = <T extends string>(
      id: string,
      title: string,
      values: readonly T[],
      label: (v: T) => string,
      current: T,
    ) =>
      section<{ value: T }>({
        id,
        title,
        order: 0,
        search: (q) =>
          rankBy(
            values.map((value) => ({ value })),
            q,
            (r) => [label(r.value)],
          ).map(({ row }) => ({
            id: row.value,
            label: label(row.value),
            hint: row.value === current ? 'current' : undefined,
            data: row,
          })),
        actions: [],
      });
    return [
      section<WorkItem>({
        id: 'work-items',
        title: 'Work',
        order: 10,
        limit: 10,
        search: (q) =>
          rankBy(all, q, (w) => [w.title, w.branch, w.repo, w.issue ?? '', w.next ?? ''], 60).map(
            ({ row, score }) => ({ ...itemOf(row), score }),
          ),
        resolve: (id) => {
          const row = all.find((w) => w.path === id);
          return row ? itemOf(row) : null;
        },
        actions: [
          {
            id: 'open',
            label: 'open the note',
            run: ([w], ctx) => {
              ctx.close();
              if (w) onOpenNote(w.data.path);
            },
          },
          {
            id: 'stage',
            label: 'move to…',
            run: ([w]) => {
              if (!w) return;
              return {
                pick: {
                  title: `Move ${w.data.title} to`,
                  section: choice(
                    'work-stage',
                    'Stage',
                    WORK_STAGES,
                    (s) => WORK_STAGE_LABEL[s],
                    w.data.stage,
                  ),
                  onPick: (picked) =>
                    patch(w.data, { stage: (picked.data as { value: WorkStage }).value }),
                },
              };
            },
          },
          {
            id: 'waiting',
            label: 'whose move…',
            run: ([w]) => {
              if (!w) return;
              return {
                pick: {
                  title: `${w.data.title}: whose move`,
                  section: choice(
                    'work-waiting',
                    'Whose move',
                    WORK_WAITING,
                    (x) => WAITING_LABEL[x],
                    w.data.waitingOn,
                  ),
                  onPick: (picked) =>
                    patch(w.data, { waitingOn: (picked.data as { value: WorkWaiting }).value }),
                },
              };
            },
          },
        ],
      }),
    ];
  }, [items, onOpenNote, patch]);
  useFinderSections('work', finderSections);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = items ?? [];
    return needle
      ? list.filter((w) =>
          [w.title, w.repo, w.branch, w.issue, w.next, w.state, w.chat].some((t) =>
            t?.toLowerCase().includes(needle),
          ),
        )
      : list;
  }, [items, query]);

  if (!items) {
    return (
      <div className="planning">
        <div className="empty-state">{error ? `Work: ${error}` : 'Loading work…'}</div>
      </div>
    );
  }

  const column = (stage: WorkStage) => {
    const now = Date.now();
    const rank = (w: WorkItem) => (needsYou(w) ? 0 : isQuiet(w, now) ? 1 : 2);
    return shown
      .filter((w) => w.stage === stage)
      .sort((a, b) => rank(a) - rank(b) || (b.updated ?? '').localeCompare(a.updated ?? ''));
  };
  const stages = showDone ? [...PATH, ...OFF_PATH] : PATH;
  const open = items.filter(isActive);
  const mine = open.filter(needsYou).length;
  const done = items.length - open.length;

  return (
    <div className="planning work-page">
      <div className="planning-header">
        <span className="title">Work</span>
        <span className="health-stat">
          {open.length} in progress
          {mine > 0 && <span className="work-mine-count"> · {mine} need you</span>}
        </span>
        <input
          className="plan-filter"
          placeholder="Filter work…"
          aria-label="Filter work"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="spacer" />
        <label className="small muted work-done-toggle">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
          />{' '}
          released and parked ({done})
        </label>
        <button
          type="button"
          className="plan-btn ghost"
          onClick={() => loadGit(true)}
          disabled={gitBusy}
          title="Read the local clones again: uncommitted and unpushed work, and where each branch is merged"
        >
          {gitBusy ? 'reading git…' : '↻ git'}
        </button>
        <button
          type="button"
          className="plan-btn"
          onClick={copyInstructions}
          title="Copy the instructions that make a repository's agents report their progress here"
        >
          Agent instructions
        </button>
      </div>
      {error && <p className="plan-error">{error}</p>}
      {items.length === 0 ? (
        <div className="planning-scroll">
          <div className="work-empty">
            <h2 className="plan-h2">No work reported yet</h2>
            <p>
              Every branch your coding agents work on gets a card here: where it is on the way to a
              release, where the last chat stopped, what is next and whose move it is.
            </p>
            <p>
              Click <b>Agent instructions</b> and paste the copied text into a repository’s agent
              instructions (<code>AGENTS.md</code>, <code>.github/copilot-instructions.md</code>…).
              From then on its agents report by running one command; the first report creates the
              card.
            </p>
          </div>
        </div>
      ) : (
        <div className="planning-scroll work-board">
          {stages.map((stage) => {
            const cards = column(stage);
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: drop target; each card also has a stage menu
              <section
                key={stage}
                className={`work-col${over === stage && dragging ? ' over' : ''}`}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (over !== stage) setOver(stage);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const path = e.dataTransfer.getData('text/plain') || dragging;
                  setOver(null);
                  setDragging(null);
                  const item = items.find((w) => w.path === path);
                  if (item && item.stage !== stage) patch(item, { stage });
                }}
              >
                <h2 className="work-col-head">
                  {WORK_STAGE_LABEL[stage]} <span className="health-badge">{cards.length}</span>
                </h2>
                {cards.map((w) => (
                  <WorkBoardCard
                    key={w.path}
                    item={w}
                    facts={git.get(w.path)}
                    onOpenNote={onOpenNote}
                    onPatch={patch}
                    onDrag={setDragging}
                  />
                ))}
                {cards.length === 0 && <p className="work-col-empty muted small">—</p>}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
