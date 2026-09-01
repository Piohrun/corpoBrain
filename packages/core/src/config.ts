/** Vault configuration per docs/SPEC.md §11. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface JiraProfile {
  name: string;
  jql: string;
  folder: string;
  intervalMinutes: number;
  boards: number[];
  futureSprints: number;
}

export interface VaultConfig {
  version: number;
  folders: {
    daily: string;
    notes: string;
    jira: string;
    people: string;
    projects: string;
    planning: string;
    templates: string;
    private: string;
    attachments: string;
  };
  ignore: string[];
  index: { assignIds: boolean };
  links: { newNoteFolder: string };
  capacity: {
    unit: 'days' | 'points' | 'hours';
    pointsPerDay: number;
    hoursPerDay: number;
    sprintLengthDays: number;
    /** pre-filled bandwidth for people without an explicit capacity */
    defaultCapacity: number | null;
  };
  jira: {
    baseUrl: string;
    /** forward proxy for Jira calls, e.g. http://proxy.corp:8080 (empty = direct / env vars) */
    proxyUrl: string;
    deployment: 'auto' | 'datacenter' | 'cloud';
    auth: 'bearer' | 'basic';
    projectKeys: string[];
    estimateField: string;
    estimateUnit: 'points' | 'days' | 'hours' | 'seconds';
    syncComments: boolean;
    createPeople: boolean;
    autolinkMentions: boolean;
    missingMarker: 'skip' | 'append' | 'overwrite';
    /** write-back safety ladder; nothing is ever sent to Jira unless 'on' */
    writeback: 'off' | 'dry-run' | 'on';
    profiles: JiraProfile[];
  };
  /** out-of-office and support rota, feeding sprint bandwidth */
  availability: {
    /** the note holding the availability table */
    file: string;
    /** the note holding the country bank-holiday table */
    holidaysFile: string;
    /** share of their own work a person on support rota is still expected to do */
    supportFactor: number;
  };
  /** sprint-health thresholds (Planning → Sprint health) */
  health: {
    /** raw estimate at or above which an issue should be split */
    bigIssue: number;
    /** days without an update before an in-progress issue is flagged */
    staleDays: number;
    /** flag people below this fraction of their bandwidth as having room */
    underloadPct: number;
  };
  private: { lockAfterMinutes: number };
  git: { autoCommit: boolean; intervalMinutes: number };
}

export const DEFAULT_CONFIG: VaultConfig = {
  version: 1,
  folders: {
    daily: 'daily',
    notes: 'notes',
    jira: 'jira',
    people: 'people',
    projects: 'projects',
    planning: 'planning',
    templates: 'templates',
    private: 'private',
    attachments: 'attachments',
  },
  ignore: [],
  index: { assignIds: true },
  links: { newNoteFolder: 'notes' },
  capacity: {
    unit: 'days',
    pointsPerDay: 1,
    hoursPerDay: 8,
    sprintLengthDays: 10,
    defaultCapacity: null,
  },
  jira: {
    baseUrl: '',
    proxyUrl: '',
    deployment: 'auto',
    auth: 'bearer',
    projectKeys: [],
    estimateField: '',
    estimateUnit: 'points',
    syncComments: false,
    createPeople: true,
    autolinkMentions: false,
    missingMarker: 'skip',
    writeback: 'off',
    profiles: [],
  },
  availability: {
    file: 'planning/availability.md',
    holidaysFile: 'planning/holidays.md',
    supportFactor: 0,
  },
  health: { bigIssue: 8, staleDays: 5, underloadPct: 0.5 },
  private: { lockAfterMinutes: 10 },
  git: { autoCommit: true, intervalMinutes: 10 },
};

function merge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (
      v &&
      b &&
      typeof v === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(v) &&
      !Array.isArray(b)
    ) {
      out[k] = merge(b as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Load `<vault>/.corpobrain/config.json` over the defaults. Always returns a
 * fresh object: callers mutate their config in place, and DEFAULT_CONFIG must
 * never leak between vaults in one process. A missing file is the normal
 * first-run case; an unreadable one is reported, not silently ignored.
 */
export function loadConfig(
  vaultRoot: string,
  warn: (msg: string) => void = console.warn,
): VaultConfig {
  const file = join(vaultRoot, '.corpobrain', 'config.json');
  const base = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return base as unknown as VaultConfig;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('config must be a JSON object');
    return merge(base, parsed as Record<string, unknown>) as unknown as VaultConfig;
  } catch (e) {
    warn(`${file} is not valid — using defaults (${e instanceof Error ? e.message : String(e)})`);
    return base as unknown as VaultConfig;
  }
}
