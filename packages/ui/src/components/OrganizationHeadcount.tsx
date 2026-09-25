import { useState } from 'react';
import {
  type OrgCount,
  type OrgModel,
  type OrgReportingMode,
  type OrgReportSummary,
  type OrgUnit,
  orgHeadcount,
} from '../../../core/src/organization.ts';

export function countText(count: OrgCount): string {
  return `${count.named} named + ${count.others} other${count.others === 1 ? '' : 's'} · ${count.total} total`;
}

export const REPORTING_LABELS: Record<OrgReportingMode, string> = {
  functionalManager: 'Functional',
  entityManager: 'Entity',
  both: 'Both',
};

export function ReportingSummary({
  path,
  totals,
  onFocus,
}: {
  path: string;
  totals: Record<OrgReportingMode, Map<string, OrgReportSummary>>;
  onFocus: (mode: OrgReportingMode) => void;
}) {
  return (
    <div className="org-report-summary">
      <h4>People reporting to this person</h4>
      <p className="muted small">
        All levels, excluding this person. Both follows either reporting line and counts each person
        once.
      </p>
      {(Object.keys(REPORTING_LABELS) as OrgReportingMode[]).map((mode) => {
        const reports = totals[mode].get(path);
        return (
          reports && (
            <button
              key={mode}
              type="button"
              className="org-report-stat"
              onClick={() => onFocus(mode)}
            >
              <strong>
                {REPORTING_LABELS[mode]} · {reports.total.total} total reports
              </strong>
              <span>
                {reports.total.named} named + {reports.total.others} others
              </span>
              <small>
                {reports.direct.total} direct · {reports.total.total - reports.direct.total}{' '}
                indirect
              </small>
            </button>
          )
        );
      })}
    </div>
  );
}

const link = (path: string) => (path ? `[[${path.replace(/\.md$/i, '')}]]` : null);

