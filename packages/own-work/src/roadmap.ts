import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

import {
  defaultStandaloneLayout,
  resolveEnvelopeContext,
  resolveWorkspaceLayout,
  workspaceWorkRelativePath,
} from "absorb-anything-core";
import { loadManifest } from "absorb-anything-core";
import { loadNativeProject, validateNativeProjectStructure } from "absorb-anything-core";
import { allocateReadableId, isReadableId } from "absorb-anything-core";
import type { WorkspaceLayout } from "absorb-anything-core";
import { identitySafeRealpath } from "./filesystem-boundary.js";
import { showTask } from "./task.js";
import {
  TaskInvalidEncodingError,
  TaskLockUnavailableError,
  TaskStorageBoundaryError,
  assertTaskStorageBoundary,
  atomicWriteTaskText,
  readTaskText,
  withTaskLock,
} from "./tasks/task-storage.js";

export const ROADMAP_STATES = ["candidate", "committed", "realized", "retired"] as const;
export type RoadmapState = (typeof ROADMAP_STATES)[number];
export const ROADMAP_HORIZONS = ["now", "next", "later", "unscheduled"] as const;
export type RoadmapHorizon = (typeof ROADMAP_HORIZONS)[number];
export type RoadmapArchiveScope = "live" | "archived" | "all";

export interface RoadmapTaskRef {
  readonly kind: "assay.task";
  readonly id: string;
}

export interface RoadmapItem {
  readonly __schema: 1;
  readonly id: string;
  readonly title: string;
  readonly state: RoadmapState;
  readonly horizon: RoadmapHorizon;
  readonly order: number | null;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly depends_on: readonly string[];
  readonly task_refs: readonly RoadmapTaskRef[];
  readonly superseded_by: readonly string[];
}

export interface RoadmapTaskProjection extends RoadmapTaskRef {
  readonly unresolved: boolean;
  readonly archived?: boolean;
  readonly title?: string;
  readonly status?: string;
}

export interface RoadmapRecordResult {
  readonly root: string;
  readonly path: string;
  readonly archived: boolean;
  readonly item: RoadmapItem;
  readonly outcome: string;
  readonly tasks: readonly RoadmapTaskProjection[];
}

export interface RoadmapIssue {
  readonly code: string;
  readonly message: string;
  readonly id?: string;
  readonly path?: string;
  readonly archived?: boolean;
}

export interface RoadmapListEntry {
  readonly id: string;
  readonly path: string;
  readonly archived: boolean;
  readonly title: string;
  readonly state: RoadmapState;
  readonly horizon: RoadmapHorizon;
  readonly order: number | null;
  readonly revision: number;
  readonly depends_on: readonly string[];
  readonly superseded_by: readonly string[];
  readonly tasks: readonly RoadmapTaskProjection[];
}

export interface RoadmapListResult {
  readonly root: string;
  readonly items: readonly RoadmapListEntry[];
  readonly issues: readonly RoadmapIssue[];
  readonly next_cursor?: string;
}

export interface RoadmapValidationResult {
  readonly root: string;
  readonly valid: boolean;
  readonly items: readonly {
    readonly id: string;
    readonly path: string;
    readonly archived: boolean;
    readonly valid: boolean;
    readonly issues: readonly RoadmapIssue[];
  }[];
  readonly issues: readonly RoadmapIssue[];
}

export type RoadmapErrorCode =
  | "ROADMAP_INVALID"
  | "ROADMAP_INVALID_ENCODING"
  | "ROADMAP_ID_INVALID"
  | "ROADMAP_NOT_FOUND"
  | "ROADMAP_ALREADY_EXISTS"
  | "ROADMAP_CONFLICT"
  | "ROADMAP_TERMINAL"
  | "ROADMAP_NOT_TERMINAL"
  | "ROADMAP_REVISION_CONFLICT"
  | "ROADMAP_RELATION_INVALID"
  | "ROADMAP_RELATION_CYCLE"
  | "ROADMAP_TASK_NOT_FOUND"
  | "ROADMAP_TASK_ID_INVALID"
  | "ROADMAP_PROJECT_INVALID"
  | "ROADMAP_STORAGE_BOUNDARY"
  | "ROADMAP_IO_ERROR"
  | "WORKSPACE_NOT_FOUND";

export class RoadmapError extends Error {
  readonly code: RoadmapErrorCode;
  readonly details?: unknown;

  constructor(
    code: RoadmapErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly details?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RoadmapError";
    this.code = code;
    this.details = options.details;
  }
}

interface RoadmapLocation {
  readonly root: string;
  readonly layout: WorkspaceLayout;
  readonly directory: string;
  readonly archiveDirectory: string;
  readonly locksDirectory: string;
}

interface LocatedRoadmap {
  readonly directory: string;
  readonly archived: boolean;
}

interface ReadRoadmap {
  readonly result: RoadmapRecordResult;
  readonly raw: string;
  readonly identity: FileIdentity;
}

