/**
 * Storage boundary used by Agent memory. The SQLite implementation is kept in
 * a separate module so Runtime tests and future hosts can provide another
 * repository without importing Electron or a database driver.
 */
export { RepositoryError } from "./types.js";
export type {
  AppendEntryInput,
  CreateToolInvocationInput,
  CreateSessionInput,
  EntryPatch,
  Session,
  SessionEntry,
  SessionPatch,
  SessionRepository,
  RegisterToolInvocationInput,
  ToolInvocationRecord,
  ToolOutcomeInput,
} from "./types.js";