/** One atomic save keeps total size and the optional country/manager splits consistent. */
export function PodHeadcountEditor({
  model,
  unit,
  busy,
  onSave,
}: {
  model: OrgModel;
  unit: OrgUnit;
  busy: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [size, setSize] = useState(unit.headcount === null ? '' : String(unit.headcount));
  const [fallback, setFallback] = useState(unit.headcountReporting);
  const [functional, setFunctional] = useState(unit.headcountFunctionalManager ?? '');
  const [entity, setEntity] = useState(unit.headcountEntityManager ?? '');
  const [groups, setGroups] = useState(
    unit.headcountGroups.map((group) => ({
      id: group.id,
      count: String(group.count),
      country: group.country,
      functional: group.functionalManager ?? '',
      entity: group.entityManager ?? '',
    })),
  );
  const named = model.people.filter((p) => p.active && p.primaryPod === unit.path).length;
  const others = size === '' ? 0 : Math.max(0, Number(size) - named);
  const assigned = groups.reduce((sum, group) => sum + Number(group.count), 0);
  const managerSelect = (
    label: string,
    value: string,
    commit: (path: string) => void,
    defaultLabel: string,
  ) => (
    <label className="org-field">
      <span>{label}</span>
      <select value={value} disabled={busy} onChange={(e) => commit(e.target.value)}>
        <option value="">{defaultLabel}</option>
        {model.people.map((person) => (
          <option key={person.path} value={person.path}>
            {person.title} · {person.path.replace(/\.md$/, '')}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="org-headcount-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        await onSave({
          headcount: size === '' ? null : Number(size),
          headcount_reporting: fallback,
          headcount_functional_manager: link(functional),
          headcount_entity_manager: link(entity),
          headcount_groups:
            size === ''
              ? []
              : groups.map((group) => ({
                  id: group.id,
                  count: Number(group.count),
                  country: group.country.trim(),
                  functional_manager: link(group.functional),
                  entity_manager: link(group.entity),
                })),
        });
      }}
    >
      <h4>POD size</h4>
      <label className="org-field">
        <span>Total POD size</span>
        <input
          type="number"
          min={named}
          step="1"
          value={size}
          disabled={busy}
          placeholder={`${named} named people only`}
          onChange={(e) => setSize(e.target.value)}
        />
      </label>
      <p className="small">
        {named} named people + {others} other employees
      </p>
      <button
        type="submit"
        className="primary"
        disabled={busy || (size !== '' && assigned > others)}
      >
        Save POD size &amp; reporting
      </button>
      <p className="muted small">Saved: {countText(orgHeadcount(model, unit.path))}</p>
      {size !== '' && assigned > others && (
        <p className="error small" role="alert">
          This POD has {assigned} other employees assigned to counted groups. Reduce those group
          counts below, or set the total size to at least {named + assigned}.
        </p>
      )}
      <p className="muted small">
        Includes active primary members. Leave blank to count named people only. Product Areas and
        Departments add up their PODs automatically.
      </p>
      {size !== '' && (
        <>
          <label className="org-field">
            <span>Default reporting for other employees</span>
            <select
              value={fallback}
              disabled={busy}
              onChange={(e) => setFallback(e.target.value as 'pod_leads' | 'explicit')}
            >
              <option value="pod_leads">POD lead(s)</option>
              <option value="explicit">Assigned managers only</option>
            </select>
          </label>
          {managerSelect(
            'Functional manager for others',
            functional,
            setFunctional,
            fallback === 'pod_leads' ? 'Use POD lead(s)' : 'Not assigned',
          )}
          {managerSelect(
            'Entity manager for others',
            entity,
            setEntity,
            fallback === 'pod_leads' ? 'Use POD lead(s)' : 'Not assigned',
          )}
          <details
            className="org-counted-groups"
            open={(size !== '' && assigned > others) || undefined}
          >
            <summary>Split other employees (optional)</summary>
            <p className="muted small">
              For example: 8 in Poland and 6 in India with different entity managers. Each row
              represents distinct people; the same row is counted once in Both.
            </p>
            {groups.map((group, index) => {
              const update = (patch: Partial<typeof group>) =>
                setGroups((old) =>
                  old.map((item) => (item.id === group.id ? { ...item, ...patch } : item)),
                );
              return (
                <fieldset className="org-counted-group" key={group.id}>
                  <legend>Group {index + 1}</legend>
                  <label className="org-field">
                    <span>Other employees in group {index + 1}</span>
                    <input
                      type="number"
                      required
                      min="1"
                      step="1"
                      value={group.count}
                      disabled={busy}
                      onChange={(e) => update({ count: e.target.value })}
                    />
                  </label>
                  <label className="org-field">
                    <span>Country for group {index + 1}</span>
                    <input
                      value={group.country}
                      disabled={busy}
                      placeholder="Unknown"
                      onChange={(e) => update({ country: e.target.value })}
                    />
                  </label>
                  {managerSelect(
                    `Functional manager for group ${index + 1}`,
                    group.functional,
                    (functional) => update({ functional }),
                    'Use POD default',
                  )}
                  {managerSelect(
                    `Entity manager for group ${index + 1}`,
                    group.entity,
                    (entity) => update({ entity }),
                    'Use POD default',
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setGroups((old) => old.filter((item) => item.id !== group.id))}
                  >
                    Remove group {index + 1}
                  </button>
                </fieldset>
              );
            })}
            <button
              type="button"
              disabled={busy || assigned >= others}
              onClick={() =>
                setGroups((old) => [
                  ...old,
                  {
                    id: crypto.randomUUID(),
                    count: String(Math.max(1, others - assigned)),
                    country: '',
                    functional: '',
                    entity: '',
                  },
                ])
              }
            >
              + Counted group
            </button>
            <p className={assigned > others ? 'error small' : 'muted small'}>
              {assigned > others
                ? 'Groups exceed the other employees available. Reduce a group or increase POD size.'
                : `${others - assigned} other employees use the POD defaults; their country is unknown.`}
            </p>
          </details>
        </>
      )}
    </form>
  );
}
