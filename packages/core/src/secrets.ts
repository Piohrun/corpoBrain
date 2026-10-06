/**
 * Connector credentials. Never stored in config.json. They live in
 * <vault>/.corpobrain/secrets.json (0600, gitignored by `corpobrain init`),
 * and an environment variable, when set, takes precedence over the file.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SecretName = 'jiraToken' | 'jiraEmail' | 'githubToken' | 'teambookToken';

/** The env var that overrides each secret. */
export const SECRET_ENV: Record<SecretName, string> = {
  jiraToken: 'CORPOBRAIN_JIRA_TOKEN',
  jiraEmail: 'CORPOBRAIN_JIRA_EMAIL',
  githubToken: 'CORPOBRAIN_GITHUB_TOKEN',
  teambookToken: 'CORPOBRAIN_TEAMBOOK_TOKEN',
};

const secretsFile = (root: string) => join(root, '.corpobrain', 'secrets.json');

/** Everything in secrets.json; an unreadable or missing file is treated as empty. */
export function readSecretsFile(root: string): Partial<Record<SecretName, string>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(secretsFile(root), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [SecretName, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

/** One secret: its env var when non-empty, else the secrets file. */
export function readSecret(root: string, name: SecretName): string | undefined {
  return process.env[SECRET_ENV[name]] || readSecretsFile(root)[name] || undefined;
}

/** Merge into secrets.json; `undefined` leaves a value untouched. */
export function writeSecrets(
  root: string,
  update: { [K in SecretName]?: string | undefined },
): void {
  const secrets: Record<string, string> = readSecretsFile(root);
  for (const [name, value] of Object.entries(update))
    if (value !== undefined) secrets[name] = value;
  mkdirSync(join(root, '.corpobrain'), { recursive: true });
  writeFileSync(secretsFile(root), `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
}
