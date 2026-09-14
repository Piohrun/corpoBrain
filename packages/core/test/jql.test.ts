import { describe, expect, it } from 'vitest';
import { incrementalJql } from '../src/jira/jql.ts';

describe('incremental JQL', () => {
  it.each([
    ['project = EXEC', '(project = EXEC) AND updated >= -15m'],
    [
      'project = EXEC OR assignee = currentUser() ORDER BY updated DESC, key ASC',
      '(project = EXEC OR assignee = currentUser()) AND updated >= -15m ORDER BY updated DESC, key ASC',
    ],
    ['project = EXEC order\nby key', '(project = EXEC) AND updated >= -15m order\nby key'],
    [
      'summary ~ "order by" ORDER BY key',
      '(summary ~ "order by") AND updated >= -15m ORDER BY key',
    ],
    [
      "summary ~ 'Bob\\'s order by' ORDER BY key",
      "(summary ~ 'Bob\\'s order by') AND updated >= -15m ORDER BY key",
    ],
    [
      'summary ~ "say \\"order by\\"" ORDER BY key',
      '(summary ~ "say \\"order by\\"") AND updated >= -15m ORDER BY key',
    ],
    [
      'filter in ("order by", "other") ORDER BY key',
      '(filter in ("order by", "other")) AND updated >= -15m ORDER BY key',
    ],
    ['ORDER BY updated DESC', 'updated >= -15m ORDER BY updated DESC'],
  ])('keeps the filter and final sort separate: %s', (query, expected) => {
    expect(incrementalJql(query, 15)).toBe(expected);
  });
});
