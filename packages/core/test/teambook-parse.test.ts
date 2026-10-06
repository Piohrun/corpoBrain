/**
 * Tests for the real Teambook adapter (packages/core/src/teambook/parse.ts).
 * Completing the adapter (docs/TEAMBOOK.md):
 *   1. Save REDACTED sample responses under test/fixtures/teambook/
 *      (fake names, emails and ids; same structure). Never commit real data.
 *   2. Replace the it.todo entries below with tests against those files.
 *   3. Set TEAMBOOK_ADAPTER_READY = true in parse.ts.
 */
import { describe, expect, it } from 'vitest';
import * as adapter from '../src/teambook/parse.ts';
import { TeambookSchemaError } from '../src/teambook/types.ts';

describe.skipIf(adapter.TEAMBOOK_ADAPTER_READY)('Teambook adapter placeholders', () => {
  it('fail loudly until the adapter is completed', () => {
    expect(() => adapter.endpoints.hierarchy('X')).toThrow(adapter.TeambookNotImplemented);
    expect(() => adapter.parseHierarchy([], 'X')).toThrow('Teambook adapter not completed');
    expect(() => adapter.parseMembers({}, 'X')).toThrow('Teambook adapter not completed');
  });
});

describe('Teambook guards', () => {
  it('accept the expected shapes and name the path of anything else', () => {
    expect(adapter.asId(42, 'x.id')).toBe('42');
    expect(adapter.asId(' a1 ', 'x.id')).toBe('a1');
    expect(adapter.asOptionalText('', 'x.role')).toBeNull();
    expect(adapter.asOptionalBool(undefined, 'x.lead')).toBeNull();
    expect(() => adapter.asId('', 'pods[3].id')).toThrow(TeambookSchemaError);
    expect(() => adapter.asId(null, 'pods[3].id')).toThrow(
      'Teambook pods[3].id: unexpected response shape — expected an id, got null',
    );
    expect(() => adapter.asArray({}, 'members')).toThrow('expected a list, got object');
    expect(() => adapter.asOptionalText(5, 'x.name')).toThrow(
      'expected text or nothing, got number',
    );
  });
});

describe.runIf(adapter.TEAMBOOK_ADAPTER_READY)(
  'Teambook adapter (real responses, redacted)',
  () => {
    it.todo('builds the hierarchy request for a root POD, encoding the id');
    it.todo('parses the hierarchy fixture: every POD has an id, a name or details, and a parent');
    it.todo('parses the POD details fixture, mapping Teambook levels with kindOf');
    it.todo('parses a members fixture: users with emails, lead and primary flags only when stated');
    it.todo('follows pagination with nextPage and stops on the last page');
    it.todo('throws TeambookSchemaError on a response missing a required field');
  },
);
