import { describe, expect, it } from 'vitest';
import { JiraAdapter, JiraError } from '../src/jira/adapter.ts';

const fetchOf = (routes: Record<string, unknown>) =>
  (async (input: string | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    return new Response(JSON.stringify(hit ? hit[1] : { errorMessages: ['nope'] }), {
      status: hit ? 200 : 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

describe('devStatusSummary', () => {
  it('resolves the issue id and reads counts + instance types from the summary', async () => {
    const a = new JiraAdapter(
      'https://j',
      { mode: 'bearer', token: 't' },
      'datacenter',
      fetchOf({
        '/rest/api/2/issue/EXEC-1': { id: '10042' },
        'issueId=10042': {
          summary: {
            pullrequest: {
              overall: { count: 2 },
              byInstanceType: { githube: { name: 'GitHub Enterprise' } },
            },
            repository: {
              overall: { count: 1 },
              byInstanceType: { githube: { name: 'GitHub Enterprise' } },
            },
            branch: { overall: { count: 0 } },
          },
        },
      }),
    );
    expect(await a.devStatusSummary('EXEC-1')).toEqual({
      id: '10042',
      counts: { pullrequest: 2, repository: 1, branch: 0 },
      instances: ['GitHub Enterprise'],
    });
  });

  it('surfaces a missing dev-status API as a 404 JiraError', async () => {
    const a = new JiraAdapter(
      'https://j',
      { mode: 'bearer', token: 't' },
      'datacenter',
      fetchOf({ '/rest/api/2/issue/EXEC-1': { id: '1' } }),
    );
    await expect(a.devStatusSummary('EXEC-1')).rejects.toMatchObject({ status: 404 });
    await expect(a.devStatusSummary('EXEC-1')).rejects.toBeInstanceOf(JiraError);
  });
});
