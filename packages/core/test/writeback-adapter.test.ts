import { describe, expect, it } from 'vitest';
import { JiraAdapter, JiraError } from '../src/jira/adapter.ts';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function fakeFetch(calls: Call[], status = 204, responseBody: unknown = null): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    return new Response(responseBody === null ? null : JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('adapter write primitives', () => {
  it('setAssignee on DC uses name + notifyUsers=false', async () => {
    const calls: Call[] = [];
    const a = new JiraAdapter(
      'https://j',
      { mode: 'bearer', token: 't' },
      'datacenter',
      fakeFetch(calls),
    );
    await a.setAssignee('EXEC-1', 'anna');
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      body: { fields: { assignee: { name: 'anna' } } },
    });
    expect(calls[0]?.url).toContain('/rest/api/2/issue/EXEC-1');
    expect(calls[0]?.url).toContain('notifyUsers=false');
    await a.setAssignee('EXEC-1', null);
    expect(calls[1]?.body).toEqual({ fields: { assignee: null } });
  });

  it('setAssignee on Cloud uses accountId, no notify param', async () => {
    const calls: Call[] = [];
    const a = new JiraAdapter(
      'https://j',
      { mode: 'basic', token: 't', email: 'e' },
      'cloud',
      fakeFetch(calls),
    );
    await a.setAssignee('EXEC-1', 'abc123');
    expect(calls[0]?.body).toEqual({ fields: { assignee: { accountId: 'abc123' } } });
    expect(calls[0]?.url).not.toContain('notifyUsers');
  });

  it('sprint moves hit the agile endpoints with issue lists', async () => {
    const calls: Call[] = [];
    const a = new JiraAdapter(
      'https://j',
      { mode: 'bearer', token: 't' },
      'datacenter',
      fakeFetch(calls),
    );
    await a.moveIssuesToSprint(412, ['EXEC-1', 'EXEC-2']);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { issues: ['EXEC-1', 'EXEC-2'] },
    });
    expect(calls[0]?.url).toContain('/rest/agile/1.0/sprint/412/issue');
    await a.moveIssuesToBacklog(['EXEC-3']);
    expect(calls[1]?.url).toContain('/rest/agile/1.0/backlog/issue');
  });

  it('write errors carry status and body', async () => {
    const calls: Call[] = [];
    const a = new JiraAdapter(
      'https://j',
      { mode: 'bearer', token: 't' },
      'datacenter',
      fakeFetch(calls, 403, { errorMessages: ['no permission'] }),
    );
    await expect(a.setAssignee('EXEC-1', 'x')).rejects.toThrow(JiraError);
    await expect(a.setAssignee('EXEC-1', 'x')).rejects.toThrow(/403.*no permission/s);
  });

  it('issueFields fetches only requested fields', async () => {
    const calls: Call[] = [];
    const a = new JiraAdapter(
      'https://j',
      { mode: 'bearer', token: 't' },
      'datacenter',
      fakeFetch(calls, 200, { fields: { assignee: { name: 'anna' } } }),
    );
    const f = await a.issueFields('EXEC-1', ['assignee', 'updated']);
    expect(calls[0]?.url).toContain('fields=assignee%2Cupdated');
    expect(f).toEqual({ assignee: { name: 'anna' } });
  });
});
