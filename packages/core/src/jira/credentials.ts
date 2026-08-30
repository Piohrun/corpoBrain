/**
 * Jira credentials. Never stored in config.json. Sources, in order:
 * 1. CORPOBRAIN_JIRA_TOKEN (+ CORPOBRAIN_JIRA_EMAIL for cloud basic auth)
 * 2. <vault>/.corpobrain/secrets.json  { "jiraToken": "...", "jiraEmail": "..." }
 *    (gitignored by `corpobrain init`; keep it out of any repo)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultConfig } from '../config.ts';
import { JiraAdapter, type JiraAuth } from './adapter.ts';

export function loadJiraAuth(root: string, config: VaultConfig): JiraAuth | null {
  let token = process.env.CORPOBRAIN_JIRA_TOKEN;
  let email = process.env.CORPOBRAIN_JIRA_EMAIL;
  if (!token) {
    const file = join(root, '.corpobrain', 'secrets.json');
    if (existsSync(file)) {
      try {
        const s = JSON.parse(readFileSync(file, 'utf8')) as {
          jiraToken?: string;
          jiraEmail?: string;
        };
        token = s.jiraToken;
        email ??= s.jiraEmail;
      } catch {
        /* fallthrough */
      }
    }
  }
  if (!token) return null;
  return { mode: config.jira.auth, token, ...(email ? { email } : {}) };
}

export function createJiraAdapter(root: string, config: VaultConfig): JiraAdapter {
  if (!config.jira.baseUrl) {
    throw new Error('jira.baseUrl is not configured (.corpobrain/config.json)');
  }
  const auth = loadJiraAuth(root, config);
  if (!auth) {
    throw new Error(
      'no Jira token: set CORPOBRAIN_JIRA_TOKEN (and CORPOBRAIN_JIRA_EMAIL for cloud) or .corpobrain/secrets.json',
    );
  }
  return new JiraAdapter(config.jira.baseUrl, auth, config.jira.deployment);
}
