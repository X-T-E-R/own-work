import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

import { FrameworkError } from "absorb-anything-core";
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
import { loadSystemsRegistry, systemRecordForSelector } from "./systems-registry.js";
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

export const SPEC_STATES = ["draft", "active", "retired"] as const;
export type SpecState = (typeof SPEC_STATES)[number];
export const SPEC_STRENGTHS = ["required", "recommended"] as const;
export type SpecStrength = (typeof SPEC_STRENGTHS)[number];
export type SpecArchiveScope = "live" | "archived" | "all";

export interface SpecScope {
  readonly kind: "project" | "system";
  readonly id: string;
}

export interface SpecAnalysisProvenance {
  readonly kind: "assay.analysis";
  readonly path: string;
  readonly sha256: string;
}

export interface SpecTaskProvenance {
  readonly kind: "assay.task";
  readonly id: string;
  readonly file: string;
  readonly sha256: string;
}

export type SpecProvenance = SpecAnalysisProvenance | SpecTaskProvenance;

export interface SpecItem {
  readonly __schema: 1;
  readonly id: string;
  readonly title: string;
  readonly state: SpecState;
  readonly scope: SpecScope;
  readonly strength: SpecStrength;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly derived_from: readonly SpecProvenance[];
  readonly superseded_by: readonly string[];
}

export interface SpecRecordResult {
  readonly root: string;
  readonly path: string;
  readonly archived: boolean;
  readonly item: SpecItem;
  readonly specification: string;
}

export interface SpecIssue {
  readonly code: string;
  readonly message: string;
  readonly id?: string;
  readonly path?: string;
  readonly archived?: boolean;
}

export interface SpecListEntry {
  readonly id: string;
  readonly path: string;
  readonly archived: boolean;
  readonly title: string;
  readonly state: SpecState;
  readonly scope: SpecScope;
  readonly strength: SpecStrength;
  readonly revision: number;
  readonly derived_from: readonly SpecProvenance[];
  readonly superseded_by: readonly string[];
}

export interface SpecListResult {
  readonly root: string;
  readonly items: readonly SpecListEntry[];
  readonly issues: readonly SpecIssue[];
  readonly next_cursor?: string;
}

export interface SpecValidationResult {
  readonly root: string;
  readonly valid: boolean;
  readonly items: readonly {
    readonly id: string;
    readonly path: string;
    readonly archived: boolean;
    readonly valid: boolean;
    readonly issues: readonly SpecIssue[];
  }[];
  readonly issues: readonly SpecIssue[];
}

export type SpecErrorCode =
  | "SPEC_INVALID"
  | "SPEC_INVALID_ENCODING"
  | "SPEC_ID_INVALID"
  | "SPEC_NOT_FOUND"
  | "SPEC_ALREADY_EXISTS"
  | "SPEC_CONFLICT"
  | "SPEC_TERMINAL"
  | "SPEC_NOT_RETIRED"
  | "SPEC_REVISION_CONFLICT"
  | "SPEC_SCOPE_INVALID"
  | "SPEC_PROVENANCE_INVALID"
  | "SPEC_PROVENANCE_MISSING"
  | "SPEC_PROVENANCE_DRIFT"
  | "SPEC_RELATION_INVALID"
  | "SPEC_RELATION_CYCLE"
  | "SPEC_BODY_INVALID"
  | "SPEC_STORAGE_BOUNDARY"
  | "SPEC_IO_ERROR"
  | "SPEC_PROJECT_INVALID"
  | "WORKSPACE_NOT_FOUND";

export class SpecError extends Error {
  readonly code: SpecErrorCode;
  readonly details?: unknown;

  constructor(
    code: SpecErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly details?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SpecError";
    this.code = code;
    this.details = options.details;
  }
}

interface SpecLocation {
  readonly root: string;
  readonly layout: WorkspaceLayout;
  readonly directory: string;
  readonly archiveDirectory: string;
  readonly locksDirectory: string;
  readonly stagingDirectory: string;
}

interface LocatedSpec {
  readonly directory: string;
  readonly archived: boolean;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface FileSnapshot {
  readonly file: string;
  readonly bytes: Buffer;
  readonly text: string;
  readonly identity: FileIdentity;
}

interface ReadSpec {
  readonly result: SpecRecordResult;
  readonly itemSnapshot: FileSnapshot;
  readonly bodySnapshot: FileSnapshot;
}

interface PreparedProvenance {
  readonly entry: SpecProvenance;
  readonly snapshot: FileSnapshot;
}

const ITEM_FILE = "spec.yaml";
const BODY_FILE = "specification.md";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RECORDS = 4096;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const ITEM_KEYS = new Set([
  "__schema",
  "id",
  "title",
  "state",
  "scope",
  "strength",
  "revision",
  "created_at",
  "updated_at",
  "derived_from",
  "superseded_by",
]);
const BODY_HEADINGS = [
  "## Purpose",
  "## Scope",
  "## Requirements",
  "## Constraints",
  "## Acceptance Criteria",
  "## Non-Goals",
] as const;
const REQUIRED_BODY_HEADINGS = new Set([
  "## Purpose",
  "## Scope",
  "## Requirements",
  "## Acceptance Criteria",
]);
const TASK_SOURCE_FILES = new Set(["prd.md", "handoff.md", "design.md"]);

type SpecMutationProbe = (id: string) => void | Promise<void>;
let mutationProbe: SpecMutationProbe | undefined;
let archiveProbe: SpecMutationProbe | undefined;
let promotionProbe: SpecMutationProbe | undefined;

/** Test-only hook for proving metadata external-write conflict detection. */
export function setSpecMutationProbeForTests(probe: SpecMutationProbe | undefined): void {
  mutationProbe = probe;
}

/** Test-only hook for proving the archive envelope/body recheck boundary. */
export function setSpecArchiveProbeForTests(probe: SpecMutationProbe | undefined): void {
  archiveProbe = probe;
}

/** Test-only hook for proving promotion source/body rechecks before publication. */
export function setSpecPromotionProbeForTests(probe: SpecMutationProbe | undefined): void {
  promotionProbe = probe;
}

export function specificationTemplate(): string {
  return `${BODY_HEADINGS.join("\n\n")}\n`;
}

export function projectSpecsReadme(): string {
  return `# Specifications

This directory contains native specifications. Each live Spec is stored at \`<id>/{spec.yaml,specification.md}\`; retired Specs may be moved unchanged to \`archive/<id>/\`.

The root README explains the storage contract only. It is never a generated index. \`spec.yaml\` is a closed machine envelope; \`specification.md\` is reader-owned normative prose and lifecycle commands never rewrite it.

A Spec is not an approval or Project acceptance record. Multiple active Specs may coexist. Explicit promotion records provenance without changing its Analysis or Task source.
`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertId(id: string): string {
  if (!isReadableId("spec", id)) {
    throw new SpecError("SPEC_ID_INVALID", `invalid spec id: ${id}`, { details: { id } });
  }
  return id;
}

function assertState(value: unknown): SpecState {
  if (typeof value !== "string" || !SPEC_STATES.includes(value as SpecState)) {
    throw new SpecError("SPEC_INVALID", `invalid spec state: ${String(value)}`);
  }
  return value as SpecState;
}

function assertStrength(value: unknown): SpecStrength {
  if (typeof value !== "string" || !SPEC_STRENGTHS.includes(value as SpecStrength)) {
    throw new SpecError("SPEC_INVALID", `invalid spec strength: ${String(value)}`);
  }
  return value as SpecStrength;
}

function assertScope(value: unknown): SpecScope {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(",") !== "id,kind" ||
    (value.kind !== "project" && value.kind !== "system") ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0
  ) {
    throw new SpecError("SPEC_SCOPE_INVALID", "scope must be exactly {kind: project|system, id}");
  }
  if (value.kind === "project" && !isReadableId("project", value.id)) {
    throw new SpecError("SPEC_SCOPE_INVALID", `invalid native Project id: ${value.id}`);
  }
  return { kind: value.kind, id: value.id };
}

function assertSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new SpecError("SPEC_PROVENANCE_INVALID", "provenance sha256 must be lowercase hex");
  }
  return value;
}

