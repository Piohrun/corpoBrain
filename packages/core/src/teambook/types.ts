/**
 * The normalized Teambook model: the ONLY shape the importer sees. Whatever
 * the real API returns is translated into these types in parse.ts; nothing
 * downstream knows Teambook's field names. See docs/TEAMBOOK.md.
 */
import type { OrgKind } from '../organization.ts';

export interface TeambookPod {
  /** Teambook's stable id for the POD/team (never a display name) */
  id: string;
  name: string;
  /** parent POD id; null for the root of the fetched subtree */
  parentId: string | null;
  /**
   * Which corpoBrain level this node is. null when the API cannot tell: the
   * importer then infers it from depth (see inferKinds) and the user reviews.
   */
  kind: OrgKind | null;
  /** 'active' / 'inactive' or Teambook's own wording; null = unknown */
  status: string | null;
  /** short purpose text, if Teambook has one */
  mandate: string | null;
}

export interface TeambookUser {
  /** Teambook's stable id for the person */
  id: string;
  name: string;
  /** work email; the main key for matching existing person notes */
  email: string | null;
  /** job title / role */
  role: string | null;
  /** country as Teambook writes it; matched loosely, never invented */
  country: string | null;
  /** false only when Teambook says the person left; null = unknown */
  active: boolean | null;
}

export interface TeambookMembership {
  podId: string;
  userId: string;
  /** true/false when Teambook says which POD is the person's home; null = unknown */
  primary: boolean | null;
  /** the person leads this POD */
  lead: boolean;
}

/** One fetch of a POD subtree, saved to disk before anything is planned. */
export interface TeambookSnapshot {
  version: 1;
  fetchedAt: string;
  /** the POD the fetch started from; null = everything the API returned */
  rootId: string | null;
  pods: TeambookPod[];
  users: TeambookUser[];
  memberships: TeambookMembership[];
}

/** Thrown by parsers when a response does not have the expected shape. */
export class TeambookSchemaError extends Error {
  constructor(where: string, detail: string) {
    super(`Teambook ${where}: unexpected response shape — ${detail}`);
    this.name = 'TeambookSchemaError';
  }
}
