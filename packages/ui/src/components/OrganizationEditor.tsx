import { useCallback, useEffect, useRef, useState } from 'react';
import { ORG_LABELS, type OrgModel, orgParentAllowed } from '../../../core/src/organization.ts';
import { organizationApi } from '../api.ts';
import { useVaultEvents } from '../hooks.ts';
import { PodHeadcountEditor } from './OrganizationHeadcount.tsx';

export const orgLink = (path: string | null): string | null =>
  path ? `[[${path.replace(/\.md$/i, '')}]]` : null;

export function useOrganization() {
  const [model, setModel] = useState<OrgModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const run = ++sequence.current;
    organizationApi
      .get()
      .then((fresh) => {
        if (run === sequence.current) {
          setModel(fresh);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (run === sequence.current) setError(e.message);
      });
  }, []);
  useEffect(() => {
    refresh();
    return () => {
      ++sequence.current;
    };
  }, [refresh]);
  useVaultEvents(refresh);
  return { model, error, refresh };
}

function ReferenceSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string | null;
  options: { path: string; title: string }[];
  onChange: (path: string | null) => void;
  disabled: boolean;
}) {
  return (
    <label className="org-field">
      <span>{label}</span>
      <select
        disabled={disabled}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Not set</option>
        {options.map((o) => (
          <option key={o.path} value={o.path}>
            {o.title} · {o.path.replace(/\.md$/, '')}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Edits a single canonical note at a time. Leadership shown on a person edits the group. */
export function OrganizationEditor({
  model,
  path,
  onOpen,
  beforeSave,
}: {
  model: OrgModel;
  path: string;
  onOpen: (path: string) => void;
  beforeSave?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const person = model.people.find((p) => p.path === path);
  const unit = model.units.find((u) => u.path === path);
  if (!person && !unit) return null;
  const save = async (kind: 'person' | 'unit', target: string, patch: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await beforeSave?.();
      await organizationApi.patch(kind, target, patch);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const patch = (value: Record<string, unknown>) =>
    void save(person ? 'person' : 'unit', path, value);
  const pods = model.units.filter((u) => u.kind === 'pod');
  const peers = model.people.filter((p) => p.path !== path);
  const leadership = model.units.filter((u) => u.leads.includes(path));
  const selection = (
    label: string,
    selected: string[],
    options: { path: string; title: string }[],
    commit: (paths: string[]) => void,
  ) => (
    <div className="org-field">
      <label>
        <span>{label}</span>
        <select
          disabled={busy}
          value=""
          onChange={(e) => {
            if (e.target.value) commit([...selected, e.target.value]);
          }}
        >
          <option value="">Add…</option>
          {options
            .filter((o) => !selected.includes(o.path))
            .map((o) => (
              <option key={o.path} value={o.path}>
                {o.title} · {o.path.replace(/\.md$/, '')}
              </option>
            ))}
        </select>
      </label>
      <span className="org-selected-links">
        {selected.map((target) => (
          <span key={target} className="org-selected-link">
            <button type="button" className="org-text-link" onClick={() => onOpen(target)}>
              {options.find((o) => o.path === target)?.title ?? target}
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label={`Remove ${options.find((o) => o.path === target)?.title ?? target} from ${label}`}
              onClick={() => commit(selected.filter((p) => p !== target))}
            >
              ×
            </button>
          </span>
        ))}
      </span>
    </div>
  );
  return (
    <div className="org-editor" aria-busy={busy}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {person ? (
        <>
          <ReferenceSelect
            label="Functional Manager"
            value={person.functionalManager}
            options={peers}
            disabled={busy}
            onChange={(p) => patch({ functional_manager: orgLink(p) })}
          />
          <ReferenceSelect
            label="Entity Manager"
            value={person.entityManager}
            options={peers}
            disabled={busy}
            onChange={(p) => patch({ entity_manager: orgLink(p) })}
          />
          <ReferenceSelect
            label="Primary POD"
            value={person.primaryPod}
            options={pods}
            disabled={busy}
            onChange={(p) =>
              patch({
                primary_pod: orgLink(p),
                secondary_pods: person.secondaryPods.filter((s) => s !== p).map(orgLink),
              })
            }
          />
          {selection(
            'Secondary PODs',
            person.secondaryPods,
            pods.filter((p) => p.path !== person.primaryPod),
            (paths) => patch({ secondary_pods: paths.map(orgLink) }),
          )}
          <div className="org-field">
            <span>Leads</span>
            {leadership.map((u) => (
              <div className="org-selected-link" key={u.path}>
                <button type="button" className="org-text-link" onClick={() => onOpen(u.path)}>
                  {u.title} · {ORG_LABELS[u.kind]}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove leadership of ${u.title}`}
                  onClick={() =>
                    void save('unit', u.path, {
                      leads: u.leads.filter((p) => p !== path).map(orgLink),
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <select
              aria-label="Add leadership responsibility"
              disabled={busy}
              value=""
              onChange={(e) => {
                const u = model.units.find((u) => u.path === e.target.value);
                if (u) void save('unit', u.path, { leads: [...u.leads, path].map(orgLink) });
              }}
            >
              <option value="">Add leadership…</option>
              {model.units
                .filter((u) => !u.leads.includes(path))
                .map((u) => (
                  <option key={u.path} value={u.path}>
                    {u.title} · {ORG_LABELS[u.kind]}
                  </option>
                ))}
            </select>
          </div>
          {(['country', 'region'] as const).map((scope) => {
            const values = scope === 'country' ? person.countryLeadFor : person.regionLeadFor;
            return (
              <label className="org-field" key={scope}>
                <span>{scope === 'country' ? 'Country Lead for' : 'Region Lead for'}</span>
                <input
                  key={`${path}:${values.join(',')}`}
                  disabled={busy}
                  defaultValue={values.join(', ')}
                  placeholder={scope === 'country' ? 'PL, UK' : 'EMEA, APAC'}
                  onBlur={(e) => {
                    const next = e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    if (JSON.stringify(next) !== JSON.stringify(values))
                      patch({ [`${scope}_lead_for`]: next });
                  }}
                />
              </label>
            );
          })}
          <p className="muted small">
            Leadership scope is separate from location. Set each lead’s Entity Manager to connect
            the country and region chains.
          </p>
        </>
      ) : (
        unit && (
          <>
            {unit.kind === 'pod' && (
              <PodHeadcountEditor
                key={JSON.stringify([
                  unit.path,
                  unit.headcount,
                  unit.headcountReporting,
                  unit.headcountFunctionalManager,
                  unit.headcountEntityManager,
                  unit.headcountGroups,
                ])}
                model={model}
                unit={unit}
                busy={busy}
                onSave={(patch) => save('unit', unit.path, patch)}
              />
            )}
            <ReferenceSelect
              label="Parent organization"
              value={unit.parent}
              options={model.units.filter(
                (u) => orgParentAllowed(unit.kind, u.kind) && u.path !== path,
              )}
              disabled={busy}
              onChange={(p) => patch({ parent: orgLink(p) })}
            />
            {selection('Leads', unit.leads, model.people, (paths) =>
              patch({ leads: paths.map(orgLink) }),
            )}
            {unit.kind === 'pod' && (
              <label className="org-field">
                <span>POD purpose</span>
                <select
                  value={unit.podKind || 'product'}
                  disabled={busy}
                  onChange={(e) => patch({ pod_kind: e.target.value })}
                >
                  <option value="product">Product delivery</option>
                  <option value="support">Support / management</option>
                </select>
              </label>
            )}
            <label className="org-field">
              <span>Mandate</span>
              <textarea
                key={`${path}:${unit.mandate}`}
                rows={3}
                disabled={busy}
                defaultValue={unit.mandate}
                onBlur={(e) => {
                  if (e.target.value !== unit.mandate) patch({ mandate: e.target.value });
                }}
              />
            </label>
            <label className="org-field">
              <span>Status</span>
              <input
                key={`${path}:${unit.status}`}
                defaultValue={unit.status}
                disabled={busy}
                placeholder="active"
                onBlur={(e) => {
                  if (e.target.value !== unit.status) patch({ status: e.target.value });
                }}
              />
            </label>
          </>
        )
      )}
    </div>
  );
}

export function OrganizationNoteFields({
  path,
  onOpen,
  beforeSave,
}: {
  path: string;
  onOpen: (path: string) => void;
  beforeSave?: () => Promise<void>;
}) {
  const { model, error } = useOrganization();
  if (error)
    return (
      <p className="error" role="alert">
        Organization: {error}
      </p>
    );
  if (!model || ![...model.people, ...model.units].some((item) => item.path === path)) return null;
  return (
    <details className="org-note-fields">
      <summary>Organization &amp; reporting</summary>
      <OrganizationEditor
        key={path}
        model={model}
        path={path}
        onOpen={onOpen}
        beforeSave={beforeSave}
      />
    </details>
  );
}
