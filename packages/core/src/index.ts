/**
 * @corpobrain/core — pure vault logic: parsing, linking, indexing.
 * No HTTP, no UI. Everything here must be testable against the golden files
 * described in docs/SPEC.md §12.
 */
export const SPEC_VERSION = '0.1.0';

export type { JiraProfile, VaultConfig } from './config.ts';
export { DEFAULT_CONFIG, loadConfig } from './config.ts';
export type { Keystore } from './crypto.ts';
export {
  CryptoError,
  changePassphrase,
  createKeystore,
  decryptNote,
  encryptNote,
  keystorePath,
  loadKeystore,
  opaqueName,
  saveKeystore,
  unlockKeystore,
} from './crypto.ts';
export { openDb, resetDb, SCHEMA_VERSION } from './db.ts';
export type { Eol, FrontmatterSplit, ParsedFrontmatter } from './frontmatter.ts';
export {
  deleteFrontmatterKey,
  parseFrontmatter,
  patchFrontmatter,
  setFrontmatterKey,
  splitFrontmatter,
} from './frontmatter.ts';
export type { Backlink, SearchHit, UpdateSummary } from './indexer.ts';
export { Indexer, JIRA_KEY_RE, JIRA_MARKER } from './indexer.ts';
export type {
  FetchFn,
  JiraAuth,
  JiraDeploymentInfo,
  JiraSprint,
  RawIssue,
} from './jira/adapter.ts';
export { JiraAdapter, JiraError } from './jira/adapter.ts';
export { fence, jiraTextToMarkdown, wikiToMarkdown } from './jira/convert.ts';
export { createJiraAdapter, loadJiraAuth } from './jira/credentials.ts';
export type { MergeOutcome, NormalizedIssue } from './jira/render.ts';
export {
  mergeIssueFile,
  neutralize,
  normalizeIssue,
  RENDER_VERSION,
  renderIssueFile,
} from './jira/render.ts';
export type { AdapterLike, SyncReport } from './jira/sync.ts';
export { JiraSync, jqlDate } from './jira/sync.ts';
export type { EffortUnit, IssueRiskInput, RiskFlag } from './planning.ts';
export { convertEffort, issueRiskFlags } from './planning.ts';
export type { HeadingRef, LinkKind, LinkRef, ScanOptions, ScanResult, TaskRef } from './scan.ts';
export { maskInlineCode, scanMarkdown } from './scan.ts';
export { generateUlid } from './ulid.ts';
export type { VaultFile } from './vault.ts';
export { matchesGlob, toPosix, walkVault, writeFileAtomic } from './vault.ts';
export type { VaultWatcher } from './watch.ts';
export { watchVault } from './watch.ts';