function assertLogicalAnalysisPath(value: string): string {
  if (
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    value === "analyses" ||
    !value.startsWith("analyses/") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new SpecError(
      "SPEC_PROVENANCE_INVALID",
      "analysis path must be an ordinary logical analyses/... path relative to the work root",
    );
  }
  return value;
}

function assertTaskSourceFile(value: string): string {
  const researchFile =
    value.length <= 256 &&
    value.startsWith("research/") &&
    value.endsWith(".md") &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (!TASK_SOURCE_FILES.has(value) && !researchFile) {
    throw new SpecError(
      "SPEC_PROVENANCE_INVALID",
      `task provenance file must be one of ${[...TASK_SOURCE_FILES].join(", ")} or an ordinary research/*.md path`,
    );
  }
  return value;
}

function parseProvenance(value: unknown): SpecProvenance[] {
  if (!Array.isArray(value)) {
    throw new SpecError("SPEC_PROVENANCE_INVALID", "derived_from must be an array");
  }
  return value.map((entry, index) => {
    if (!isObject(entry)) {
      throw new SpecError("SPEC_PROVENANCE_INVALID", `invalid derived_from entry at ${index}`);
    }
    if (
      entry.kind === "assay.analysis" &&
      Object.keys(entry).sort().join(",") === "kind,path,sha256" &&
      typeof entry.path === "string"
    ) {
      return {
        kind: "assay.analysis" as const,
        path: assertLogicalAnalysisPath(entry.path),
        sha256: assertSha256(entry.sha256),
      };
    }
    if (
      entry.kind === "assay.task" &&
      Object.keys(entry).sort().join(",") === "file,id,kind,sha256" &&
      typeof entry.id === "string" &&
      typeof entry.file === "string" &&
      isReadableId("task", entry.id)
    ) {
      return {
        kind: "assay.task" as const,
        id: entry.id,
        file: assertTaskSourceFile(entry.file),
        sha256: assertSha256(entry.sha256),
      };
    }
    throw new SpecError("SPEC_PROVENANCE_INVALID", `invalid derived_from entry at ${index}`);
  });
}

function assertIdArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SpecError("SPEC_INVALID", `${field} must be an array of spec ids`);
  }
  const output = value.map((entry) => assertId(entry as string));
  if (new Set(output.map((id) => id.toLowerCase())).size !== output.length) {
    throw new SpecError("SPEC_RELATION_INVALID", `${field} contains a duplicate id`);
  }
  return output;
}

function parseItem(value: unknown, expectedId: string): SpecItem {
  if (!isObject(value)) throw new SpecError("SPEC_INVALID", "spec.yaml must be an object");
  const unknown = Object.keys(value).filter((key) => !ITEM_KEYS.has(key));
  if (unknown.length > 0) {
    throw new SpecError("SPEC_INVALID", `spec.yaml contains unknown fields: ${unknown.join(", ")}`);
  }
  if (value.__schema !== 1) throw new SpecError("SPEC_INVALID", "spec.__schema must be 1");
  const id = typeof value.id === "string" ? assertId(value.id) : assertId("");
  if (id !== expectedId) {
    throw new SpecError("SPEC_INVALID", `spec directory/id mismatch: ${expectedId} != ${id}`);
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    throw new SpecError("SPEC_INVALID", "spec title must not be empty");
  }
  const state = assertState(value.state);
  const scope = assertScope(value.scope);
  const strength = assertStrength(value.strength);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new SpecError("SPEC_INVALID", "spec revision must be a non-negative integer");
  }
  for (const field of ["created_at", "updated_at"] as const) {
    if (
      typeof value[field] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[field] as string) ||
      Number.isNaN(Date.parse(value[field] as string))
    ) {
      throw new SpecError("SPEC_INVALID", `${field} must be an ISO timestamp`);
    }
  }
  const derivedFrom = parseProvenance(value.derived_from);
  const supersededBy = assertIdArray(value.superseded_by, "superseded_by");
  if (supersededBy.includes(id)) {
    throw new SpecError("SPEC_RELATION_INVALID", `spec cannot supersede itself: ${id}`);
  }
  if (supersededBy.length > 0 && state !== "retired") {
    throw new SpecError("SPEC_RELATION_INVALID", "superseded_by is only valid for a retired spec");
  }
  return {
    __schema: 1,
    id,
    title: value.title.trim(),
    state,
    scope,
    strength,
    revision: value.revision as number,
    created_at: value.created_at as string,
    updated_at: value.updated_at as string,
    derived_from: derivedFrom,
    superseded_by: supersededBy,
  };
}

function serializeItem(item: SpecItem): string {
  return stringify(item, { lineWidth: 0 });
}

function errorFrom(error: unknown, fallback = "spec storage operation failed"): SpecError {
  if (error instanceof SpecError) return error;
  if (error instanceof TaskInvalidEncodingError) {
    return new SpecError("SPEC_INVALID_ENCODING", error.message.replace(/^task /, "spec "), {
      cause: error,
    });
  }
  if (error instanceof TaskStorageBoundaryError) {
    return new SpecError("SPEC_STORAGE_BOUNDARY", error.message.replace(/^task /, "spec "), {
      cause: error,
    });
  }
  if (error instanceof TaskLockUnavailableError) {
    return new SpecError("SPEC_CONFLICT", error.message.replace(/task/g, "spec"), { cause: error });
  }
  return new SpecError("SPEC_IO_ERROR", fallback, { cause: error });
}

