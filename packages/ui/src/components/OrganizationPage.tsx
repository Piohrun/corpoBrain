import { useDeferredValue, useMemo, useRef, useState } from 'react';
import {
  ORG_KINDS,
  ORG_LABELS,
  type OrgChain,
  type OrgKind,
  type OrgModel,
  type OrgPerson,
  type OrgReportingMode,
  type OrgUnit,
  orgAncestors,
  orgAnonymousGroups,
  orgFilteredView,
  orgHeadcount,
  orgMembers,
  orgParentAllowed,
  orgReportingTotals,
  orgReportingView,
} from '../../../core/src/organization.ts';
import { organizationApi } from '../api.ts';
import { ctxTarget } from '../finder/ContextMenu.tsx';
import { rankBy } from '../finder/match.ts';
import { useFinderSections } from '../finder/registry.tsx';
import { type FinderSection, section } from '../finder/types.ts';
import { lsGet, lsSet } from '../storage.ts';
import { OrganizationEditor, orgLink, useOrganization } from './OrganizationEditor.tsx';
import { countText, ReportingSummary } from './OrganizationHeadcount.tsx';

type Lens = 'structure' | 'reporting' | 'matrix';
const NO_POD = '__none__';

function CreateUnit({
  model,
  onCreated,
  onClose,
}: {
  model: OrgModel;
  onCreated: (path: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<OrgKind>(model.units.length ? 'pod' : 'department');
  const [parent, setParent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="org-create"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const result = await organizationApi.create(title, kind, { parent: orgLink(parent) });
          onCreated(result.path);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Create organization note</h3>
      <div className="org-create-fields">
        <label>
          Title
          <input
            required
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Cash Equities"
          />
        </label>
        <label>
          Kind
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as OrgKind);
              setParent('');
            }}
          >
            {ORG_KINDS.map((k) => (
              <option key={k} value={k}>
                {ORG_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Parent
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">Not set</option>
            {model.units
              .filter((u) => orgParentAllowed(kind, u.kind))
              .map((u) => (
                <option key={u.path} value={u.path}>
                  {u.title}
                </option>
              ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="org-actions">
        <button type="submit" className="primary" disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : 'Create note'}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function OrganizationPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const pageRef = useRef<HTMLDivElement>(null);
  const { model, error, refresh } = useOrganization();
  const [lens, setLens] = useState<Lens>(() => {
    const saved = lsGet('cb.org.lens');
    return saved === 'reporting' || saved === 'matrix' ? saved : 'structure';
  });
  const [chain, setChain] = useState<OrgReportingMode>('functionalManager');
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('');
  const [department, setDepartment] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [secondary, setSecondary] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [create, setCreate] = useState(false);
  const [editing, setEditing] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [cell, setCell] = useState<{ pod: string; country: string } | null>(null);
  const reportTotals = useMemo(
    () =>
      model
        ? {
            functionalManager: orgReportingTotals(model, 'functionalManager', showInactive),
            entityManager: orgReportingTotals(model, 'entityManager', showInactive),
            both: orgReportingTotals(model, 'both', showInactive),
          }
        : null,
    [model, showInactive],
  );
  const select = (path: string) => {
    setSelected(path);
    setEditing(false);
    if (window.matchMedia('(max-width: 900px)').matches) pageRef.current?.scrollTo({ top: 0 });
  };
  const finderSections = useMemo<FinderSection[]>(() => {
    if (!model) return [];
    return [
      section<{ path: string; title: string }>({
        id: 'organization',
        title: 'People & organization',
        order: 10,
        limit: 12,
        search: (q) =>
          rankBy([...model.people, ...model.units], q, (item) => [item.title, item.path]).map(
            ({ row, score }) => ({
              id: row.path,
              label: row.title,
              detail: row.path,
              data: row,
              score,
            }),
          ),
        resolve: (id) => {
          const row =
            model.people.find((p) => p.path === id) ?? model.units.find((u) => u.path === id);
          return row ? { id: row.path, label: row.title, detail: row.path, data: row } : null;
        },
        actions: [
          {
            id: 'inspect',
            label: 'Show relationships',
            run: ([item], context) => {
              if (item) {
                setSelected(item.data.path);
                setEditing(false);
                context.close();
              }
            },
          },
          {
            id: 'edit',
            label: 'Edit relationships',
            run: ([item], context) => {
              if (item) {
                setSelected(item.data.path);
                setEditing(true);
                context.close();
              }
            },
          },
          {
            id: 'preview',
            label: 'Preview note',
            run: ([item], context) => {
              if (item) {
                onOpenNote(item.data.path);
                context.close();
              }
            },
          },
        ],
      }),
    ];
  }, [model, onOpenNote]);
  useFinderSections('organization', finderSections);

  // The filtered structure, headcounts and counted groups are rebuilt only when
  // the model or a filter changes, not on every selection click; typing in
  // the query box updates them in the background.
  const deferredQuery = useDeferredValue(query);
  const view = useMemo(
    () =>
      model
        ? orgFilteredView(model, { query: deferredQuery, country, department, showInactive })
        : null,
    [model, deferredQuery, country, department, showInactive],
  );
  const overallCount = useMemo(
    () => (model ? orgHeadcount(model, department || undefined, showInactive) : null),
    [model, department, showInactive],
  );
  const anonymousGroups = useMemo(() => (model ? orgAnonymousGroups(model) : []), [model]);

  if (!model || !reportTotals || !view || !overallCount)
    return (
      <div className="organization-page">
        <p className={error ? 'error' : 'muted'}>{error ?? 'Loading organization…'}</p>
        {error && (
          <button type="button" onClick={refresh}>
            Retry
          </button>
        )}
      </div>
    );
  const {
    personByPath,
    unitByPath,
    membersByUnit,
    people,
    peoplePaths,
    anonymous,
    countries,
    primaryUnplaced,
    visibleUnits,
    structure,
  } = view;
  const overall = overallCount;
  const totals = reportTotals[chain];
  const allAnonymous = anonymousGroups;
  const missingReporting = allAnonymous
    .filter((group) =>
      chain === 'both'
        ? !group.functionalManagers.length && !group.entityManagers.length
        : !(chain === 'functionalManager' ? group.functionalManagers : group.entityManagers).length,
    )
    .reduce((sum, group) => sum + group.count, 0);
  const selectedPerson = selected ? personByPath.get(selected) : undefined;
  const selectedUnit = selected ? unitByPath.get(selected) : undefined;
  const toggle = (key: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const personButton = (p: OrgPerson, isSecondary = false) => (
    <button
      type="button"
      key={`${p.path}:${isSecondary}`}
      className={`org-person${selected === p.path ? ' selected' : ''}${isSecondary ? ' secondary' : ''}`}
      {...ctxTarget('organization', p.path)}
      onClick={() => select(p.path)}
      title={p.path}
    >
      <span>{p.title}</span>
      <small>
        {p.country || 'Country not set'}
        {isSecondary ? ' · secondary' : ''}
        {!p.active ? ' · inactive' : ''}
      </small>
    </button>
  );
  const unitButton = (u: OrgUnit) => (
    <button
      type="button"
      className="org-unit-title"
      {...ctxTarget('organization', u.path)}
      onClick={() => select(u.path)}
    >
      {u.title}
    </button>
  );
  const personLink = (path: string) => (
    <button
      type="button"
      key={path}
      className="org-text-link"
      {...ctxTarget('organization', path)}
      onClick={() => select(path)}
    >
      {personByPath.get(path)?.title ?? path}
    </button>
  );
  const unitLink = (path: string) => (
    <button
      type="button"
      key={path}
      className="org-text-link"
      {...ctxTarget('organization', path)}
      onClick={() => select(path)}
    >
      {unitByPath.get(path)?.title ?? path}
    </button>
  );
  const renderUnit = (u: OrgUnit, visited = new Set<string>()): React.ReactNode => {
    if (visited.has(u.path) || !visibleUnits.has(u.path)) return null;
    const route = new Set([...visited, u.path]);
    const children = structure.children.get(u.path) ?? [];
    const direct = people.filter((p) => p.primaryPod === u.path);
    const additional = secondary ? people.filter((p) => p.secondaryPods.includes(u.path)) : [];
    const key = `unit:${u.path}`;
    const shut = collapsed.has(key);
    const count = (membersByUnit.get(u.path) ?? []).filter((p) => peoplePaths.has(p.path)).length;
    const size = orgHeadcount(model, u.path, showInactive);
    const otherMatches = anonymous
      .filter((group) => group.pod === u.path)
      .reduce((sum, group) => sum + group.count, 0);
    return (
      <li key={u.path} className={`org-unit${selected === u.path ? ' selected' : ''}`}>
        <div className="org-unit-heading">
          <button
            type="button"
            className="org-collapse"
            onClick={() => toggle(key)}
            aria-expanded={!shut}
            aria-label={`${shut ? 'Expand' : 'Collapse'} ${u.title}`}
          >
            {shut ? '▸' : '▾'}
          </button>
          <div>
            {unitButton(u)}
            <div className="muted small">
              {ORG_LABELS[u.kind]}
              {u.podKind === 'support' ? ' · support / management' : ''} · {countText(size)}
              {(query || country) && <> · {count} named matching filters</>}
              {u.leads.length > 0 && (
                <> · Leads: {u.leads.map((p) => personByPath.get(p)?.title).join(', ')}</>
              )}
            </div>
          </div>
        </div>
        {!shut && (
          <>
            {u.mandate && <p className="org-mandate">{u.mandate}</p>}
            {(direct.length > 0 || additional.length > 0) && (
              <div className="org-members">
                {direct.map((p) => personButton(p))}
                {additional.map((p) => personButton(p, true))}
              </div>
            )}
            {otherMatches > 0 && (
              <p className="org-others">+ {otherMatches} other employees · names not recorded</p>
            )}
            {children.length > 0 && <ul>{children.map((child) => renderUnit(child, route))}</ul>}
          </>
        )}
      </li>
    );
  };
  const treeChain = chain === 'both' ? 'functionalManager' : chain;
  const reportingMatches = new Set([
    ...peoplePaths,
    ...anonymous.flatMap((group) =>
      treeChain === 'functionalManager' ? group.functionalManagers : group.entityManagers,
    ),
  ]);
  const reporting = orgReportingView(model, reportingMatches, treeChain, focus);
  const combinedFocus = focus ? reportTotals.both.get(focus) : undefined;
  const combinedPaths = combinedFocus
    ? new Set([focus, ...combinedFocus.people.map((p) => p.path)])
    : null;
  const combinedRows = model.people.filter(
    (p) =>
      (peoplePaths.has(p.path) || p.path === focus) &&
      (!combinedPaths || combinedPaths.has(p.path)),
  );

  const renderPerson = (p: OrgPerson, seen = new Set<string>()): React.ReactNode => {
    if (seen.has(p.path)) return null;
    const route = new Set([...seen, p.path]);
    const children = reporting.children.get(p.path) ?? [];
    const key = `${chain}:${p.path}`;
    const shut = collapsed.has(key);
    return (
      <li key={p.path}>
        <div className={`org-report-card${peoplePaths.has(p.path) ? '' : ' context'}`}>
          {children.length > 0 && (
            <button
              type="button"
              className="org-collapse"
              aria-label={`${shut ? 'Expand' : 'Collapse'} reports of ${p.title}`}
              aria-expanded={!shut}
              onClick={() => toggle(key)}
            >
              {shut ? '▸' : '▾'}
            </button>
          )}
          <button
            type="button"
            className={`org-person${selected === p.path ? ' selected' : ''}`}
            {...ctxTarget('organization', p.path)}
            onClick={() => select(p.path)}
          >
            <span>{p.title}</span>
            <small>
              {p.role || 'Person'} · {p.country || 'Country not set'}
              {!peoplePaths.has(p.path) ? ' · context' : ''}
            </small>
            {chain === 'entityManager' &&
              (p.countryLeadFor.length > 0 || p.regionLeadFor.length > 0) && (
                <small>
                  {[
                    ...p.countryLeadFor.map((c) => `${c} Country Lead`),
                    ...p.regionLeadFor.map((r) => `${r} Region Lead`),
                  ].join(' · ')}
                </small>
              )}
          </button>
          <span className="muted small">
            {totals.get(p.path)?.direct.total ?? 0} direct · {totals.get(p.path)?.total.total ?? 0}{' '}
            total reports
            <br />
            {countText(totals.get(p.path)?.total ?? { named: 0, others: 0, total: 0 })}
          </span>
        </div>
        {!shut && children.length > 0 && (
          <ul>{children.map((child) => renderPerson(child, route))}</ul>
        )}
      </li>
    );
  };
  const chainLinks = (p: OrgPerson, field: OrgChain) => {
    const links = orgAncestors(
      p.path,
      new Map(model.people.map((person) => [person.path, person[field]])),
    );
    return links.length ? (
      links.map((path, index) => (
        <span key={path}>
          {index > 0 && ' → '}
          {personLink(path)}
        </span>
      ))
    ) : (
      <span className="muted">Manager not set</span>
    );
  };
  const matrixCountries = [
    ...new Set([
      ...people.map((p) => p.country || 'Not set'),
      ...anonymous.map((group) => group.country || 'Not set'),
    ]),
  ].sort();
  const matrixPods = model.units.filter((u) => u.kind === 'pod' && visibleUnits.has(u.path));
  const matrixRows = [
    ...matrixPods.map((u) => ({ path: u.path, title: u.title })),
    ...(primaryUnplaced.length ? [{ path: NO_POD, title: 'No primary POD' }] : []),
  ];
  const cellPeople = (pod: string, c: string) =>
    people.filter((p) => (p.primaryPod ?? NO_POD) === pod && (p.country || 'Not set') === c);
  const cellOthers = (pod: string, c: string) =>
    anonymous
      .filter((group) => group.pod === pod && (group.country || 'Not set') === c)
      .reduce((sum, group) => sum + group.count, 0);
  const focusOn = (mode: OrgReportingMode) => {
    setLens('reporting');
    setChain(mode);
    setFocus(selected);
    setCollapsed(new Set());
  };
  const selectedTitle = selectedPerson?.title ?? selectedUnit?.title;
  return (
    <div className="organization-page" ref={pageRef}>
      <header className="org-header">
        <div>
          <h2>Organization</h2>
          <p className="muted small">People, groups, and parallel reporting structures</p>
        </div>
        <button type="button" className="primary" onClick={() => setCreate(true)}>
          + Organization note
        </button>
      </header>
      {create && (
        <CreateUnit
          model={model}
          onClose={() => setCreate(false)}
          onCreated={(p) => {
            select(p);
            setEditing(true);
            setCreate(false);
          }}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="org-toolbar">
        <fieldset className="org-tabs" aria-label="Organization views">
          {(['structure', 'reporting', 'matrix'] as const).map((l) => (
            <button
              type="button"
              key={l}
              aria-pressed={lens === l}
              onClick={() => {
                setLens(l);
                lsSet('cb.org.lens', l);
              }}
            >
              {l === 'structure' ? 'Structure' : l === 'reporting' ? 'Reporting' : 'Matrix'}
            </button>
          ))}
        </fieldset>
        <input
          aria-label="Filter organization"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a person, POD, or role…"
        />
        <select
          aria-label="Department"
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
        >
          <option value="">All departments</option>
          {model.units
            .filter((u) => u.kind === 'department')
            .map((u) => (
              <option key={u.path} value={u.path}>
                {u.title}
              </option>
            ))}
        </select>
        <select aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">All countries</option>
          {countries.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{' '}
          Include inactive
        </label>
      </div>
      <div className="org-view-options">
        <span className="muted small">
          {countText(overall)}
          {(query || country) && <> · {people.length} named matching filters</>}
        </span>
        {lens === 'structure' && (
          <label>
            <input
              type="checkbox"
              checked={secondary}
              onChange={(e) => setSecondary(e.target.checked)}
            />{' '}
            Show secondary memberships
          </label>
        )}
        {lens === 'reporting' && (
          <>
            <label>
              Reporting line{' '}
              <select value={chain} onChange={(e) => setChain(e.target.value as OrgReportingMode)}>
                <option value="functionalManager">Functional</option>
                <option value="entityManager">Entity</option>
                <option value="both">Both · unique people</option>
              </select>
            </label>
            {focus && (
              <button type="button" onClick={() => setFocus(null)}>
                Clear team focus
              </button>
            )}
          </>
        )}
        {(lens === 'structure' || (lens === 'reporting' && chain !== 'both')) && (
          <div className="org-actions">
            <button type="button" onClick={() => setCollapsed(new Set())}>
              Expand all
            </button>
            <button
              type="button"
              onClick={() =>
                setCollapsed(
                  new Set(
                    lens === 'structure'
                      ? model.units.map((u) => `unit:${u.path}`)
                      : model.people.map((p) => `${chain}:${p.path}`),
                  ),
                )
              }
            >
              Collapse all
            </button>
          </div>
        )}
      </div>
      {model.problems.length > 0 && (
        <details className="org-problems">
          <summary>
            {model.problems.length} relationship {model.problems.length === 1 ? 'issue' : 'issues'}{' '}
            to review
          </summary>
          {model.problems.map((p) => (
            <div key={`${p.path}:${p.field}:${p.message}`}>
              <button type="button" className="org-text-link" onClick={() => onOpenNote(p.path)}>
                {p.path}
              </button>{' '}
              · {p.field}: {p.message}
            </div>
          ))}
        </details>
      )}
      <div className={`org-workspace${selectedTitle ? ' with-inspector' : ''}`}>
        <section className="org-map" aria-label={`${lens} view`}>
          {model.units.length === 0 && lens === 'structure' && (
            <div className="org-empty">
              <h3>Start with your Department</h3>
              <p>
                Create Cash Equities, add Product Areas, then add product and support PODs. Existing
                people are listed below and can be assigned to a POD.
              </p>
              <button type="button" onClick={() => setCreate(true)}>
                Create organization note
              </button>
            </div>
          )}
          {lens === 'structure' && (
            <>
              <ul className="org-structure">{structure.roots.map((u) => renderUnit(u))}</ul>
              {primaryUnplaced.length > 0 && (
                <section className="org-unplaced">
                  <h3>No primary POD · {primaryUnplaced.length}</h3>
                  <div className="org-members">{primaryUnplaced.map((p) => personButton(p))}</div>
                </section>
              )}
            </>
          )}
          {lens === 'reporting' && (
            <>
              <p className="muted small org-hint">
                Counts include direct and indirect reports across the full organization, excluding
                the manager. Filters narrow the display; totals stay complete. Both follows either
                reporting line and counts each person once.
              </p>
              {missingReporting > 0 && (
                <p className="org-others">
                  {missingReporting} other employees have no{' '}
                  {chain === 'both'
                    ? 'reporting manager'
                    : chain === 'functionalManager'
                      ? 'functional manager'
                      : 'entity manager'}{' '}
                  assigned yet. They are included in POD sizes.
                </p>
              )}
              {chain === 'both' ? (
                <>
                  <div className="org-matrix org-report-table">
                    <table>
                      <caption>Both reporting lines · unique people</caption>
                      <thead>
                        <tr>
                          <th scope="col">Person</th>
                          <th scope="col">Direct reports</th>
                          <th scope="col">All reports</th>
                        </tr>
                      </thead>
                      <tbody>
                        {combinedRows.map((p) => {
                          const summary = totals.get(p.path);
                          return (
                            <tr key={p.path}>
                              <th scope="row">{personLink(p.path)}</th>
                              <td>{summary ? countText(summary.direct) : '0'}</td>
                              <td>{summary ? countText(summary.total) : '0'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {combinedFocus && (
                    <div className="org-cell-detail">
                      <h3>
                        {personByPath.get(focus ?? '')?.title} · {countText(combinedFocus.total)}
                      </h3>
                      <div className="org-members">
                        {combinedFocus.people
                          .filter((p) => peoplePaths.has(p.path))
                          .map((p) => personButton(p))}
                      </div>
                      {combinedFocus.groups.map((group) => (
                        <p className="org-others" key={group.id}>
                          {group.count} others · {unitLink(group.pod)} ·{' '}
                          {group.country || 'Country unknown'}
                        </p>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <ul className="org-reporting">{reporting.roots.map((p) => renderPerson(p))}</ul>
              )}
            </>
          )}
          {lens === 'matrix' && (
            <>
              <div className="org-matrix">
                <table>
                  <caption>
                    Primary POD membership by country · includes counted groups; unknown countries
                    are Not set
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">POD</th>
                      {matrixCountries.map((c) => (
                        <th key={c} scope="col">
                          {c}
                        </th>
                      ))}
                      <th scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrixRows.map((pod) => (
                      <tr key={pod.path}>
                        <th scope="row">{pod.path === NO_POD ? pod.title : unitLink(pod.path)}</th>
                        {matrixCountries.map((c) => {
                          const count = cellPeople(pod.path, c).length + cellOthers(pod.path, c);
                          return (
                            <td key={c}>
                              {count ? (
                                <button
                                  type="button"
                                  className="org-matrix-cell"
                                  aria-pressed={cell?.pod === pod.path && cell.country === c}
                                  onClick={() => setCell({ pod: pod.path, country: c })}
                                  aria-label={`${pod.title}, ${c}: ${count} people`}
                                >
                                  {count}
                                </button>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          );
                        })}
                        <td>
                          {people.filter((p) => (p.primaryPod ?? NO_POD) === pod.path).length +
                            anonymous
                              .filter((group) => group.pod === pod.path)
                              .reduce((sum, group) => sum + group.count, 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {cell && (
                <div className="org-cell-detail">
                  <h3>
                    {unitByPath.get(cell.pod)?.title ?? 'No primary POD'} · {cell.country}
                  </h3>
                  <div className="org-members">
                    {cellPeople(cell.pod, cell.country).map((p) => personButton(p))}
                  </div>
                  {cellOthers(cell.pod, cell.country) > 0 && (
                    <p className="org-others">
                      {cellOthers(cell.pod, cell.country)} other employees · names not recorded
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {people.length === 0 && anonymous.length === 0 && (
            <p className="muted">
              No people match these filters. Person notes appear here automatically.
            </p>
          )}
        </section>
        {selectedTitle && selected && (
          <aside className="org-inspector">
            <div className="org-inspector-heading">
              <div>
                <span className="muted small">
                  {selectedPerson ? 'Person' : ORG_LABELS[(selectedUnit as OrgUnit).kind]}
                </span>
                <h3>{selectedTitle}</h3>
              </div>
              <button
                type="button"
                aria-label="Close organization details"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
            </div>
            <div className="org-actions">
              <button type="button" onClick={() => onOpenNote(selected)}>
                Preview note
              </button>
              <button type="button" aria-pressed={editing} onClick={() => setEditing(!editing)}>
                {editing
                  ? 'View details'
                  : selectedUnit?.kind === 'pod'
                    ? 'Edit POD size & reporting'
                    : 'Edit relationships'}
              </button>
            </div>
            {editing ? (
              <OrganizationEditor key={selected} model={model} path={selected} onOpen={select} />
            ) : selectedPerson ? (
              <>
                <p className="muted">
                  {selectedPerson.role || 'Role not set'} ·{' '}
                  {[selectedPerson.country, selectedPerson.region].filter(Boolean).join(' / ') ||
                    'Location not set'}
                </p>
                <dl>
                  <dt>Functional chain</dt>
                  <dd>{chainLinks(selectedPerson, 'functionalManager')}</dd>
                  <dt>Entity chain</dt>
                  <dd>{chainLinks(selectedPerson, 'entityManager')}</dd>
                  <dt>Primary POD</dt>
                  <dd>
                    {selectedPerson.primaryPod ? unitLink(selectedPerson.primaryPod) : 'Not set'}
                  </dd>
                  <dt>Secondary PODs</dt>
                  <dd>
                    {selectedPerson.secondaryPods.length
                      ? selectedPerson.secondaryPods.map(unitLink)
                      : 'None recorded'}
                  </dd>
                  <dt>Leadership</dt>
                  <dd>
                    {model.units
                      .filter((u) => u.leads.includes(selected))
                      .map((u) => (
                        <div key={u.path}>
                          {unitLink(u.path)}{' '}
                          <span className="muted small">{ORG_LABELS[u.kind]} Lead</span>
                        </div>
                      ))}
                    {selectedPerson.countryLeadFor.map((c) => (
                      <div key={c}>{c} Country Lead</div>
                    ))}
                    {selectedPerson.regionLeadFor.map((r) => (
                      <div key={r}>{r} Region Lead</div>
                    ))}
                  </dd>
                </dl>
                <ReportingSummary path={selected} totals={reportTotals} onFocus={focusOn} />
                <button type="button" onClick={() => focusOn(chain)}>
                  Focus on this person’s team
                </button>
              </>
            ) : (
              selectedUnit && (
                <>
                  <dl>
                    <dt>Parent</dt>
                    <dd>{selectedUnit.parent ? unitLink(selectedUnit.parent) : 'Not set'}</dd>
                    <dt>Leads</dt>
                    <dd>
                      {selectedUnit.leads.length ? selectedUnit.leads.map(personLink) : 'Not set'}
                    </dd>
                    <dt>Mandate</dt>
                    <dd>{selectedUnit.mandate || 'Not set'}</dd>
                    <dt>Status</dt>
                    <dd>{selectedUnit.status || 'Not set'}</dd>
                    <dt>Total size</dt>
                    <dd>
                      {countText(orgHeadcount(model, selected, showInactive))}
                      {selectedUnit.kind !== 'pod' && (
                        <p className="muted small">
                          Calculated from child PODs. Select a POD to edit its total size.
                        </p>
                      )}
                    </dd>
                  </dl>
                  <div className="org-members">
                    {orgMembers(model, selected)
                      .filter((p) => showInactive || p.active)
                      .map((p) => personButton(p))}
                  </div>
                </>
              )
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
