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
    profiles: JiraProfile[];
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
    planning: 'planning',
    templates: 'templates',
    private: 'private',
    attachments: 'attachments',
  },
  ignore: [],
  index: { assignIds: true },
  links: { newNoteFolder: 'notes' },
  capacity: { unit: 'days', pointsPerDay: 1, hoursPerDay: 8, sprintLengthDays: 10 },
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
    profiles: [],
  },
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

export function loadConfig(vaultRoot: string): VaultConfig {
  try {
    const raw = readFileSync(join(vaultRoot, '.corpobrain', 'config.json'), 'utf8');
    return merge(
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      JSON.parse(raw) as Record<string, unknown>,
    ) as unknown as VaultConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}
