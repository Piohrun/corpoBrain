import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSecret, readSecretsFile, writeSecrets } from '../src/secrets.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-secrets-'));
  vi.stubEnv('CORPOBRAIN_GITHUB_TOKEN', '');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('secrets', () => {
  it('merges per connector, keeps the file private, and lets env win', () => {
    expect(readSecretsFile(root)).toEqual({});
    writeSecrets(root, { jiraToken: 'jira-1' });
    writeSecrets(root, { githubToken: 'gh-1', jiraToken: undefined });
    const file = join(root, '.corpobrain', 'secrets.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      jiraToken: 'jira-1',
      githubToken: 'gh-1',
    });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readSecret(root, 'githubToken')).toBe('gh-1');
    vi.stubEnv('CORPOBRAIN_GITHUB_TOKEN', 'gh-env');
    expect(readSecret(root, 'githubToken')).toBe('gh-env');
    expect(readSecret(root, 'jiraEmail')).toBeUndefined();
  });
});