function throwStorage(error: unknown): never {
  if (error instanceof FrameworkError) throw error;
  throw errorFrom(error);
}

async function locationFor(rootInput: string, tolerateSpecStorage = false): Promise<SpecLocation> {
  const root = path.resolve(rootInput);
  const manifest = await loadManifest(root);
  if (!manifest)
    throw new SpecError("WORKSPACE_NOT_FOUND", `No workspace manifest found at ${root}.`);
  const layout = resolveWorkspaceLayout(manifest) ?? defaultStandaloneLayout();
  const envelope = await resolveEnvelopeContext(root);
  await assertProjectAvailable(root, layout);
  const directory = path.join(root, workspaceWorkRelativePath(layout, "project/specs"));
  const archiveDirectory = path.join(directory, "archive");
  const locksDirectory = path.join(envelope.path, "spec-locks");
  const stagingDirectory = path.join(envelope.path, "spec-staging");
  if (!tolerateSpecStorage) await assertTaskStorageBoundary(root, directory).catch(throwStorage);
  await assertTaskStorageBoundary(root, locksDirectory).catch(throwStorage);
  await assertTaskStorageBoundary(root, stagingDirectory).catch(throwStorage);
  return { root, layout, directory, archiveDirectory, locksDirectory, stagingDirectory };
}

