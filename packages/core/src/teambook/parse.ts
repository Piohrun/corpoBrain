/**
 * ─────────────────────────────────────────────────────────────────────────
 *  TEAMBOOK ADAPTER — the one file to complete for a real Teambook.
 *  Everything marked TODO(teambook) is a placeholder: endpoints, query
 *  parameters, auth header, pagination and response parsing. Nothing else
 *  in the importer knows Teambook's wire format. Read docs/TEAMBOOK.md
 *  ("Completing the adapter") before editing, and keep the rules there:
 *   - parse into the normalized types in ./types.ts only;
 *   - use the guards below, so an unexpected response THROWS instead of
 *     silently producing empty names/ids (which would plan bad changes);
 *   - never default a missing id; never guess `primary`, `lead`, `kind`;
 *   - add redacted response fixtures + tests in
 *     packages/core/test/teambook-parse.test.ts.
 * ─────────────────────────────────────────────────────────────────────────
 */
import type { OrgKind } from '../organization.ts';
import {
  type TeambookMembership,
  type TeambookPod,
  TeambookSchemaError,
  type TeambookUser,
} from './types.ts';

/** A request the client should make, relative to the configured base URL. */
export interface TeambookRequest {
  path: string;
  query?: Record<string, string>;
}

/** Thrown by every placeholder until the adapter is completed. */
export class TeambookNotImplemented extends Error {
  constructor(what: string) {
    super(
      `Teambook adapter not completed: ${what} (packages/core/src/teambook/parse.ts). Use a fixture snapshot meanwhile.`,
    );
    this.name = 'TeambookNotImplemented';
  }
}

export const TEAMBOOK_ADAPTER_READY = false; // TODO(teambook): true once the TODOs below are done

/** Headers for every request. */
export function authHeaders(token: string): Record<string, string> {
  // TODO(teambook): confirm the scheme (Bearer? an API-key header?).
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

/** The endpoints. Ids are always passed through encodeURIComponent. */
export const endpoints = {
  /**
   * POD details (names, status…), or null when the hierarchy response already
   * carries them and no second call is needed.
   */
  pods(): TeambookRequest | null {
    throw new TeambookNotImplemented('endpoints.pods'); // TODO(teambook)
  },
  /** The POD tree under `rootId` (or the whole tree when rootId is null). */
  hierarchy(_rootId: string | null): TeambookRequest {
    throw new TeambookNotImplemented('endpoints.hierarchy'); // TODO(teambook)
  },
  /** Users in one POD. */
  members(_podId: string): TeambookRequest {
    throw new TeambookNotImplemented('endpoints.members'); // TODO(teambook)
  },
};

/**
 * The next page of a paginated response, or null when this was the last one.
 * TODO(teambook): implement if any endpoint pages (cursor, offset, Link header…).
 */
export function nextPage(
  _request: TeambookRequest,
  _body: unknown,
  _headers: Headers,
): TeambookRequest | null {
  return null;
}

/** Response of endpoints.pods(): POD details. Parent ids optional here. */
export function parsePods(_body: unknown): TeambookPod[] {
  throw new TeambookNotImplemented('parsePods'); // TODO(teambook)
}

/**
 * Response of endpoints.hierarchy(): every POD in the subtree with its
 * parentId set (null only for the subtree root). Names may be missing here
 * if parsePods supplies them; the snapshot merges both by id.
 */
export function parseHierarchy(_body: unknown, _rootId: string | null): TeambookPod[] {
  throw new TeambookNotImplemented('parseHierarchy'); // TODO(teambook)
}

/** Response of endpoints.members(podId): the users and their membership in that POD. */
export function parseMembers(
  _body: unknown,
  _podId: string,
): { users: TeambookUser[]; memberships: TeambookMembership[] } {
  throw new TeambookNotImplemented('parseMembers'); // TODO(teambook)
}

/**
 * Teambook's own level name → corpoBrain level, or null when unknown.
 * TODO(teambook): map Teambook's type/level field if it has one.
 */
export function kindOf(_teambookLevel: unknown): OrgKind | null {
  return null;
}

// ───────────────────────────── guards ─────────────────────────────
// Use these instead of casts: they name the failing path in the error.

export function asObject(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TeambookSchemaError(where, `expected an object, got ${describe(value)}`);
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value))
    throw new TeambookSchemaError(where, `expected a list, got ${describe(value)}`);
  return value;
}

/** A required, non-empty string (numbers are accepted for ids and stringified). */
export function asId(value: unknown, where: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || !value.trim())
    throw new TeambookSchemaError(where, `expected an id, got ${describe(value)}`);
  return value.trim();
}

export function asText(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TeambookSchemaError(where, `expected text, got ${describe(value)}`);
  return value.trim();
}

/** Optional text: null/undefined/"" → null; anything else must be a string. */
export function asOptionalText(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string')
    throw new TeambookSchemaError(where, `expected text or nothing, got ${describe(value)}`);
  return value.trim() || null;
}

export function asOptionalBool(value: unknown, where: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean')
    throw new TeambookSchemaError(where, `expected true/false, got ${describe(value)}`);
  return value;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value;
}
