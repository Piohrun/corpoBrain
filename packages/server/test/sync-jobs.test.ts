import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type JobContext, type JobProgress, SyncJobService } from '../src/sync-jobs.ts';

interface FakeReport {
  profile: string;
  note: string;
}

/** A connector that is not Jira, to prove the service holds no Jira assumptions. */
class FakeService extends SyncJobService<FakeReport, JobProgress, { folder: string }> {
  run(body: (job: JobContext<FakeReport, JobProgress>) => Promise<FakeReport[]>) {
    return this.launch({ profiles: ['inbox'], full: false, settings: { folder: 'Inbox' } }, body);
  }
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-sync-jobs-'));
  file = join(dir, 'history.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SyncJobService', () => {
  it('keeps completed units and redacts secrets when a later unit fails', async () => {
    const service = new FakeService(file);
    const { completion } = service.run(async (job) => {
      job.addSecrets(['hunter2', undefined]);
      job.progress({ profile: 'inbox', phase: 'mail', current: 1, total: 2 });
      job.report({ profile: 'inbox', note: 'done' });
      job.retry('GET /mail?token=hunter2 timed out');
      expect(service.progress).toMatchObject({ detail: 'GET /mail?token=[redacted] timed out' });
      throw new Error('auth failed for hunter2');
    });
    await expect(completion).rejects.toThrow('hunter2');
    expect(service.status).toMatchObject({ syncing: false, progress: null });
    const reread = new FakeService(file);
    expect(reread.history[0]).toMatchObject({
      outcome: 'failed',
      retries: 1,
      error: 'auth failed for [redacted]',
      reports: [{ profile: 'inbox', note: 'done' }],
      progress: { profile: 'inbox', phase: 'mail', current: 1, total: 2 },
      settings: { folder: 'Inbox' },
    });
  });

  it('runs one job at a time and cancels through the signal', async () => {
    const service = new FakeService(file);
    const { id, completion } = service.run(
      (job) =>
        new Promise((_, reject) =>
          job.signal.addEventListener('abort', () => reject(job.signal.reason)),
        ),
    );
    expect(() => service.run(async () => [])).toThrow('sync already running');
    expect(() => service.cancel('other')).toThrow('no longer running');
    service.cancel(id);
    await expect(completion).rejects.toThrow('Sync cancelled');
    expect(service.history[0]).toMatchObject({ id, outcome: 'cancelled', error: null });
  });
});