async function assertProjectAvailable(root: string, layout: WorkspaceLayout): Promise<void> {
  try {
    await validateNativeProjectStructure(root, layout);
    if ((await loadNativeProject(root, layout)) === null) throw new Error("native Project missing");
  } catch (error) {
    throw new SpecError(
      "SPEC_PROJECT_INVALID",
      `native Project is required for Spec operations: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function itemDirectory(location: SpecLocation, id: string, archived: boolean): string {
  return path.join(archived ? location.archiveDirectory : location.directory, assertId(id));
}

function itemLock(location: SpecLocation, id: string): string {
  return path.join(location.locksDirectory, assertId(id));
}

function graphLock(location: SpecLocation): string {
  return path.join(location.locksDirectory, ".graph-create");
}

/** Serialize conversion with every native Spec create, mutation, and archive. */
export async function withSpecGlobalCoordination<T>(
  root: string,
  callback: () => Promise<T>,
): Promise<T> {
  const location = await locationFor(root);
  return withTaskLock(location.root, graphLock(location), async () => {
    await assertProjectAvailable(location.root, location.layout);
    return callback();
  }).catch((error: unknown) => {
    if (
      error instanceof SpecError ||
      error instanceof TaskInvalidEncodingError ||
      error instanceof TaskStorageBoundaryError ||
      error instanceof TaskLockUnavailableError
    ) {
      throwStorage(error);
    }
    throw error;
  });
}

function displayPath(location: SpecLocation, target: string): string {
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

function identity(stats: Stats): FileIdentity {
  return {
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function assertRealDirectory(root: string, target: string): Promise<void> {
  await assertTaskStorageBoundary(root, target);
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || !(await identitySafeRealpath(target))) {
    throw new SpecError("SPEC_STORAGE_BOUNDARY", `spec path is not a real directory: ${target}`);
  }
}

async function assertShape(location: SpecLocation, directory: string): Promise<void> {
  await assertRealDirectory(location.root, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const required of [ITEM_FILE, BODY_FILE]) {
    const entry = entries.find((candidate) => candidate.name === required);
    if (!entry || !entry.isFile() || entry.isSymbolicLink()) {
      throw new SpecError(
        "SPEC_STORAGE_BOUNDARY",
        `spec item requires a regular ${required}: ${directory}`,
      );
    }
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new SpecError(
        "SPEC_STORAGE_BOUNDARY",
        `spec item contains a redirect: ${path.join(directory, entry.name)}`,
      );
    }
    if (![ITEM_FILE, BODY_FILE].includes(entry.name)) {
      throw new SpecError("SPEC_INVALID", `spec item contains an unknown entry: ${entry.name}`);
    }
  }
}

async function readSnapshot(file: string, rootBoundary?: string): Promise<FileSnapshot> {
  if (rootBoundary) await assertTaskStorageBoundary(rootBoundary, file);
  const resolved = path.resolve(file);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink() || !(await identitySafeRealpath(resolved))) {
    throw new SpecError("SPEC_STORAGE_BOUNDARY", `spec source is not a real regular file: ${file}`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new SpecError("SPEC_INVALID", `spec file exceeds ${MAX_FILE_BYTES} bytes: ${file}`);
  }
  const bytes = await readFile(resolved);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SpecError("SPEC_INVALID_ENCODING", `spec file is not valid UTF-8: ${file}`, {
      cause: error,
    });
  }
  return { file: resolved, bytes, text, identity: identity(info) };
}

async function assertSnapshotUnchanged(before: FileSnapshot, rootBoundary?: string): Promise<void> {
  const after = await readSnapshot(before.file, rootBoundary);
  if (!sameIdentity(before.identity, after.identity) || !sameBytes(before.bytes, after.bytes)) {
    throw new SpecError("SPEC_CONFLICT", `source changed before spec publication: ${before.file}`);
  }
}

async function readAt(location: SpecLocation, located: LocatedSpec, id: string): Promise<ReadSpec> {
  await assertShape(location, located.directory);
  const [itemSnapshot, bodySnapshot] = await Promise.all([
    readSnapshot(path.join(located.directory, ITEM_FILE), location.root),
    readSnapshot(path.join(located.directory, BODY_FILE), location.root),
  ]);
  let decoded: unknown;
  try {
    decoded = parse(itemSnapshot.text);
  } catch (error) {
    throw new SpecError("SPEC_INVALID", `spec YAML is invalid: ${id}`, { cause: error });
  }
  const item = parseItem(decoded, id);
  return {
    itemSnapshot,
    bodySnapshot,
    result: {
      root: location.root,
      path: displayPath(location, located.directory),
      archived: located.archived,
      item,
      specification: bodySnapshot.text,
    },
  };
}

async function locate(location: SpecLocation, idInput: string): Promise<LocatedSpec> {
  const id = assertId(idInput);
  const live = itemDirectory(location, id, false);
  const archived = itemDirectory(location, id, true);
  const hasLive = await exists(live);
  let hasArchived = false;
  let archiveError: SpecError | undefined;
  try {
    if (await exists(location.archiveDirectory)) {
      await assertRealDirectory(location.root, location.archiveDirectory);
      hasArchived = await exists(archived);
    }
  } catch (error) {
    archiveError = errorFrom(
      error,
      `spec archive root is unreadable: ${location.archiveDirectory}`,
    );
  }
  if (hasLive && hasArchived) {
    throw new SpecError("SPEC_CONFLICT", `spec exists in live and archive storage: ${id}`);
  }
  if (hasLive) return { directory: live, archived: false };
  if (archiveError) throw archiveError;
  if (!hasLive && !hasArchived) throw new SpecError("SPEC_NOT_FOUND", `spec not found: ${id}`);
  return { directory: archived, archived: true };
}

async function listEntries(location: SpecLocation, archived: boolean): Promise<Dirent[]> {
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

async function listEntriesForValidation(
  location: SpecLocation,
  archived: boolean,
): Promise<{ readonly entries: readonly Dirent[]; readonly issue?: SpecIssue }> {
  const directory = archived ? location.archiveDirectory : location.directory;
  try {
    if (!(await exists(directory))) return { entries: [] };
    await assertRealDirectory(location.root, directory);
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => archived || !["README.md", "archive"].includes(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    return { entries };
  } catch (error) {
    const mapped = errorFrom(error, `spec storage root is unreadable: ${directory}`);
    return {
      entries: [],
      issue: {
        code: mapped.code,
        message: mapped.message,
        path: displayPath(location, directory),
        archived,
      },
    };
  }
}

async function storedIds(location: SpecLocation): Promise<string[]> {
  const [live, archived] = await Promise.all([
    listEntries(location, false),
    listEntries(location, true),
  ]);
  return [...live, ...archived].map((entry) => entry.name);
}

async function assertWritableInventory(location: SpecLocation): Promise<void> {
  if (!(await exists(location.directory))) return;
  await assertRealDirectory(location.root, location.directory);
  const rootEntries = await readdir(location.directory, { withFileTypes: true });
  for (const entry of rootEntries) {
    const target = path.join(location.directory, entry.name);
    if (entry.name === "README.md") {
      await readSnapshot(target, location.root);
      continue;
    }
    if (entry.name === "archive") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new SpecError("SPEC_STORAGE_BOUNDARY", "spec archive must be a real directory");
      }
      await assertRealDirectory(location.root, target);
      continue;
    }
    if (!isReadableId("spec", entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new SpecError(
        "SPEC_INVALID",
        `project/specs contains unknown content; inventory it before writing: ${entry.name}`,
      );
    }
    await readAt(location, { directory: target, archived: false }, entry.name);
  }
  for (const entry of await listEntries(location, true)) {
    if (!isReadableId("spec", entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new SpecError(
        "SPEC_INVALID",
        `project/specs/archive contains unknown content; inventory it before writing: ${entry.name}`,
      );
    }
    const read = await readAt(
      location,
      { directory: path.join(location.archiveDirectory, entry.name), archived: true },
      entry.name,
    );
    if (read.result.item.state !== "retired") {
      throw new SpecError("SPEC_NOT_RETIRED", `archived spec is not retired: ${entry.name}`);
    }
  }
  const ids = await storedIds(location);
  if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
    throw new SpecError("SPEC_CONFLICT", "spec id exists in both live and archive storage");
  }
}

async function ensureRoot(location: SpecLocation): Promise<void> {
  await mkdir(location.directory, { recursive: true });
  await assertRealDirectory(location.root, location.directory);
  const readme = path.join(location.directory, "README.md");
  if (!(await exists(readme))) {
    await writeFile(readme, projectSpecsReadme(), { encoding: "utf8", flag: "wx" });
  } else {
    await readSnapshot(readme, location.root);
  }
}

async function resolveScope(location: SpecLocation, selector: string): Promise<SpecScope> {
  if (selector === "project") {
    const project = await loadNativeProject(location.root, location.layout);
    if (!project) throw new SpecError("SPEC_SCOPE_INVALID", "native Project scope is unavailable");
    return { kind: "project", id: project.id };
  }
  if (selector.startsWith("system:") && selector.slice("system:".length).length > 0) {
    const id = selector.slice("system:".length);
    const registry = await loadSystemsRegistry(location.root);
    if (!registry || !systemRecordForSelector(registry, id)) {
      throw new SpecError("SPEC_SCOPE_INVALID", `registered system not found: ${id}`);
    }
    return { kind: "system", id };
  }
  throw new SpecError("SPEC_SCOPE_INVALID", "scope must be project or system:<registered-id>");
}

async function scopeIssue(
  location: SpecLocation,
  scope: SpecScope,
): Promise<SpecIssue | undefined> {
  if (scope.kind === "project") {
    const project = await loadNativeProject(location.root, location.layout).catch(() => null);
    if (project?.id === scope.id) return undefined;
  } else {
    const registry = await loadSystemsRegistry(location.root);
    if (registry && systemRecordForSelector(registry, scope.id)) return undefined;
  }
  return {
    code: "SPEC_SCOPE_INVALID",
    message: `spec scope is unresolved: ${scope.kind}:${scope.id}`,
  };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function prepareAnalysisProvenance(
  location: SpecLocation,
  logicalPath: string,
): Promise<PreparedProvenance> {
  const normalized = assertLogicalAnalysisPath(logicalPath);
  const absolute = path.join(location.root, workspaceWorkRelativePath(location.layout, normalized));
  const snapshot = await readSnapshot(absolute, location.root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SpecError("SPEC_PROVENANCE_MISSING", `analysis source not found: ${normalized}`);
    }
    throw errorFrom(error, `analysis provenance source is invalid: ${normalized}`);
  });
  return {
    entry: { kind: "assay.analysis", path: normalized, sha256: digest(snapshot.bytes) },
    snapshot,
  };
}

async function prepareTaskProvenance(
  location: SpecLocation,
  taskId: string,
  taskFile: string,
): Promise<PreparedProvenance> {
  if (!isReadableId("task", taskId)) {
    throw new SpecError("SPEC_PROVENANCE_INVALID", `invalid native Task id: ${taskId}`);
  }
  const file = assertTaskSourceFile(taskFile);
  let task: Awaited<ReturnType<typeof showTask>>;
  try {
    task = await showTask({ root: location.root, id: taskId });
  } catch (error) {
    throw new SpecError("SPEC_PROVENANCE_MISSING", `task source not found or invalid: ${taskId}`, {
      cause: error,
    });
  }
  const snapshot = await readSnapshot(
    path.join(location.root, task.path, file),
    location.root,
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SpecError(
        "SPEC_PROVENANCE_MISSING",
        `task source file not found: ${taskId}/${file}`,
      );
    }
    throw errorFrom(error, `task provenance source is invalid: ${taskId}/${file}`);
  });
  return {
    entry: { kind: "assay.task", id: taskId, file, sha256: digest(snapshot.bytes) },
    snapshot,
  };
}

async function provenanceSnapshot(
  location: SpecLocation,
  provenance: SpecProvenance,
): Promise<FileSnapshot> {
  if (provenance.kind === "assay.analysis") {
    return readSnapshot(
      path.join(location.root, workspaceWorkRelativePath(location.layout, provenance.path)),
      location.root,
    );
  }
  const task = await showTask({ root: location.root, id: provenance.id });
  return readSnapshot(path.join(location.root, task.path, provenance.file), location.root);
}

function validateBodyStructure(body: string): void {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const found = lines.filter((line) => line.startsWith("## "));
  if (
    found.length !== BODY_HEADINGS.length ||
    found.some((line, index) => line !== BODY_HEADINGS[index])
  ) {
    throw new SpecError(
      "SPEC_BODY_INVALID",
      `specification.md must contain exactly these headings in order: ${BODY_HEADINGS.join("; ")}`,
    );
  }
  for (let index = 0; index < BODY_HEADINGS.length; index += 1) {
    const heading = BODY_HEADINGS[index];
    if (!heading || !REQUIRED_BODY_HEADINGS.has(heading)) continue;
    const start = lines.indexOf(heading) + 1;
    const nextHeading = BODY_HEADINGS[index + 1];
    const end = nextHeading ? lines.indexOf(nextHeading) : lines.length;
    if (lines.slice(start, end).every((line) => line.trim().length === 0)) {
      throw new SpecError("SPEC_BODY_INVALID", `${heading.slice(3)} must not be empty`);
    }
  }
}

async function createRecord(options: {
  readonly location: SpecLocation;
  readonly title: string;
  readonly scope: SpecScope;
  readonly strength: SpecStrength;
  readonly body?: FileSnapshot;
  readonly provenance?: PreparedProvenance;
  readonly now?: Date;
}): Promise<SpecRecordResult> {
  const { location } = options;
  return withTaskLock(location.root, graphLock(location), async () => {
    await assertProjectAvailable(location.root, location.layout);
    await assertWritableInventory(location);
    const id = allocateReadableId("spec", options.title, await storedIds(location));
    return withTaskLock(location.root, itemLock(location, id), async () => {
      await ensureRoot(location);
      const live = itemDirectory(location, id, false);
      const archived = itemDirectory(location, id, true);
      if ((await exists(live)) || (await exists(archived))) {
        throw new SpecError("SPEC_ALREADY_EXISTS", `spec already exists: ${id}`);
      }
      const now = (options.now ?? new Date()).toISOString();
      const item: SpecItem = {
        __schema: 1,
        id,
        title: options.title,
        state: "draft",
        scope: options.scope,
        strength: options.strength,
        revision: 0,
        created_at: now,
        updated_at: now,
        derived_from: options.provenance ? [options.provenance.entry] : [],
        superseded_by: [],
      };
      await mkdir(location.stagingDirectory, { recursive: true });
      await assertRealDirectory(location.root, location.stagingDirectory);
      const temporary = path.join(location.stagingDirectory, `.create-${id}-${randomUUID()}`);
      try {
        await mkdir(temporary, { recursive: false });
        await writeFile(path.join(temporary, ITEM_FILE), serializeItem(item), { flag: "wx" });
        await writeFile(
          path.join(temporary, BODY_FILE),
          options.body?.bytes ?? Buffer.from(specificationTemplate(), "utf8"),
          { flag: "wx" },
        );
        await promotionProbe?.(id);
        if (options.body) await assertSnapshotUnchanged(options.body);
        if (options.provenance)
          await assertSnapshotUnchanged(options.provenance.snapshot, location.root);
        await rename(temporary, live);
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        await rmdir(location.stagingDirectory).catch(() => undefined);
      }
      return (await readAt(location, { directory: live, archived: false }, id)).result;
    });
  }).catch(throwStorage);
}

export interface CreateSpecOptions {
  readonly root: string;
  readonly title: string;
  readonly scope: string;
  readonly strength: SpecStrength;
  readonly now?: Date;
}

export async function createSpec(options: CreateSpecOptions): Promise<SpecRecordResult> {
  const title = options.title.trim();
  if (!title) throw new SpecError("SPEC_INVALID", "spec title must not be empty");
  const location = await locationFor(options.root);
  return createRecord({
    location,
    title,
    scope: await resolveScope(location, options.scope),
    strength: assertStrength(options.strength),
    ...(options.now ? { now: options.now } : {}),
  });
}

export interface PromoteSpecOptions extends CreateSpecOptions {
  readonly bodyFile: string;
  readonly fromAnalysis?: string;
  readonly fromTask?: string;
  readonly taskFile?: string;
}

export async function promoteSpec(options: PromoteSpecOptions): Promise<SpecRecordResult> {
  const analysis = options.fromAnalysis !== undefined;
  const task = options.fromTask !== undefined;
  if (analysis === task) {
    throw new SpecError(
      "SPEC_PROVENANCE_INVALID",
      "promotion requires exactly one of fromAnalysis or fromTask",
    );
  }
  if (task !== (options.taskFile !== undefined)) {
    throw new SpecError(
      "SPEC_PROVENANCE_INVALID",
      "task promotion requires both fromTask and taskFile",
    );
  }
  const title = options.title.trim();
  if (!title) throw new SpecError("SPEC_INVALID", "spec title must not be empty");
  const location = await locationFor(options.root);
  const body = await readSnapshot(path.resolve(options.bodyFile)).catch((error) => {
    throw new SpecError(
      "SPEC_BODY_INVALID",
      `spec body source is unavailable or invalid: ${options.bodyFile}`,
      { cause: error },
    );
  });
  const provenance = analysis
    ? await prepareAnalysisProvenance(location, options.fromAnalysis as string)
    : await prepareTaskProvenance(location, options.fromTask as string, options.taskFile as string);
  return createRecord({
    location,
    title,
    scope: await resolveScope(location, options.scope),
    strength: assertStrength(options.strength),
    body,
    provenance,
    ...(options.now ? { now: options.now } : {}),
  });
}

export async function showSpec(options: {
  readonly root: string;
  readonly id: string;
}): Promise<SpecRecordResult> {
  const location = await locationFor(options.root);
  const id = assertId(options.id);
  const preliminaryLocation = await locate(location, id);
  const preliminary = await readAt(location, preliminaryLocation, id);
  if (preliminary.result.item.scope.kind === "system") {
    const issue = await scopeIssue(location, preliminary.result.item.scope);
    if (issue) throw new SpecError("SPEC_SCOPE_INVALID", issue.message);
  }
  return withTaskLock(location.root, itemLock(location, id), async () => {
    const located = await locate(location, id);
    const current = await readAt(location, located, id);
    if (current.result.item.scope.kind === "system") {
      const issue = await scopeIssue(location, current.result.item.scope);
      if (issue) throw new SpecError("SPEC_SCOPE_INVALID", issue.message);
    }
    return current.result;
  }).catch(throwStorage);
}

async function assertRecordUnchanged(before: ReadSpec): Promise<void> {
  const [after, bodyAfter] = await Promise.all([
    readSnapshot(before.itemSnapshot.file),
    readSnapshot(before.bodySnapshot.file),
  ]);
  if (
    !sameIdentity(before.itemSnapshot.identity, after.identity) ||
    !sameBytes(before.itemSnapshot.bytes, after.bytes) ||
    !sameIdentity(before.bodySnapshot.identity, bodyAfter.identity) ||
    !sameBytes(before.bodySnapshot.bytes, bodyAfter.bytes)
  ) {
    throw new SpecError("SPEC_CONFLICT", `spec changed outside ownwork: ${before.result.item.id}`);
  }
}

async function allReadable(
  location: SpecLocation,
  tolerateMalformedRoots = false,
): Promise<Map<string, ReadSpec>> {
  const output = new Map<string, ReadSpec>();
  for (const archived of [false, true]) {
    const entries = tolerateMalformedRoots
      ? (await listEntriesForValidation(location, archived)).entries
      : await listEntries(location, archived);
    for (const entry of entries) {
      if (!isReadableId("spec", entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
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
        // Partial validation reports malformed siblings without hiding healthy records.
      }
    }
  }
  return output;
}

async function validateProposedGraph(
  location: SpecLocation,
  proposed: SpecItem,
): Promise<readonly ReadSpec[]> {
  const graph = await allReadable(location);
  const snapshots = [...graph.values()];
  graph.set(proposed.id, {
    result: { root: location.root, path: "", archived: false, item: proposed, specification: "" },
    itemSnapshot: {
      file: "",
      bytes: Buffer.alloc(0),
      text: "",
      identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0 },
    },
    bodySnapshot: {
      file: "",
      bytes: Buffer.alloc(0),
      text: "",
      identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0 },
    },
  });
  for (const target of proposed.superseded_by) {
    const successor = graph.get(target);
    if (!successor) {
      throw new SpecError("SPEC_RELATION_INVALID", `spec successor not found: ${target}`);
    }
    if (successor.result.archived || successor.result.item.state !== "active") {
      throw new SpecError("SPEC_RELATION_INVALID", `spec successor must be active: ${target}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new SpecError(
        "SPEC_RELATION_CYCLE",
        `spec replacement graph contains a cycle at ${id}`,
      );
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of graph.get(id)?.result.item.superseded_by ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
  return snapshots;
}

function sameRelations(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

async function assertGraphSnapshotsUnchanged(
  location: SpecLocation,
  snapshots: readonly ReadSpec[],
): Promise<void> {
  for (const before of snapshots) {
    try {
      const id = before.result.item.id;
      const located = await locate(location, id);
      if (
        located.archived !== before.result.archived ||
        pathKey(located.directory) !== pathKey(path.dirname(before.itemSnapshot.file))
      ) {
        throw new Error("spec graph location changed");
      }
      const after = await readAt(location, located, id);
      if (
        !sameIdentity(before.itemSnapshot.identity, after.itemSnapshot.identity) ||
        !sameBytes(before.itemSnapshot.bytes, after.itemSnapshot.bytes) ||
        before.result.item.revision !== after.result.item.revision ||
        before.result.item.state !== after.result.item.state ||
        !sameRelations(before.result.item.superseded_by, after.result.item.superseded_by)
      ) {
        throw new Error("spec graph bytes or relations changed");
      }
    } catch (error) {
      throw new SpecError(
        "SPEC_CONFLICT",
        `spec graph changed outside ownwork before publication: ${before.result.item.id}`,
        { cause: error },
      );
    }
  }
}

async function mutate(
  location: SpecLocation,
  idInput: string,
  expectedRevision: number | undefined,
  update: (item: SpecItem, before: ReadSpec) => Promise<SpecItem> | SpecItem,
): Promise<SpecRecordResult> {
  const id = assertId(idInput);
  return withTaskLock(location.root, graphLock(location), async () => {
    await assertProjectAvailable(location.root, location.layout);
    return withTaskLock(location.root, itemLock(location, id), async () => {
      const located = await locate(location, id);
      if (located.archived) {
        throw new SpecError("SPEC_TERMINAL", `archived spec cannot be changed: ${id}`);
      }
      const before = await readAt(location, located, id);
      if (expectedRevision !== undefined && before.result.item.revision !== expectedRevision) {
        throw new SpecError(
          "SPEC_REVISION_CONFLICT",
          `spec revision changed: expected ${expectedRevision}, found ${before.result.item.revision}`,
          {
            details: {
              expected_revision: expectedRevision,
              actual_revision: before.result.item.revision,
            },
          },
        );
      }
      const proposed = await update(before.result.item, before);
      parseItem(proposed, id);
      const graphSnapshots = await validateProposedGraph(location, proposed);
      await mutationProbe?.(id);
      await assertRecordUnchanged(before);
      await assertGraphSnapshotsUnchanged(location, graphSnapshots);
      await atomicWriteTaskText(
        location.root,
        path.join(located.directory, ITEM_FILE),
        serializeItem(proposed),
      );
      return (await readAt(location, located, id)).result;
    });
  }).catch(throwStorage);
}

export interface UpdateSpecOptions {
  readonly root: string;
  readonly id: string;
  readonly title?: string;
  readonly scope?: string;
  readonly strength?: SpecStrength;
  readonly expectedRevision?: number;
  readonly now?: Date;
}

export async function updateSpec(options: UpdateSpecOptions): Promise<SpecRecordResult> {
  if (
    options.title === undefined &&
    options.scope === undefined &&
    options.strength === undefined
  ) {
    throw new SpecError("SPEC_INVALID", "spec update requires title, scope, or strength");
  }
  const location = await locationFor(options.root);
  const scope =
    options.scope === undefined ? undefined : await resolveScope(location, options.scope);
  return mutate(location, options.id, options.expectedRevision, (current) => {
    if (current.state !== "draft") {
      throw new SpecError(
        "SPEC_TERMINAL",
        `only draft specs can update their envelope: ${current.id}`,
      );
    }
    const title = options.title === undefined ? current.title : options.title.trim();
    if (!title) throw new SpecError("SPEC_INVALID", "spec title must not be empty");
    return {
      ...current,
      title,
      scope: scope ?? current.scope,
      strength:
        options.strength === undefined ? current.strength : assertStrength(options.strength),
      revision: current.revision + 1,
      updated_at: (options.now ?? new Date()).toISOString(),
    };
  });
}

export async function activateSpec(options: {
  readonly root: string;
  readonly id: string;
  readonly expectedRevision?: number;
  readonly now?: Date;
}): Promise<SpecRecordResult> {
  const location = await locationFor(options.root);
  return mutate(location, options.id, options.expectedRevision, (current, before) => {
    if (current.state !== "draft") {
      throw new SpecError("SPEC_TERMINAL", `only draft specs can activate: ${current.id}`);
    }
    validateBodyStructure(before.result.specification);
    return assertSnapshotUnchanged(before.bodySnapshot, location.root).then(() => ({
      ...current,
      state: "active" as const,
      revision: current.revision + 1,
      updated_at: (options.now ?? new Date()).toISOString(),
    }));
  });
}

export async function retireSpec(options: {
  readonly root: string;
  readonly id: string;
  readonly expectedRevision?: number;
  readonly now?: Date;
}): Promise<SpecRecordResult> {
  const location = await locationFor(options.root);
  return mutate(location, options.id, options.expectedRevision, (current) => {
    if (current.state === "retired") {
      throw new SpecError("SPEC_TERMINAL", `retired spec cannot reopen or change: ${current.id}`);
    }
    return {
      ...current,
      state: "retired",
      revision: current.revision + 1,
      updated_at: (options.now ?? new Date()).toISOString(),
    };
  });
}

export async function replaceSpec(options: {
  readonly root: string;
  readonly id: string;
  readonly with: readonly string[];
  readonly expectedRevision?: number;
  readonly now?: Date;
}): Promise<SpecRecordResult> {
  if (options.with.length === 0) {
    throw new SpecError("SPEC_RELATION_INVALID", "replace requires at least one active successor");
  }
  const successors = assertIdArray(options.with, "with");
  const location = await locationFor(options.root);
  return mutate(location, options.id, options.expectedRevision, async (current) => {
    if (current.state === "retired") {
      throw new SpecError("SPEC_TERMINAL", `retired spec cannot change: ${current.id}`);
    }
    for (const successor of successors) {
      if (successor === current.id) {
        throw new SpecError("SPEC_RELATION_INVALID", `spec cannot replace itself: ${successor}`);
      }
      const located = await locate(location, successor);
      const read = await readAt(location, located, successor);
      if (read.result.item.state !== "active" || read.result.archived) {
        throw new SpecError("SPEC_RELATION_INVALID", `spec successor must be active: ${successor}`);
      }
    }
    return {
      ...current,
      state: "retired",
      superseded_by: successors,
      revision: current.revision + 1,
      updated_at: (options.now ?? new Date()).toISOString(),
    };
  });
}

export async function archiveSpec(options: {
  readonly root: string;
  readonly id: string;
}): Promise<SpecRecordResult> {
  const location = await locationFor(options.root);
  const id = assertId(options.id);
  return withTaskLock(location.root, graphLock(location), async () => {
    await assertProjectAvailable(location.root, location.layout);
    return withTaskLock(location.root, itemLock(location, id), async () => {
      const live = itemDirectory(location, id, false);
      const archived = itemDirectory(location, id, true);
      const [hasLive, hasArchived] = await Promise.all([exists(live), exists(archived)]);
      if (hasLive && hasArchived) {
        throw new SpecError("SPEC_CONFLICT", `spec exists in live and archive storage: ${id}`);
      }
      if (hasArchived) {
        const existing = await readAt(location, { directory: archived, archived: true }, id);
        if (existing.result.item.state !== "retired") {
          throw new SpecError("SPEC_NOT_RETIRED", `archived spec is not retired: ${id}`);
        }
        return existing.result;
      }
      if (!hasLive) throw new SpecError("SPEC_NOT_FOUND", `spec not found: ${id}`);
      const current = await readAt(location, { directory: live, archived: false }, id);
      if (current.result.item.state !== "retired") {
        throw new SpecError("SPEC_NOT_RETIRED", `only retired specs can be archived: ${id}`);
      }
      await mkdir(location.archiveDirectory, { recursive: true });
      await assertRealDirectory(location.root, location.archiveDirectory);
      await archiveProbe?.(id);
      await assertSnapshotUnchanged(current.itemSnapshot, location.root);
      await assertSnapshotUnchanged(current.bodySnapshot, location.root);
      const latest = await readAt(location, { directory: live, archived: false }, id);
      if (latest.result.item.state !== "retired") {
        throw new SpecError("SPEC_NOT_RETIRED", `only retired specs can be archived: ${id}`);
      }
      if (await exists(archived)) {
        throw new SpecError("SPEC_ALREADY_EXISTS", `spec archive target already exists: ${id}`);
      }
      await rename(live, archived);
      return (await readAt(location, { directory: archived, archived: true }, id)).result;
    });
  }).catch(throwStorage);
}

async function validation(location: SpecLocation): Promise<SpecValidationResult> {
  const rootIssues: SpecIssue[] = [];
  const addRootIssue = (issue: SpecIssue): void => {
    if (
      !rootIssues.some((existing) => existing.code === issue.code && existing.path === issue.path)
    ) {
      rootIssues.push(issue);
    }
  };
  if (await exists(location.directory)) {
    try {
      await assertRealDirectory(location.root, location.directory);
      const readme = path.join(location.directory, "README.md");
      if (!(await exists(readme))) {
        addRootIssue({
          code: "SPEC_INVALID",
          message: "spec storage is missing its explanatory README.md",
          path: displayPath(location, location.directory),
        });
      } else {
        await readSnapshot(readme, location.root);
      }
    } catch (error) {
      const mapped = errorFrom(error);
      addRootIssue({
        code: mapped.code,
        message: mapped.message,
        path: displayPath(location, location.directory),
      });
    }
  }
  const records: SpecValidationResult["items"][number][] = [];
  const reads = new Map<string, ReadSpec>();
  const locations = new Map<string, number[]>();
  const liveListing = await listEntriesForValidation(location, false);
  const archiveListing = liveListing.issue
    ? { entries: [] as readonly Dirent[] }
    : await listEntriesForValidation(location, true);
  for (const [archived, listing] of [
    [false, liveListing],
    [true, archiveListing],
  ] as const) {
    if (listing.issue) addRootIssue(listing.issue);
    for (const entry of listing.entries) {
      const entryPath = path.join(
        archived ? location.archiveDirectory : location.directory,
        entry.name,
      );
      const issues: SpecIssue[] = [];
      if (!isReadableId("spec", entry.name)) {
        issues.push({
          code: "SPEC_ID_INVALID",
          message: `invalid spec storage entry: ${entry.name}`,
        });
      } else if (!entry.isDirectory() || entry.isSymbolicLink()) {
        issues.push({
          code: "SPEC_STORAGE_BOUNDARY",
          message: "spec entry is not a real directory",
        });
      } else {
        try {
          const read = await readAt(location, { directory: entryPath, archived }, entry.name);
          reads.set(`${archived ? "a" : "l"}:${entry.name}`, read);
          if (read.result.item.state === "active") validateBodyStructure(read.result.specification);
          if (archived && read.result.item.state !== "retired") {
            issues.push({ code: "SPEC_NOT_RETIRED", message: "archived spec is not retired" });
          }
          const unresolvedScope = await scopeIssue(location, read.result.item.scope);
          if (unresolvedScope) issues.push(unresolvedScope);
          for (const provenance of read.result.item.derived_from) {
            try {
              const source = await provenanceSnapshot(location, provenance);
              if (digest(source.bytes) !== provenance.sha256) {
                issues.push({
                  code: "SPEC_PROVENANCE_DRIFT",
                  message: `provenance source digest changed: ${provenance.kind === "assay.analysis" ? provenance.path : `${provenance.id}/${provenance.file}`}`,
                });
              }
            } catch (error) {
              issues.push({
                code: "SPEC_PROVENANCE_MISSING",
                message: `provenance source is unavailable: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }
        } catch (error) {
          if (error instanceof FrameworkError) throw error;
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
      const key = entry.name.toLowerCase();
      locations.set(key, [...(locations.get(key) ?? []), index]);
    }
  }
  if (records.length > MAX_RECORDS) {
    throw new SpecError("SPEC_INVALID", `spec storage exceeds ${MAX_RECORDS} records`);
  }
  for (const indices of locations.values()) {
    if (indices.length < 2) continue;
    for (const index of indices) {
      const current = records[index];
      if (!current) continue;
      const issue = {
        code: "SPEC_CONFLICT",
        message: `spec id exists more than once: ${current.id}`,
      };
      records[index] = { ...current, valid: false, issues: [...current.issues, issue] };
    }
  }
  const readableById = new Map<string, ReadSpec>();
  for (const read of reads.values()) {
    if (!readableById.has(read.result.item.id)) readableById.set(read.result.item.id, read);
  }
  const graphIssues = new Map<string, SpecIssue[]>();
  const addGraphIssue = (id: string, issue: SpecIssue): void => {
    const existing = graphIssues.get(id) ?? [];
    if (
      !existing.some(
        (candidate) => candidate.code === issue.code && candidate.message === issue.message,
      )
    ) {
      graphIssues.set(id, [...existing, issue]);
    }
  };
  for (const [id, read] of readableById) {
    for (const target of read.result.item.superseded_by) {
      if (!readableById.has(target)) {
        addGraphIssue(id, {
          code: "SPEC_RELATION_INVALID",
          message: `spec successor is unresolved: ${target}`,
        });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, trail: string[]): void => {
    if (visiting.has(id)) {
      for (const member of new Set(trail.slice(trail.indexOf(id)))) {
        addGraphIssue(member, {
          code: "SPEC_RELATION_CYCLE",
          message: `spec replacement graph cycle includes ${id}`,
        });
      }
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of readableById.get(id)?.result.item.superseded_by ?? []) {
      if (readableById.has(target)) visit(target, [...trail, target]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of readableById.keys()) visit(id, [id]);
  for (let index = 0; index < records.length; index += 1) {
    const current = records[index];
    if (!current) continue;
    const extra = graphIssues.get(current.id) ?? [];
    if (extra.length > 0) {
      records[index] = { ...current, valid: false, issues: [...current.issues, ...extra] };
    }
  }
  const issues = [
    ...rootIssues,
    ...records.flatMap((record) =>
      record.issues.map((issue) => ({
        ...issue,
        id: record.id,
        path: record.path,
        archived: record.archived,
      })),
    ),
  ];
  return { root: location.root, valid: issues.length === 0, items: records, issues };
}

export async function validateSpecs(options: {
  readonly root: string;
  readonly id?: string;
}): Promise<SpecValidationResult> {
  const location = await locationFor(options.root, true);
  const result = await validation(location).catch(throwStorage);
  if (options.id === undefined) return result;
  const id = assertId(options.id);
  const items = result.items.filter((item) => item.id.toLowerCase() === id.toLowerCase());
  if (items.length > 0) {
    const issues = items.flatMap((item) => item.issues);
    return { root: result.root, valid: issues.length === 0, items, issues };
  }
  const issue: SpecIssue = { code: "SPEC_NOT_FOUND", message: `spec not found: ${id}`, id };
  return { root: result.root, valid: false, items: [], issues: [issue] };
}

export interface ListSpecsOptions {
  readonly root: string;
  readonly state?: SpecState;
  readonly scope?: string;
  readonly strength?: SpecStrength;
  readonly archived?: SpecArchiveScope;
  readonly limit?: number;
  readonly cursor?: string;
}

export async function listSpecs(options: ListSpecsOptions): Promise<SpecListResult> {
  const location = await locationFor(options.root, true);
  const archiveScope = options.archived ?? "live";
  if (
    options.scope !== undefined &&
    options.scope !== "project" &&
    (!options.scope.startsWith("system:") || options.scope.slice("system:".length).length === 0)
  ) {
    throw new SpecError("SPEC_SCOPE_INVALID", "scope filter must be project or system:<id>");
  }
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new SpecError("SPEC_INVALID", `spec list limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  const validationResult = await validation(location).catch(throwStorage);
  const healthy = new Set(
    validationResult.items
      .filter((item) => item.valid)
      .map((item) => `${item.archived ? "a" : "l"}:${item.id}`),
  );
  const reads = await allReadable(location, true);
  let items: SpecListEntry[] = [];
  for (const read of reads.values()) {
    const { result } = read;
    if (!healthy.has(`${result.archived ? "a" : "l"}:${result.item.id}`)) continue;
    if (archiveScope === "live" && result.archived) continue;
    if (archiveScope === "archived" && !result.archived) continue;
    if (options.state !== undefined && result.item.state !== options.state) continue;
    if (options.strength !== undefined && result.item.strength !== options.strength) continue;
    if (
      options.scope !== undefined &&
      `${result.item.scope.kind}:${result.item.scope.id}` !== options.scope &&
      !(options.scope === "project" && result.item.scope.kind === "project")
    )
      continue;
    items.push({
      id: result.item.id,
      path: result.path,
      archived: result.archived,
      title: result.item.title,
      state: result.item.state,
      scope: result.item.scope,
      strength: result.item.strength,
      revision: result.item.revision,
      derived_from: result.item.derived_from,
      superseded_by: result.item.superseded_by,
    });
  }
  items = items.sort((left, right) => left.id.localeCompare(right.id));
  if (options.cursor !== undefined) {
    assertId(options.cursor);
    items = items.filter((item) => item.id.localeCompare(options.cursor as string) > 0);
  }
  const page = items.slice(0, limit);
  const last = page.at(-1);
  return {
    root: location.root,
    items: page,
    issues: validationResult.issues,
    ...(items.length > page.length && last ? { next_cursor: last.id } : {}),
  };
}