interface RoadmapItemSnapshot {
  readonly item: RoadmapItem;
  readonly raw: string;
  readonly identity: FileIdentity;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

const ITEM_FILE = "item.yaml";
const OUTCOME_FILE = "outcome.md";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RECORDS = 4096;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const ITEM_KEYS = new Set([
  "__schema",
  "id",
  "title",
  "state",
  "horizon",
  "order",
  "revision",
  "created_at",
  "updated_at",
  "depends_on",
  "task_refs",
  "superseded_by",
]);

type RoadmapMutationProbe = (id: string) => void | Promise<void>;
let mutationProbe: RoadmapMutationProbe | undefined;
let archiveProbe: RoadmapMutationProbe | undefined;

/** Test-only hook for proving external-write conflict detection. */
export function setRoadmapMutationProbeForTests(probe: RoadmapMutationProbe | undefined): void {
  mutationProbe = probe;
}

/** Test-only hook for proving the archive snapshot recheck boundary. */
export function setRoadmapArchiveProbeForTests(probe: RoadmapMutationProbe | undefined): void {
  archiveProbe = probe;
}

export function roadmapOutcomeTemplate(): string {
  return `# User Problem

# Intended Outcome

# Success Signals

# Context And Constraints

# Realization Notes
`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function terminal(state: RoadmapState): boolean {
  return state === "realized" || state === "retired";
}

function assertId(id: string): string {
  if (!isReadableId("roadmap", id)) {
    throw new RoadmapError("ROADMAP_ID_INVALID", `invalid roadmap id: ${id}`, {
      details: { id },
    });
  }
  return id;
}

function assertState(value: unknown): RoadmapState {
  if (typeof value !== "string" || !ROADMAP_STATES.includes(value as RoadmapState)) {
    throw new RoadmapError("ROADMAP_INVALID", `invalid roadmap state: ${String(value)}`);
  }
  return value as RoadmapState;
}

function assertHorizon(value: unknown): RoadmapHorizon {
  if (typeof value !== "string" || !ROADMAP_HORIZONS.includes(value as RoadmapHorizon)) {
    throw new RoadmapError("ROADMAP_INVALID", `invalid roadmap horizon: ${String(value)}`);
  }
  return value as RoadmapHorizon;
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RoadmapError("ROADMAP_INVALID", `${field} must be an array of roadmap ids`);
  }
  const output = value.map((entry) => assertId(entry as string));
  if (new Set(output).size !== output.length) {
    throw new RoadmapError("ROADMAP_RELATION_INVALID", `${field} contains a duplicate id`);
  }
  return output;
}

function parseItem(value: unknown, expectedId: string): RoadmapItem {
  if (!isObject(value)) throw new RoadmapError("ROADMAP_INVALID", "item.yaml must be an object");
  const unknown = Object.keys(value).filter((key) => !ITEM_KEYS.has(key));
  if (unknown.length > 0) {
    throw new RoadmapError(
      "ROADMAP_INVALID",
      `item.yaml contains unknown fields: ${unknown.join(", ")}`,
    );
  }
  const id = typeof value.id === "string" ? assertId(value.id) : assertId("");
  if (id !== expectedId) {
    throw new RoadmapError(
      "ROADMAP_INVALID",
      `roadmap directory/id mismatch: ${expectedId} != ${id}`,
    );
  }
  if (value.__schema !== 1) throw new RoadmapError("ROADMAP_INVALID", "item.__schema must be 1");
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    throw new RoadmapError("ROADMAP_INVALID", "roadmap title must not be empty");
  }
  const state = assertState(value.state);
  const horizon = assertHorizon(value.horizon);
  const order = value.order;
  if (order !== null && (!Number.isSafeInteger(order) || (order as number) < 0)) {
    throw new RoadmapError(
      "ROADMAP_INVALID",
      "roadmap order must be a non-negative integer or null",
    );
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new RoadmapError("ROADMAP_INVALID", "roadmap revision must be a non-negative integer");
  }
  for (const field of ["created_at", "updated_at"] as const) {
    if (
      typeof value[field] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[field] as string) ||
      Number.isNaN(Date.parse(value[field] as string))
    ) {
      throw new RoadmapError("ROADMAP_INVALID", `${field} must be an ISO timestamp`);
    }
  }
  const dependsOn = assertStringArray(value.depends_on, "depends_on");
  const supersededBy = assertStringArray(value.superseded_by, "superseded_by");
  if (dependsOn.includes(id) || supersededBy.includes(id)) {
    throw new RoadmapError(
      "ROADMAP_RELATION_INVALID",
      `roadmap item cannot reference itself: ${id}`,
    );
  }
  if (supersededBy.length > 0 && state !== "retired") {
    throw new RoadmapError(
      "ROADMAP_RELATION_INVALID",
      "superseded_by is only valid for a retired roadmap item",
    );
  }
  if (!Array.isArray(value.task_refs)) {
    throw new RoadmapError("ROADMAP_INVALID", "task_refs must be an array");
  }
  const taskRefs: RoadmapTaskRef[] = [];
  const taskIds = new Set<string>();
  for (const [index, ref] of value.task_refs.entries()) {
    if (
      !isObject(ref) ||
      Object.keys(ref).sort().join(",") !== "id,kind" ||
      ref.kind !== "assay.task" ||
      typeof ref.id !== "string" ||
      !isReadableId("task", ref.id)
    ) {
      throw new RoadmapError("ROADMAP_INVALID", `invalid task_refs entry at index ${index}`);
    }
    if (taskIds.has(ref.id)) {
      throw new RoadmapError("ROADMAP_RELATION_INVALID", `duplicate task reference: ${ref.id}`);
    }
    taskIds.add(ref.id);
    taskRefs.push({ kind: "assay.task", id: ref.id });
  }
  return {
    __schema: 1,
    id,
    title: value.title.trim(),
    state,
    horizon,
    order: order as number | null,
    revision: value.revision as number,
    created_at: value.created_at as string,
    updated_at: value.updated_at as string,
    depends_on: dependsOn,
    task_refs: taskRefs,
    superseded_by: supersededBy,
  };
}

