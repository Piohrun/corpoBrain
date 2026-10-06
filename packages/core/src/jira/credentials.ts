/**
 * Jira credentials (see ../secrets.ts). Sources, in order:
 * 1. CORPOBRAIN_JIRA_TOKEN (+ CORPOBRAIN_JIRA_EMAIL for cloud basic auth)
 * 2. <vault>/.corpobrain/secrets.json  { "jiraToken": "...", "jiraEmail": "..." }
 *    (gitignored by `corpobrain init`; keep it out of any repo)
 */
import type { VaultConfig } from '../config.ts';
import { readSecretsFile, SECRET_ENV } from '../secrets.ts';
import { JiraAdapter, type JiraAuth } from './adapter.ts';
import { createProxyFetch, resolveProxyUrl } from './proxy.ts';

export function loadJiraAuth(root: string, config: VaultConfig): JiraAuth | null {
  let token = process.env[SECRET_ENV.jiraToken];
  let email = process.env[SECRET_ENV.jiraEmail];
  // An env token is used with the env email only; the file supplies both or neither.
  if (!token) {
    const file = readSecretsFile(root);
    token = file.jiraToken;
    email ??= file.jiraEmail;
  }
  if (!token) return null;
  return { mode: config.jira.auth, token, ...(email ? { email } : {}) };
}

export function createJiraAdapter(
  root: string,
  config: VaultConfig,
  signal?: AbortSignal,
): JiraAdapter {
  if (!config.jira.baseUrl) {
    throw new Error('jira.baseUrl is not configured (.corpobrain/config.json)');
  }
  const auth = loadJiraAuth(root, config);
  if (!auth) {
    throw new Error(
      'no Jira token: set CORPOBRAIN_JIRA_TOKEN (and CORPOBRAIN_JIRA_EMAIL for cloud) or .corpobrain/secrets.json',
    );
  }
  const proxy = resolveProxyUrl(config.jira.proxyUrl);
  return new JiraAdapter(
    config.jira.baseUrl,
    auth,
    config.jira.deployment,
    proxy ? createProxyFetch(proxy) : fetch,
    config.jira.requestTimeoutSeconds * 1000,
    config.jira.searchPageSize,
    signal,
  );
}
