/**
 * @corpobrain/core — pure vault logic: parsing, linking, indexing.
 * No HTTP, no UI. Everything here must be testable against the golden files
 * described in docs/SPEC.md §12.
 */
export const SPEC_VERSION = '0.1.0';

export type { Eol, FrontmatterSplit, ParsedFrontmatter } from './frontmatter.ts';
export {
  deleteFrontmatterKey,
  parseFrontmatter,
  patchFrontmatter,
  setFrontmatterKey,
  splitFrontmatter,
} from './frontmatter.ts';
export { generateUlid } from './ulid.ts';