function serializeItem(item: RoadmapItem): string {
  return stringify(item, { lineWidth: 0 });
}

function errorFrom(error: unknown, fallback = "roadmap storage operation failed"): RoadmapError {
  if (error instanceof RoadmapError) return error;
  if (error instanceof TaskInvalidEncodingError) {
    return new RoadmapError("ROADMAP_INVALID_ENCODING", error.message, { cause: error });
  }
  if (error instanceof TaskStorageBoundaryError) {
    return new RoadmapError("ROADMAP_STORAGE_BOUNDARY", error.message, { cause: error });
  }
  if (error instanceof TaskLockUnavailableError) {
    return new RoadmapError("ROADMAP_CONFLICT", error.message, { cause: error });
  }
  return new RoadmapError("ROADMAP_IO_ERROR", fallback, { cause: error });
}

function throwStorage(error: unknown): never {
  throw errorFrom(error);
}

async function locationFor(rootInput: string): Promise<RoadmapLocation> {
  const root = path.resolve(rootInput);
  const manifest = await loadManifest(root);
  if (!manifest)
    throw new RoadmapError("WORKSPACE_NOT_FOUND", `No workspace manifest found at ${root}.`);
  const layout = resolveWorkspaceLayout(manifest) ?? defaultStandaloneLayout();
  const envelope = await resolveEnvelopeContext(root);
  await assertProjectAvailable(root, layout);
  const directory = path.join(root, workspaceWorkRelativePath(layout, "project"), "roadmap");
  const archiveDirectory = path.join(directory, "archive");
  const locksDirectory = path.join(envelope.path, "roadmap-locks");
  try {
    await assertTaskStorageBoundary(root, directory);
    await assertTaskStorageBoundary(root, locksDirectory);
  } catch (error) {
    throwStorage(error);
  }
  return { root, layout, directory, archiveDirectory, locksDirectory };
}

