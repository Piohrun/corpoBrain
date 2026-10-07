/**
 * @corpobrain/core — pure vault logic: parsing, linking, indexing.
 * No HTTP, no UI. Everything here must be testable against the golden files
 * described in docs/SPEC.md §12.
 */
export const SPEC_VERSION = '0.1.0';

export type { Absence, AbsenceKind, AvailabilityEntry, SprintSpan } from './availability.ts';
export {
  absencesBySprint,
  adjustCapacity,
  civilDay,
  dayStart,
  endExclusive,
  isCalendarDay,
  localDay,
  parseAvailability,
  personCell,
  renderAvailabilityTable,
  replaceAvailabilityTable,
  sprintDays,
  sprintStart,
  weekdaysIn,
} from './availability.ts';
export type { ArrangeResult, CalendarBlock, CalendarInput, CalendarLayout } from './calendar.ts';
export { arrangeCalendar, dateOfIndex, dayIndexOf, layoutCalendar } from './calendar.ts';
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
export type { FlowTimes, SprintChurn, StatusBand, StatusCategory } from './flow.ts';
export {
  daysBetween,
  flowTimes,
  mentionsSprint,
  percentile,
  sprintChurn,
  statusBands,
} from './flow.ts';
export type { Eol, FrontmatterSplit, ParsedFrontmatter } from './frontmatter.ts';
export {
  deleteFrontmatterKey,
  parseFrontmatter,
  patchFrontmatter,
  setFrontmatterKey,
  splitFrontmatter,
} from './frontmatter.ts';
export type {
  HealthIssue,
  HealthKind,
  HealthOptions,
  HealthPerson,
  HealthProblem,
  HealthReport,
  HealthSprint,
  HealthTotals,
  Severity,
} from './health.ts';
export { DEFAULT_HEALTH, sprintHealth } from './health.ts';
export type { HolidayEntry, HolidaysParse } from './holidays.ts';
export {
  BUILTIN_HOLIDAYS,
  normalizeCountry,
  parseHolidays,
  renderHolidaysTable,
  replaceHolidaysTable,
} from './holidays.ts';
export type { IdentityKind, IdentityMatch } from './identities.ts';
export {
  IDENTITY_KINDS,
  IdentityIndex,
  identitiesOf,
  normalizeIdentity,
} from './identities.ts';
export type { Backlink, SearchHit, UpdateSummary } from './indexer.ts';
export { Indexer, JIRA_KEY_RE, JIRA_MARKER } from './indexer.ts';
export type {
  ChangeHistory,
  FetchFn,
  JiraAuth,
  JiraDeploymentInfo,
  JiraSprint,
  RawIssue,
} from './jira/adapter.ts';
export { describeNetworkError, JiraAdapter, JiraError } from './jira/adapter.ts';
export { fence, jiraTextToMarkdown, wikiToMarkdown } from './jira/convert.ts';
export { createJiraAdapter, loadJiraAuth } from './jira/credentials.ts';
export type { ChangeEvent, ChangeKind, IssueSnapshot } from './jira/digest.ts';
export { DigestStore, diffIssue, formatEvent, snapshotOf } from './jira/digest.ts';
export { createProxyFetch, resolveProxyUrl } from './jira/proxy.ts';
export type {
  MergeOutcome,
  NormalizedIssue,
  Transition,
  TransitionField,
} from './jira/render.ts';
export {
  mergeIssueFile,
  neutralize,
  normalizeHistory,
  normalizeIssue,
  RENDER_VERSION,
  renderIssueFile,
} from './jira/render.ts';
export type { AdapterLike, SyncProgress, SyncReport } from './jira/sync.ts';
export { JiraSync, jqlDate } from './jira/sync.ts';
export type { Mention } from './mentions.ts';
export { findMentions, linkMention } from './mentions.ts';
export type {
  OrgAnonymousGroup,
  OrgChain,
  OrgCount,
  OrgFilters,
  OrgHeadcountGroup,
  OrgKind,
  OrgModel,
  OrgPerson,
  OrgProblem,
  OrgReportingMode,
  OrgReportSummary,
  OrgSource,
  OrgUnit,
} from './organization.ts';
export {
  buildOrganization,
  ORG_KINDS,
  ORG_LABELS,
  orgAncestors,
  orgAnonymousGroups,
  orgCount,
  orgCyclePaths,
  orgFilteredAnonymous,
  orgFilteredView,
  orgForest,
  orgHeadcount,
  orgMembers,
  orgParentAllowed,
  orgReportingTotals,
  orgReportingView,
  orgSourceType,
  orgStrings,
  orgTarget,
  orgText,
  orgUnitPaths,
} from './organization.ts';
export type {
  MailExport,
  MailPlan,
  MailTasksReport,
  OutlookMail,
} from './outlook/mail.ts';
export {
  applyMailTasks,
  mailTaskKey,
  planMail,
  readMailState,
  renderMailTask,
  tickTask,
} from './outlook/mail.ts';
export type {
  CalendarConfig,
  KnownMeeting,
  MeetingContext,
  MeetingPlan,
  MeetingsReport,
  OutlookAttendee,
  OutlookExport,
  OutlookMeeting,
  OutlookPerson,
  PersonResolver,
} from './outlook/meetings.ts';
export {
  applyMeetings,
  knownMeetingOf,
  meetingBaseName,
  mergeMeetingFile,
  neutralizeOutlook,
  OUTLOOK_MARKER,
  peopleIn,
  planMeeting,
  SUGGESTED,
  skipReason,
} from './outlook/meetings.ts';
export type { EffortUnit, IssueRiskInput, RiskFlag } from './planning.ts';
export { convertEffort, issueRiskFlags } from './planning.ts';
export type { ProjectDef, ProjectIssue, ProjectRollup } from './projects.ts';
export { addWorkingDays, projectOf, rollupProject, workingDaysBetween } from './projects.ts';
export type {
  HeadingRef,
  LinkKind,
  LinkRef,
  ScanOptions,
  ScanResult,
  TaskRef,
  TrackAnchor,
} from './scan.ts';
export { maskInlineCode, scanMarkdown, stripTrackMarkers, trackAnchors } from './scan.ts';
export type { SecretName } from './secrets.ts';
export { readSecret, readSecretsFile, SECRET_ENV, writeSecrets } from './secrets.ts';
export { naturalCompare } from './sort.ts';
export type { TeambookWrite, TeambookWrites } from './teambook/apply.ts';
export { buildTeambookWrites, nextBaseline } from './teambook/apply.ts';
export type { TeambookClientOptions } from './teambook/client.ts';
export { fetchTeambookSnapshot, normalizeSnapshot } from './teambook/client.ts';
export { TEAMBOOK_ADAPTER_READY, TeambookNotImplemented } from './teambook/parse.ts';
export type {
  BaselineValue,
  ChangeStatus,
  TeambookBaseline,
  TeambookChange,
  TeambookMatch,
  TeambookPlan,
} from './teambook/plan.ts';
export {
  emptyBaseline,
  inferKinds,
  planTeambookImport,
  slugify,
  TEAMBOOK_FIELDS,
  TEAMBOOK_ID_KEY,
} from './teambook/plan.ts';
export type {
  TeambookMembership,
  TeambookPod,
  TeambookSnapshot,
  TeambookUser,
} from './teambook/types.ts';
export { TeambookSchemaError } from './teambook/types.ts';
export { generateUlid } from './ulid.ts';
export type { VaultFile } from './vault.ts';
export { matchesGlob, toPosix, walkVault, writeFileAtomic } from './vault.ts';
export type { VaultWatcher } from './watch.ts';
export { watchVault } from './watch.ts';
