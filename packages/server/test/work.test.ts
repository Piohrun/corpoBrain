import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportWork } from '@corpobrain/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;
const json = async (r: Response) => (await r.json()) as never;
const put = (body: object) =>
  app.request('/api/work', { method: 'PUT', body: JSON.stringify(body) });

beforeEach(() => {
  root = join(tmpdir(), `cb-worksrv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'plain.md'), '# Plain\n');
  vault = new VaultService(root, ':memory:');
  app = createApp(vault);
});
afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

/** what the CLI or the MCP server does: write the file; the app only indexes it */
function report(branch: string, extra: object = {}): string {
  const r = reportWork(root, 'work', {
    repo: 'exec-gateway',
    branch,
    summary: 'did things',
    ...extra,
  });
  vault.indexer.update();
  return r.path;
}

describe('work log API', () => {
  it('lists the branches agents have reported on, with their status', async () => {
    expect(await json(await app.request('/api/work'))).toEqual([]);
    report('feature/a', { next: 'raise the PR', waitingOn: 'me', issue: 'EXEC-7', chat: 'c1' });
    report('feature/b', { stage: 'on-uat' });
    const items = (await json(await app.request('/api/work'))) as Record<string, unknown>[];
    expect(items).toMatchObject([
      {
        path: 'work/exec-gateway feature-a.md',
        title: 'feature/a',
        repo: 'exec-gateway',
        branch: 'feature/a',
        stage: 'dev',
        waitingOn: 'me',
        next: 'raise the PR',
        issue: 'EXEC-7',
        chat: 'c1',
      },
      { branch: 'feature/b', stage: 'on-uat', waitingOn: 'nobody', next: null },
    ]);
    expect(typeof items[0]?.updated).toBe('string');
  });

  it("edits from the app change the status and keep the user's notes", async () => {
    const path = report('feature/a', { next: 'old' });
    const abs = join(root, path);
    writeFileSync(abs, `${readFileSync(abs, 'utf8')}keep this\n`);
    vault.indexer.update();
    const res = await put({ path, stage: 'in-uat-branch', waitingOn: 'tester', next: null });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      stage: 'in-uat-branch',
      waitingOn: 'tester',
      next: null,
    });
    const text = readFileSync(abs, 'utf8');
    expect(text).toContain('**you** — moved to In the UAT branch');
    expect(text.endsWith('## My notes\n\nkeep this\n')).toBe(true);
    expect(await json(await app.request('/api/work'))).toMatchObject([
      { stage: 'in-uat-branch', waitingOn: 'tester' },
    ]);
  });

  it('refuses what is not a work note or not a known value', async () => {
    const path = report('feature/a');
    expect((await put({ path, stage: 'shipped' })).status).toBe(400);
    expect((await put({ path, waitingOn: 'everyone' })).status).toBe(400);
    expect((await put({ path, next: 5 })).status).toBe(400);
    expect((await put({ path: 'notes/plain.md', stage: 'dev' })).status).toBe(400);
    expect((await put({ path: 'work/nope.md', stage: 'dev' })).status).toBe(404);
    expect((await put({ stage: 'dev' })).status).toBe(400);
  });

  it('hands out agent instructions with this vault in them', async () => {
    const res = (await json(await app.request('/api/work/instructions'))) as {
      text: string;
      vault: string;
    };
    expect(res.vault).toBe(root);
    expect(res.text).toContain(`--vault "${root}"`);
    expect(res.text).toContain('work report');
  });
});