async function assertProjectAvailable(root: string, layout: WorkspaceLayout): Promise<void> {
  try {
    await validateNativeProjectStructure(root, layout);
    if ((await loadNativeProject(root, layout)) === null) {
      throw new Error("native Project envelope is missing");
    }
  } catch (error) {
    throw new RoadmapError(
      "ROADMAP_PROJECT_INVALID",
      `native Project is required for Roadmap operations: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function itemDirectory(location: RoadmapLocation, id: string, archived: boolean): string {
  return path.join(archived ? location.archiveDirectory : location.directory, assertId(id));
}

function itemLock(location: RoadmapLocation, id: string): string {
  return path.join(location.locksDirectory, assertId(id));
}

function graphLock(location: RoadmapLocation): string {
  return path.join(location.locksDirectory, ".graph-create");
}

/** Serialize conversion with every native Roadmap create/mutation/archive. */
export async function withRoadmapGlobalCoordination<T>(
  root: string,
  callback: () => Promise<T>,
): Promise<T> {
  const location = await locationFor(root);
  return withTaskLock(location.root, graphLock(location), async () => {
    await assertProjectAvailable(location.root, location.layout);
    return callback();
  }).catch((error: unknown) => {
    if (
      error instanceof RoadmapError ||
      error instanceof TaskInvalidEncodingError ||
      error instanceof TaskStorageBoundaryError ||
      error instanceof TaskLockUnavailableError
    ) {
      throwStorage(error);
    }
    throw error;
  });
}

function assertTaskRefId(id: string): string {
  if (!isReadableId("task", id)) {
    throw new RoadmapError("ROADMAP_TASK_ID_INVALID", `invalid native Task id: ${id}`);
  }
  return id;
}

function displayPath(location: RoadmapLocation, target: string): string {
  return path.relative(location.root, target).split(path.sep).join("/");
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function locate(location: RoadmapLocation, idInput: string): Promise<LocatedRoadmap> {
  const id = assertId(idInput);
  const live = itemDirectory(location, id, false);
  const archived = itemDirectory(location, id, true);
  const [hasLive, hasArchived] = await Promise.all([exists(live), exists(archived)]);
  if (hasLive && hasArchived) {
    throw new RoadmapError(
      "ROADMAP_CONFLICT",
      `roadmap item exists in live and archive storage: ${id}`,
    );
  }
  if (!hasLive && !hasArchived)
    throw new RoadmapError("ROADMAP_NOT_FOUND", `roadmap item not found: ${id}`);
  return { directory: hasLive ? live : archived, archived: hasArchived };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function identity(stats: Stats): FileIdentity {
  return {
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

async function assertRealDirectory(root: string, target: string): Promise<void> {
  await assertTaskStorageBoundary(root, target);
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RoadmapError(
      "ROADMAP_STORAGE_BOUNDARY",
      `roadmap path is not a real directory: ${target}`,
    );
  }
  if (!(await identitySafeRealpath(target))) {
    throw new RoadmapError(
      "ROADMAP_STORAGE_BOUNDARY",
      `roadmap path crosses a reparse boundary: ${target}`,
    );
  }
}

async function assertShape(location: RoadmapLocation, directory: string): Promise<void> {
  await assertRealDirectory(location.root, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const required of [ITEM_FILE, OUTCOME_FILE]) {
    const entry = entries.find((candidate) => candidate.name === required);
    if (!entry || !entry.isFile() || entry.isSymbolicLink()) {
      throw new RoadmapError(
        "ROADMAP_STORAGE_BOUNDARY",
        `roadmap item requires a regular ${required}: ${directory}`,
      );
    }
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new RoadmapError(
        "ROADMAP_STORAGE_BOUNDARY",
        `roadmap item contains a redirect: ${path.join(directory, entry.name)}`,
      );
    }
    if (![ITEM_FILE, OUTCOME_FILE].includes(entry.name)) {
      throw new RoadmapError(
        "ROADMAP_INVALID",
        `roadmap item contains an unknown entry: ${entry.name}`,
      );
    }
  }
}

async function readBounded(
  location: RoadmapLocation,
  file: string,
): Promise<{ text: string; identity: FileIdentity }> {
  const info = await lstat(file);
  if (info.size > MAX_FILE_BYTES)
    throw new RoadmapError("ROADMAP_INVALID", `roadmap file exceeds ${MAX_FILE_BYTES} bytes`);
  return { text: await readTaskText(location.root, file), identity: identity(info) };
}

async function projectTasks(
  root: string,
  refs: readonly RoadmapTaskRef[],
): Promise<RoadmapTaskProjection[]> {
  const output: RoadmapTaskProjection[] = [];
  for (const ref of refs) {
    try {
      const task = await showTask({ root, id: ref.id });
      output.push({
        kind: "assay.task",
        id: ref.id,
        unresolved: false,
        archived: task.archived,
        title: task.task.title,
        status: task.task.status,
      });
    } catch {
      output.push({ kind: "assay.task", id: ref.id, unresolved: true });
    }
  }
  return output;
}

async function readAt(
  location: RoadmapLocation,
  located: LocatedRoadmap,
  id: string,
): Promise<ReadRoadmap> {
  await assertShape(location, located.directory);
  const [snapshot, { text: outcome }] = await Promise.all([
    readItemSnapshot(location, located.directory, id),
    readBounded(location, path.join(located.directory, OUTCOME_FILE)),
  ]);
  const { item, raw, identity: itemIdentity } = snapshot;
  return {
    raw,
    identity: itemIdentity,
    result: {
      root: location.root,
      path: displayPath(location, located.directory),
      archived: located.archived,
      item,
      outcome,
      tasks: await projectTasks(location.root, item.task_refs),
    },
  };
}

async function readItemSnapshot(
  location: RoadmapLocation,
  directory: string,
  id: string,
): Promise<RoadmapItemSnapshot> {
  await assertShape(location, directory);
  const { text: raw, identity } = await readBounded(location, path.join(directory, ITEM_FILE));
  let decoded: unknown;
  try {
    decoded = parse(raw);
  } catch (error) {
    throw new RoadmapError("ROADMAP_INVALID", `roadmap item YAML is invalid: ${id}`, {
      cause: error,
    });
  }
  const item = parseItem(decoded, id);
  return { item, raw, identity };
}

async function listEntries(location: RoadmapLocation, archived: boolean): Promise<Dirent[]> {
  const directory = archived ? location.archiveDirectory : location.directory;
  await assertTaskStorageBoundary(location.root, directory);
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => archived || !["README.md", "archive"].includes(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function storedIds(location: RoadmapLocation): Promise<string[]> {
  const [live, archived] = await Promise.all([
    listEntries(location, false),
    listEntries(location, true),
  ]);
  return [...live, ...archived].map((entry) => entry.name);
}

async function assertUnchanged(
  location: RoadmapLocation,
  directory: string,
  before: ReadRoadmap,
): Promise<void> {
  const target = path.join(directory, ITEM_FILE);
  const currentInfo = identity(await lstat(target));
  const currentRaw = await readTaskText(location.root, target);
  if (!sameIdentity(before.identity, currentInfo) || currentRaw !== before.raw) {
    throw new RoadmapError(
      "ROADMAP_CONFLICT",
      `roadmap item changed outside ownwork: ${before.result.item.id}`,
    );
  }
}

async function allReadable(location: RoadmapLocation): Promise<Map<string, ReadRoadmap>> {
  const output = new Map<string, ReadRoadmap>();
  for (const archived of [false, true]) {
    for (const entry of await listEntries(location, archived)) {
      if (!isReadableId("roadmap", entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
        continue;
      try {
        const read = await readAt(
          location,
          {
            directory: path.join(
              archived ? location.archiveDirectory : location.directory,
              entry.name,
            ),
            archived,
          },
          entry.name,
        );
        if (!output.has(entry.name)) output.set(entry.name, read);
      } catch {
        // Validation reports malformed records. Graph writes fail when one of
        // their explicit targets cannot be read, rather than hiding it here.
      }
    }
  }
  return output;
}

function edges(item: RoadmapItem): readonly string[] {
  return [...item.depends_on, ...item.superseded_by];
}

async function validateProposedGraph(
  location: RoadmapLocation,
  proposed: RoadmapItem,
): Promise<void> {
  const graph = await allReadable(location);
  graph.set(proposed.id, {
    result: {
      root: location.root,
      path: "",
      archived: false,
      item: proposed,
      outcome: "",
      tasks: [],
    },
    raw: "",
    identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0 },
  });
  for (const target of edges(proposed)) {
    if (!graph.has(target)) {
      throw new RoadmapError(
        "ROADMAP_RELATION_INVALID",
        `roadmap relation target not found: ${target}`,
      );
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new RoadmapError("ROADMAP_RELATION_CYCLE", `roadmap graph contains a cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const current = graph.get(id);
    if (current) for (const target of edges(current.result.item)) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

export interface CreateRoadmapOptions {
  readonly root: string;
  readonly title: string;
  readonly now?: Date;
}

export async function createRoadmap(options: CreateRoadmapOptions): Promise<RoadmapRecordResult> {
  const title = options.title.trim();
  if (!title) throw new RoadmapError("ROADMAP_INVALID", "roadmap title must not be empty");
  const location = await locationFor(options.root);
  return withTaskLock(location.root, graphLock(location), async () => {
    await assertProjectAvailable(location.root, location.layout);
    let id: string;
    try {
      id = allocateReadableId("roadmap", title, await storedIds(location));
    } catch (error) {
      throw new RoadmapError("ROADMAP_INVALID", "roadmap id allocation failed", { cause: error });
    }
    return withTaskLock(location.root, itemLock(location, id), async () => {
      const live = itemDirectory(location, id, false);
      const archived = itemDirectory(location, id, true);
      if ((await exists(live)) || (await exists(archived)))
        throw new RoadmapError("ROADMAP_ALREADY_EXISTS", `roadmap item already exists: ${id}`);
      const now = (options.now ?? new Date()).toISOString();
      const item: RoadmapItem = {
        __schema: 1,
        id,
        title,
        state: "candidate",
        horizon: "unscheduled",
        order: null,
        revision: 0,
        created_at: now,
        updated_at: now,
        depends_on: [],
        task_refs: [],
        superseded_by: [],
      };
      await mkdir(location.directory, { recursive: true });
      const temporary = path.join(location.directory, `.create-${id}-${randomUUID()}`);
      try {
        await mkdir(temporary, { recursive: false });
        await atomicWriteTaskText(
          location.root,
          path.join(temporary, ITEM_FILE),
          serializeItem(item),
        );
        await atomicWriteTaskText(
          location.root,
          path.join(temporary, OUTCOME_FILE),
          roadmapOutcomeTemplate(),
        );
        await rename(temporary, live);
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
      return (await readAt(location, { directory: live, archived: false }, id)).result;
    });
  }).catch(throwStorage);
}

export async function showRoadmap(options: {
  readonly root: string;
  readonly id: string;
}): Promise<RoadmapRecordResult> {
  const location = await locationFor(options.root);
  const id = assertId(options.id);
  return withTaskLock(location.root, itemLock(location, id), async () => {
    const located = await locate(location, id);
    return (await readAt(location, located, id)).result;
  }).catch(throwStorage);
}

async function mutate(
  location: RoadmapLocation,
  idInput: string,
  expectedRevision: number | undefined,
  graphMutation: boolean,
  update: (item: RoadmapItem) => Promise<RoadmapItem> | RoadmapItem,
): Promise<RoadmapRecordResult> {
  const id = assertId(idInput);
  const operation = async () => {
    await assertProjectAvailable(location.root, location.layout);
    return withTaskLock(location.root, itemLock(location, id), async () => {
      const located = await locate(location, id);
      if (located.archived)
        throw new RoadmapError(
          "ROADMAP_TERMINAL",
          `archived roadmap item cannot be changed: ${id}`,
        );
      const before = await readAt(location, located, id);
      if (expectedRevision !== undefined && before.result.item.revision !== expectedRevision) {
        throw new RoadmapError(
          "ROADMAP_REVISION_CONFLICT",
          `roadmap revision changed: expected ${expectedRevision}, found ${before.result.item.revision}`,
          {
            details: {
              expected_revision: expectedRevision,
              actual_revision: before.result.item.revision,
            },
          },
        );
      }
      const proposed = await update(before.result.item);
      parseItem(proposed, id);
      if (graphMutation) await validateProposedGraph(location, proposed);
      await mutationProbe?.(id);
      await assertUnchanged(location, located.directory, before);
      await atomicWriteTaskText(
        location.root,
        path.join(located.directory, ITEM_FILE),
        serializeItem(proposed),
      );
      return (await readAt(location, located, id)).result;
    });
  };
  // Conversion, allocation, graph changes, ordinary writes, and archive all
  // acquire the global lock first and an item lock second.
  return withTaskLock(location.root, graphLock(location), operation).catch(throwStorage);
}

export interface UpdateRoadmapOptions {
  readonly root: string;
  readonly id: string;
  readonly title?: string;
  readonly state?: RoadmapState;
  readonly horizon?: RoadmapHorizon;
  readonly order?: number | null;
  readonly dependsOn?: readonly string[];
  readonly supersededBy?: readonly string[];
  readonly expectedRevision?: number;
  readonly now?: Date;
}

export async function updateRoadmap(options: UpdateRoadmapOptions): Promise<RoadmapRecordResult> {
  if (
    options.title === undefined &&
    options.state === undefined &&
    options.horizon === undefined &&
    options.order === undefined &&
    options.dependsOn === undefined &&
    options.supersededBy === undefined
  ) {
    throw new RoadmapError("ROADMAP_INVALID", "roadmap update requires at least one field");
  }
  const location = await locationFor(options.root);
  const graphMutation = options.dependsOn !== undefined || options.supersededBy !== undefined;
  return mutate(location, options.id, options.expectedRevision, graphMutation, (current) => {
    const state = options.state ?? current.state;
    if (terminal(current.state) && state !== current.state)
      throw new RoadmapError(
        "ROADMAP_TERMINAL",
        `terminal roadmap item cannot reopen: ${current.id}`,
      );
    const title = options.title === undefined ? current.title : options.title.trim();
    if (!title) throw new RoadmapError("ROADMAP_INVALID", "roadmap title must not be empty");
    return {
      ...current,
      title,
      state,
      horizon: options.horizon ?? current.horizon,
      order: options.order === undefined ? current.order : options.order,
      depends_on: options.dependsOn === undefined ? current.depends_on : [...options.dependsOn],
      superseded_by:
        options.supersededBy === undefined ? current.superseded_by : [...options.supersededBy],
      revision: current.revision + 1,
      updated_at: (options.now ?? new Date()).toISOString(),
    };
  });
}

export async function linkRoadmapTask(options: {
  readonly root: string;
  readonly id: string;
  readonly task: string;
  readonly expectedRevision?: number;
  readonly now?: Date;
}): Promise<RoadmapRecordResult> {
  assertTaskRefId(options.task);
  try {
    await showTask({ root: options.root, id: options.task });
  } catch (error) {
    throw new RoadmapError("ROADMAP_TASK_NOT_FOUND", `task not found or invalid: ${options.task}`, {
      cause: error,
    });
  }
  const location = await locationFor(options.root);
  return mutate(location, options.id, options.expectedRevision, false, (current) => {
    if (current.task_refs.some((ref) => ref.id === options.task))
      throw new RoadmapError("ROADMAP_RELATION_INVALID", `task is already linked: ${options.task}`);
    return {
      ...current,
      task_refs: [...current.task_refs, { kind: "assay.task", id: options.task }],
      revision: current.revision + 1,
      updated_at: (options.now ?? new Date()).toISOString(),
    };
  });
}

export async function unlinkRoadmapTask(options: {
  readonly root: string;
  readonly id: string;
  readonly task: string;
  readonly expectedRevision?: number;
  readonly now?: Date;
}): Promise<RoadmapRecordResult> {
  assertTaskRefId(options.task);
  const location = await locationFor(options.root);
  return mutate(location, options.id, options.expectedRevision, false, (current) => {
    if (!current.task_refs.some((ref) => ref.id === options.task))
      throw new RoadmapError("ROADMAP_RELATION_INVALID", `task is not linked: ${options.task}`);
    return {
      ...current,
      task_refs: current.task_refs.filter((ref) => ref.id !== options.task),
      revision: current.revision + 1,
      updated_at: (options.now ?? new Date()).toISOString(),
    };
  });
}

export async function realizeRoadmap(options: {
  readonly root: string;
  readonly id: string;
  readonly expectedRevision?: number;
  readonly now?: Date;
}): Promise<RoadmapRecordResult> {
  return updateRoadmap({ ...options, state: "realized" });
}

export async function retireRoadmap(options: {
  readonly root: string;
  readonly id: string;
  readonly expectedRevision?: number;
  readonly now?: Date;
}): Promise<RoadmapRecordResult> {
  return updateRoadmap({ ...options, state: "retired" });
}

export async function archiveRoadmap(options: {
  readonly root: string;
  readonly id: string;
}): Promise<RoadmapRecordResult> {
  const location = await locationFor(options.root);
  const id = assertId(options.id);
  return withTaskLock(location.root, graphLock(location), async () => {
    await assertProjectAvailable(location.root, location.layout);
    return withTaskLock(location.root, itemLock(location, id), async () => {
      const live = itemDirectory(location, id, false);
      const archived = itemDirectory(location, id, true);
      const [hasLive, hasArchived] = await Promise.all([exists(live), exists(archived)]);
      if (hasLive && hasArchived)
        throw new RoadmapError(
          "ROADMAP_CONFLICT",
          `roadmap item exists in live and archive storage: ${id}`,
        );
      if (hasArchived)
        return (await readAt(location, { directory: archived, archived: true }, id)).result;
      if (!hasLive) throw new RoadmapError("ROADMAP_NOT_FOUND", `roadmap item not found: ${id}`);
      const current = await readAt(location, { directory: live, archived: false }, id);
      if (!terminal(current.result.item.state))
        throw new RoadmapError(
          "ROADMAP_NOT_TERMINAL",
          `only terminal roadmap items can be archived: ${id}`,
        );
      await mkdir(location.archiveDirectory, { recursive: true });
      if (await exists(archived))
        throw new RoadmapError(
          "ROADMAP_ALREADY_EXISTS",
          `roadmap archive target already exists: ${id}`,
        );
      await archiveProbe?.(id);
      const latest = await readItemSnapshot(location, live, id);
      if (
        !sameIdentity(current.identity, latest.identity) ||
        current.raw !== latest.raw ||
        current.result.item.revision !== latest.item.revision ||
        current.result.item.state !== latest.item.state
      ) {
        throw new RoadmapError("ROADMAP_CONFLICT", `roadmap item changed before archive: ${id}`);
      }
      if (!terminal(latest.item.state))
        throw new RoadmapError(
          "ROADMAP_NOT_TERMINAL",
          `only terminal roadmap items can be archived: ${id}`,
        );
      await rename(live, archived);
      return (await readAt(location, { directory: archived, archived: true }, id)).result;
    });
  }).catch(throwStorage);
}

async function validation(location: RoadmapLocation): Promise<RoadmapValidationResult> {
  const records: RoadmapValidationResult["items"][number][] = [];
  const reads = new Map<string, ReadRoadmap>();
  const locations = new Map<string, number[]>();
  for (const archived of [false, true]) {
    for (const entry of await listEntries(location, archived)) {
      const entryPath = path.join(
        archived ? location.archiveDirectory : location.directory,
        entry.name,
      );
      const issues: RoadmapIssue[] = [];
      if (!isReadableId("roadmap", entry.name))
        issues.push({
          code: "ROADMAP_ID_INVALID",
          message: `invalid roadmap storage entry: ${entry.name}`,
        });
      else if (!entry.isDirectory() || entry.isSymbolicLink())
        issues.push({
          code: "ROADMAP_STORAGE_BOUNDARY",
          message: "roadmap entry is not a real directory",
        });
      else {
        try {
          const read = await readAt(location, { directory: entryPath, archived }, entry.name);
          reads.set(`${archived ? "a" : "l"}:${entry.name}`, read);
          const taskIssues = read.result.tasks
            .filter((task) => task.unresolved)
            .map((task) => ({
              code: "ROADMAP_TASK_UNRESOLVED",
              message: `task reference is unresolved: ${task.id}`,
              id: entry.name,
              path: displayPath(location, entryPath),
              archived,
            }));
          issues.push(...taskIssues);
          if (archived && !terminal(read.result.item.state))
            issues.push({
              code: "ROADMAP_NOT_TERMINAL",
              message: "archived roadmap item is not terminal",
            });
        } catch (error) {
          const mapped = errorFrom(error);
          issues.push({ code: mapped.code, message: mapped.message });
        }
      }
      const index = records.length;
      records.push({
        id: entry.name,
        path: displayPath(location, entryPath),
        archived,
        valid: issues.length === 0,
        issues,
      });
      locations.set(entry.name.toLowerCase(), [
        ...(locations.get(entry.name.toLowerCase()) ?? []),
        index,
      ]);
    }
  }
  if (records.length > MAX_RECORDS)
    throw new RoadmapError("ROADMAP_INVALID", `roadmap storage exceeds ${MAX_RECORDS} records`);
  for (const indices of locations.values()) {
    if (indices.length < 2) continue;
    for (const index of indices) {
      const current = records[index];
      if (current === undefined) continue;
      const issue = {
        code: "ROADMAP_CONFLICT",
        message: `roadmap id exists more than once: ${current.id}`,
      };
      records[index] = { ...current, valid: false, issues: [...current.issues, issue] };
    }
  }
  const readableById = new Map<string, ReadRoadmap>();
  for (const read of reads.values())
    if (!readableById.has(read.result.item.id)) readableById.set(read.result.item.id, read);
  const graphIssues = new Map<string, RoadmapIssue[]>();
  const addGraphIssue = (id: string, issue: RoadmapIssue) =>
    graphIssues.set(id, [...(graphIssues.get(id) ?? []), issue]);
  for (const [id, read] of readableById) {
    for (const target of edges(read.result.item))
      if (!readableById.has(target))
        addGraphIssue(id, {
          code: "ROADMAP_RELATION_INVALID",
          message: `roadmap relation target is unresolved: ${target}`,
        });
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, trail: string[]): void => {
    if (visiting.has(id)) {
      for (const member of trail.slice(trail.indexOf(id)))
        addGraphIssue(member, {
          code: "ROADMAP_RELATION_CYCLE",
          message: `roadmap graph cycle includes ${id}`,
        });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const read = readableById.get(id);
    if (read)
      for (const target of edges(read.result.item))
        if (readableById.has(target)) visit(target, [...trail, target]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of readableById.keys()) visit(id, [id]);
  for (let index = 0; index < records.length; index += 1) {
    const current = records[index];
    if (current === undefined) continue;
    const extra = graphIssues.get(current.id) ?? [];
    if (extra.length > 0)
      records[index] = { ...current, valid: false, issues: [...current.issues, ...extra] };
  }
  const issues = records.flatMap((record) =>
    record.issues.map((issue) => ({
      ...issue,
      id: record.id,
      path: record.path,
      archived: record.archived,
    })),
  );
  return { root: location.root, valid: issues.length === 0, items: records, issues };
}

export async function validateRoadmaps(options: {
  readonly root: string;
  readonly id?: string;
}): Promise<RoadmapValidationResult> {
  const location = await locationFor(options.root);
  const result = await validation(location).catch(throwStorage);
  if (options.id === undefined) return result;
  const id = assertId(options.id);
  const items = result.items.filter((item) => item.id === id);
  if (items.length > 0) {
    const issues = items.flatMap((item) =>
      item.issues.map((issue) => ({
        ...issue,
        id: item.id,
        path: item.path,
        archived: item.archived,
      })),
    );
    return { root: result.root, valid: issues.length === 0, items, issues };
  }
  const issue = {
    code: "ROADMAP_NOT_FOUND",
    message: `roadmap item not found: ${id}`,
    id,
    path: displayPath(location, itemDirectory(location, id, false)),
    archived: false,
  };
  return {
    root: result.root,
    valid: false,
    items: [{ id, path: issue.path, archived: false, valid: false, issues: [issue] }],
    issues: [issue],
  };
}

export interface ListRoadmapsOptions {
  readonly root: string;
  readonly state?: RoadmapState;
  readonly horizon?: RoadmapHorizon;
  readonly task?: string;
  readonly archived?: RoadmapArchiveScope;
  readonly limit?: number;
  readonly cursor?: string;
}

export async function listRoadmaps(options: ListRoadmapsOptions): Promise<RoadmapListResult> {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
    throw new RoadmapError(
      "ROADMAP_INVALID",
      `roadmap list limit must be between 1 and ${MAX_PAGE_SIZE}`,
    );
  if (options.cursor !== undefined) assertId(options.cursor);
  if (options.task !== undefined) assertTaskRefId(options.task);
  const location = await locationFor(options.root);
  const checked = await validation(location);
  const scope = options.archived ?? "live";
  const rows: RoadmapListEntry[] = [];
  for (const candidate of checked.items) {
    if (!isReadableId("roadmap", candidate.id)) continue;
    if ((scope === "live" && candidate.archived) || (scope === "archived" && !candidate.archived))
      continue;
    if (options.cursor !== undefined && candidate.id <= options.cursor) continue;
    try {
      const read = await readAt(
        location,
        {
          directory: path.join(
            candidate.archived ? location.archiveDirectory : location.directory,
            candidate.id,
          ),
          archived: candidate.archived,
        },
        candidate.id,
      );
      const item = read.result.item;
      if (options.state !== undefined && item.state !== options.state) continue;
      if (options.horizon !== undefined && item.horizon !== options.horizon) continue;
      if (options.task !== undefined && !item.task_refs.some((ref) => ref.id === options.task))
        continue;
      rows.push({
        id: item.id,
        path: read.result.path,
        archived: candidate.archived,
        title: item.title,
        state: item.state,
        horizon: item.horizon,
        order: item.order,
        revision: item.revision,
        depends_on: item.depends_on,
        superseded_by: item.superseded_by,
        tasks: read.result.tasks,
      });
    } catch {
      // The same failure is already present in validation issues.
    }
  }
  rows.sort(
    (left, right) =>
      left.id.localeCompare(right.id) || Number(left.archived) - Number(right.archived),
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    root: location.root,
    items: page,
    issues: checked.issues,
    ...(rows.length > page.length && last ? { next_cursor: last.id } : {}),
  };
}
