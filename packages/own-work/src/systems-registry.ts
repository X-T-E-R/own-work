import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import {
  type AuthorityWriteProbe,
  recoverAuthorityFile,
  safelyWriteAuthorityFile,
} from "absorb-anything-core";
import {
  LEGACY_ENVELOPE_DIR,
  PREFERRED_ENVELOPE_DIR,
  SYSTEMS_REGISTRY_SCHEMA,
} from "absorb-anything-core";
import {
  AuthorityWriteConflictError,
  FrameworkAlreadyExistsError,
  FrameworkError,
  FrameworkNotFoundError,
  SystemsRegistryCutoverRequiredError,
} from "absorb-anything-core";
import { appendEvent } from "absorb-anything-core";
import { loadManifest } from "absorb-anything-core";
import { nowIso } from "absorb-anything-core";
import { withWorkspaceMutationCoordination } from "./coordination.js";
import { identitySafePathNamesOpenFile, identitySafeRealpath } from "./filesystem-boundary.js";
import {
  type SystemRecord,
  type SystemStatus,
  type SystemVcs,
  type SystemsRegistry,
  systemsRegistrySchema,
} from "./schemas.js";
import { withSemanticModel } from "./semantics.js";
import { stringifySortedJson, toPosixPath } from "./serialization.js";

export interface SystemsRegistryOptions {
  readonly now?: Date;
}

export interface SystemsRegistrySnapshot {
  readonly registry: SystemsRegistry;
  /** SHA-256 of the exact canonical authority bytes read from disk. */
  readonly revision: string;
}

export interface SaveSystemsRegistryOptions {
  /** Null only for first creation; otherwise the exact loaded snapshot revision. */
  readonly expectedRevision: string | null;
}

let systemsRegistrySaveProbe: AuthorityWriteProbe | undefined;

export function setSystemsRegistrySaveProbeForTests(probe: AuthorityWriteProbe | undefined): void {
  systemsRegistrySaveProbe = probe;
}

export interface RegisterSystemInput {
  /** Project-local canonical selector. Defaults to the locator basename. */
  readonly name?: string;
  readonly path: string;
  readonly vcs?: SystemVcs;
  readonly vcsRef?: string;
  readonly version?: string;
  readonly primary?: boolean;
  readonly supersedes?: readonly string[];
}

export interface SystemEntry {
  readonly selector: string;
  readonly system: SystemRecord;
}

export interface RegisterSystemResult extends SystemEntry {
  readonly root: string;
  readonly registry: SystemsRegistry;
  readonly eventFile: string;
}

export interface UpdateSystemInput {
  readonly path?: string;
  readonly vcs?: SystemVcs;
  readonly vcsRef?: string;
  readonly version?: string;
  readonly primary?: boolean;
  readonly supersedes?: readonly string[];
}

export type SystemUpdateField = "path" | "vcs" | "vcs_ref" | "version" | "supersedes" | "status";

export type SystemUpdateValue = string | readonly string[] | null;

export interface SystemUpdateChange {
  readonly field: SystemUpdateField;
  readonly previous: SystemUpdateValue;
  readonly current: SystemUpdateValue;
}

export interface UpdateSystemResult extends SystemEntry {
  readonly root: string;
  readonly registry: SystemsRegistry;
  readonly previous: SystemRecord;
  readonly changes: readonly SystemUpdateChange[];
  readonly eventFile: string;
}

export interface PromoteSystemResult extends SystemEntry {
  readonly root: string;
  readonly registry: SystemsRegistry;
  readonly previousPrimary: SystemEntry | null;
  readonly eventFile: string;
}

export interface ArchiveSystemInput {
  readonly dryRun?: boolean;
  readonly now?: Date;
}

export interface ArchiveSystemResult extends SystemEntry {
  readonly root: string;
  readonly dryRun: boolean;
  readonly archiveMode: "logical";
  readonly registry: SystemsRegistry;
  readonly eventFile: string | null;
}

interface NormalizedLocator {
  readonly recorded: string;
  readonly absolute: string;
  readonly external: boolean;
  readonly key: string;
}

export function systemsRegistryPath(root: string): string {
  const envelope = existsSync(path.join(root, PREFERRED_ENVELOPE_DIR))
    ? PREFERRED_ENVELOPE_DIR
    : LEGACY_ENVELOPE_DIR;
  return path.join(root, envelope, "systems-registry.json");
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function systemRecordForSelector(
  registry: SystemsRegistry,
  selector: string,
): SystemRecord | undefined {
  return hasOwn(registry.systems, selector) ? registry.systems[selector] : undefined;
}

function systemMap(entries: Iterable<readonly [string, SystemRecord]>): SystemsRegistry["systems"] {
  const systems = Object.create(null) as SystemsRegistry["systems"];
  for (const [selector, record] of entries) {
    Object.defineProperty(systems, selector, {
      value: record,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return systems;
}

function revisionOf(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * One lexical locator codec is shared by every System reader and writer.
 * Workspace-owned locators are normalized POSIX-relative paths; external
 * locators remain normalized absolute paths and can never be reclassified as
 * workspace-owned by a later realpath operation.
 */
export function normalizeRegistryPath(root: string, value: string): string {
  return normalizeLocator(root, value).recorded;
}

function normalizeLocator(root: string, value: string): NormalizedLocator {
  if (value.length === 0 || value.includes("\0")) {
    throw new FrameworkError("system locator must be a non-empty ordinary path");
  }
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, value);
  const external = !isContained(resolvedRoot, absolute);
  if (!path.isAbsolute(value) && external) {
    throw new FrameworkError(`relative system locator escapes the workspace: ${value}`);
  }
  const recorded = external
    ? toPosixPath(path.normalize(absolute))
    : toPosixPath(path.relative(resolvedRoot, absolute)) || ".";
  return { recorded, absolute, external, key: pathKey(absolute) };
}

/** Absolute locator for a record that already passed full registry validation. */
export function resolveRegistryPath(root: string, recordedPath: string): string {
  return normalizeLocator(root, recordedPath).absolute;
}

async function nearestExistingAncestor(target: string): Promise<string> {
  let current = path.resolve(target);
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current)
      throw new FrameworkError(`system locator has no existing ancestor: ${target}`);
    current = parent;
  }
}

async function assertLocatorBoundary(
  root: string,
  selector: string,
  locator: NormalizedLocator,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const rootIdentity = await identitySafeRealpath(resolvedRoot);
  if (!rootIdentity) {
    throw new FrameworkError(`workspace root resolves through a redirect: ${root}`);
  }
  const ancestor = await nearestExistingAncestor(locator.absolute);
  const info = await lstat(ancestor);
  if (info.isSymbolicLink()) {
    throw new FrameworkError(
      `system '${selector}' locator resolves through a redirect: ${locator.recorded}`,
    );
  }
  if (samePath(ancestor, locator.absolute) && !info.isDirectory()) {
    throw new FrameworkError(
      `system '${selector}' locator is not a directory: ${locator.recorded}`,
    );
  }
  const ancestorIdentity = await identitySafeRealpath(ancestor);
  if (!ancestorIdentity) {
    throw new FrameworkError(
      `system '${selector}' locator resolves through a redirect: ${locator.recorded}`,
    );
  }
  const canonicalTarget = path.resolve(
    ancestorIdentity.canonical,
    path.relative(ancestor, locator.absolute),
  );
  const canonicalInside = isContained(rootIdentity.canonical, canonicalTarget);
  if (locator.external ? canonicalInside : !canonicalInside) {
    throw new FrameworkError(
      `system '${selector}' locator crosses its ${locator.external ? "external" : "workspace"} boundary: ${locator.recorded}`,
    );
  }
}

function validateRegistryGraph(
  root: string,
  registry: SystemsRegistry,
): Map<string, NormalizedLocator> {
  const selectors = Object.keys(registry.systems);
  for (const selector of selectors) {
    if (!selector || selector !== selector.trim()) {
      throw new FrameworkError(`systems registry selector is not canonical: '${selector}'`);
    }
  }

  const primarySelectors = selectors.filter(
    (selector) => systemRecordForSelector(registry, selector)?.status === "primary",
  );
  if (
    primarySelectors.length !== 1 ||
    primarySelectors[0] !== registry.primary ||
    !systemRecordForSelector(registry, registry.primary)
  ) {
    throw new FrameworkError(
      `systems registry must have exactly one primary matching pointer '${registry.primary}'`,
    );
  }

  const locators = new Map<string, NormalizedLocator>();
  const liveByLocator = new Map<string, string>();
  for (const selector of selectors) {
    const system = systemRecordForSelector(registry, selector);
    if (!system) continue;
    const normalized = normalizeLocator(root, system.path);
    if (system.path !== normalized.recorded) {
      throw new FrameworkError(
        `system '${selector}' locator is not normalized; expected '${normalized.recorded}'`,
      );
    }
    locators.set(selector, normalized);
    if (system.status !== "archived") {
      const previous = liveByLocator.get(normalized.key);
      if (previous) {
        throw new FrameworkError(
          `live systems '${previous}' and '${selector}' share locator '${normalized.recorded}'`,
        );
      }
      liveByLocator.set(normalized.key, selector);
    }

    const edges = new Set<string>();
    for (const target of system.supersedes) {
      if (!systemRecordForSelector(registry, target)) {
        throw new FrameworkError(`system '${selector}' supersedes unknown selector '${target}'`);
      }
      if (target === selector) {
        throw new FrameworkError(`system '${selector}' cannot supersede itself`);
      }
      if (edges.has(target)) {
        throw new FrameworkError(`system '${selector}' repeats supersedes edge '${target}'`);
      }
      edges.add(target);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (selector: string): void => {
    if (visiting.has(selector)) {
      throw new FrameworkError(
        `systems registry supersedes graph contains a cycle at '${selector}'`,
      );
    }
    if (visited.has(selector)) return;
    visiting.add(selector);
    for (const target of systemRecordForSelector(registry, selector)?.supersedes ?? []) {
      visit(target);
    }
    visiting.delete(selector);
    visited.add(selector);
  };
  for (const selector of selectors) visit(selector);
  return locators;
}

async function validateRegistry(root: string, registry: SystemsRegistry): Promise<void> {
  const locators = validateRegistryGraph(root, registry);
  for (const [selector, locator] of locators) {
    await assertLocatorBoundary(root, selector, locator);
  }
}

function observedRegistrySchema(data: unknown): number | "unknown" {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "unknown";
  const value = (data as Record<string, unknown>).__schema;
  return typeof value === "number" ? value : "unknown";
}

async function parseRegistryBytes(
  root: string,
  bytes: Buffer,
  file: string,
): Promise<SystemsRegistry> {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new FrameworkError(`systems registry is not valid JSON: ${file}`, { cause: error });
  }
  const observed = observedRegistrySchema(data);
  if (observed !== SYSTEMS_REGISTRY_SCHEMA) {
    throw new SystemsRegistryCutoverRequiredError(observed);
  }
  const result = systemsRegistrySchema.safeParse(data);
  if (!result.success) {
    throw new FrameworkError(`systems registry failed validation: ${file}`, {
      details: result.error.flatten(),
      cause: result.error,
    });
  }
  const registry: SystemsRegistry = {
    ...result.data,
    systems: systemMap(Object.entries(result.data.systems)),
  };
  await validateRegistry(root, registry);
  return registry;
}

async function readRegistryAuthority(file: string, allowTransactionLink = false): Promise<Buffer> {
  const namedBefore = await lstat(file);
  const allowedLinks = allowTransactionLink ? new Set([1, 2]) : new Set([1]);
  if (
    !namedBefore.isFile() ||
    namedBefore.isSymbolicLink() ||
    !allowedLinks.has(namedBefore.nlink)
  ) {
    throw new FrameworkError(`systems registry must be an ordinary, unshared file: ${file}`);
  }
  const safePath = await identitySafeRealpath(file);
  if (!safePath) {
    throw new FrameworkError(`systems registry must not resolve through a redirect: ${file}`);
  }
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !allowedLinks.has(opened.nlink) ||
      !(await identitySafePathNamesOpenFile(file, handle, safePath))
    ) {
      throw new FrameworkError(`systems registry identity changed while opening: ${file}`);
    }
    const bytes = await handle.readFile();
    const namedAfter = await lstat(file);
    if (
      !allowedLinks.has(namedAfter.nlink) ||
      !(await identitySafePathNamesOpenFile(file, handle, safePath))
    ) {
      throw new FrameworkError(`systems registry identity changed while reading: ${file}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readAndParseRegistry(
  root: string,
  file: string,
  allowTransactionLink = false,
): Promise<SystemsRegistrySnapshot | null> {
  let bytes: Buffer;
  try {
    bytes = await readRegistryAuthority(file, allowTransactionLink);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return { registry: await parseRegistryBytes(root, bytes, file), revision: revisionOf(bytes) };
}

/**
 * A transaction permits exactly the two non-terminal target forms created by
 * the authority protocol: missing after old isolation, or an ordinary nlink-2
 * replacement after linking. When target bytes exist they are still parsed
 * and fully validated before recovery, so an r2 authority cannot cause writes.
 */
async function loadSystemsRegistrySnapshotUnlocked(
  root: string,
): Promise<SystemsRegistrySnapshot | null> {
  await loadManifest(root);
  const file = systemsRegistryPath(root);
  const transaction = path.join(path.dirname(file), `.authority-${path.basename(file)}.txn`);
  let transactionExists = true;
  try {
    await lstat(transaction);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      transactionExists = false;
    } else {
      throw error;
    }
  }

  if (!transactionExists) return readAndParseRegistry(root, file);

  // If a target exists, establish current schema/invariants before recovery.
  // A missing target is a legitimate after-old-moved window; the transaction
  // receipts and rollback/stage identities are then the only recovery source.
  await readAndParseRegistry(root, file, true);
  await recoverAuthorityFile({
    root,
    file,
    error: (message, cause) => new FrameworkError(message, cause === undefined ? {} : { cause }),
    ...(systemsRegistrySaveProbe ? { probe: systemsRegistrySaveProbe } : {}),
  });
  const recovered = await readAndParseRegistry(root, file);
  if (!recovered) {
    throw new FrameworkError(`systems registry recovery produced no authority: ${file}`);
  }
  return recovered;
}

export async function loadSystemsRegistrySnapshot(
  root: string,
): Promise<SystemsRegistrySnapshot | null> {
  return withWorkspaceMutationCoordination(root, () => loadSystemsRegistrySnapshotUnlocked(root));
}

export async function loadSystemsRegistry(root: string): Promise<SystemsRegistry | null> {
  return (await loadSystemsRegistrySnapshot(root))?.registry ?? null;
}

async function saveSystemsRegistryUnlocked(
  root: string,
  registry: SystemsRegistry,
  options: SaveSystemsRegistryOptions,
): Promise<SystemsRegistry> {
  await loadManifest(root);
  const file = systemsRegistryPath(root);
  const current = await loadSystemsRegistrySnapshot(root);
  if ((current?.revision ?? null) !== options.expectedRevision) {
    throw new AuthorityWriteConflictError(
      `systems registry revision changed before write: ${file}`,
    );
  }
  const parsed = systemsRegistrySchema.parse({ ...registry, updated_at: nowIso() });
  const next: SystemsRegistry = {
    ...parsed,
    systems: systemMap(Object.entries(parsed.systems)),
  };
  await validateRegistry(root, next);
  const content = stringifySortedJson(next);
  await safelyWriteAuthorityFile({
    root,
    file,
    content,
    validateExisting: async (bytes) => {
      if (!bytes) {
        if (options.expectedRevision !== null) {
          throw new AuthorityWriteConflictError(
            `systems registry disappeared before write: ${file}`,
          );
        }
        return;
      }
      await parseRegistryBytes(root, bytes, file);
      if (revisionOf(bytes) !== options.expectedRevision) {
        throw new AuthorityWriteConflictError(
          `systems registry revision changed during write: ${file}`,
        );
      }
    },
    error: (message, cause) => new FrameworkError(message, cause === undefined ? {} : { cause }),
    ...(systemsRegistrySaveProbe ? { probe: systemsRegistrySaveProbe } : {}),
  });
  return next;
}

export async function saveSystemsRegistry(
  root: string,
  registry: SystemsRegistry,
  options: SaveSystemsRegistryOptions,
): Promise<SystemsRegistry> {
  return withWorkspaceMutationCoordination(root, () =>
    saveSystemsRegistryUnlocked(root, registry, options),
  );
}

export async function requireSystemsRegistry(root: string): Promise<SystemsRegistry> {
  return (await requireSystemsRegistrySnapshot(root)).registry;
}

export async function requireSystemsRegistrySnapshot(
  root: string,
): Promise<SystemsRegistrySnapshot> {
  const snapshot = await loadSystemsRegistrySnapshot(root);
  if (!snapshot) {
    throw new FrameworkNotFoundError(
      `No systems registry found at ${systemsRegistryPath(root)}. Run \`ownwork system register\` first.`,
    );
  }
  return snapshot;
}

export async function findSystemEntry(
  registry: SystemsRegistry,
  selector: string,
): Promise<SystemEntry> {
  const canonical = selector.trim();
  if (!canonical || canonical !== selector) {
    throw new FrameworkNotFoundError(`system selector is not canonical: '${selector}'`);
  }
  const system = systemRecordForSelector(registry, canonical);
  if (!system) throw new FrameworkNotFoundError(`system not found: ${selector}`);
  return { selector: canonical, system };
}

export async function findSystem(
  registry: SystemsRegistry,
  selector: string,
): Promise<SystemRecord> {
  return (await findSystemEntry(registry, selector)).system;
}

function cloneSystemRecord(system: SystemRecord): SystemRecord {
  return { ...system, supersedes: [...system.supersedes] };
}

function setPrimaryInPlace(registry: SystemsRegistry, selector: string, dateStamp: string): void {
  for (const [existingSelector, system] of Object.entries(registry.systems)) {
    if (system.status === "primary" && existingSelector !== selector) {
      registry.systems[existingSelector] = {
        ...system,
        status: "superseded",
        absorbed_on: dateStamp,
      };
    }
  }
  const target = systemRecordForSelector(registry, selector);
  if (target) {
    const { absorbed_on: _absorbedOn, archived_on: _archivedOn, ...live } = target;
    registry.systems[selector] = { ...live, status: "primary" };
  }
  registry.primary = selector;
}

function updateValuesEqual(previous: SystemUpdateValue, current: SystemUpdateValue): boolean {
  if (Array.isArray(previous) || Array.isArray(current)) {
    return (
      Array.isArray(previous) &&
      Array.isArray(current) &&
      previous.length === current.length &&
      previous.every((value, index) => current[index] === value)
    );
  }
  return previous === current;
}

function collectSystemUpdateChanges(
  previous: SystemRecord,
  current: SystemRecord,
): readonly SystemUpdateChange[] {
  const changes: SystemUpdateChange[] = [];
  const add = (
    field: SystemUpdateField,
    before: SystemUpdateValue,
    after: SystemUpdateValue,
  ): void => {
    if (!updateValuesEqual(before, after))
      changes.push({ field, previous: before, current: after });
  };
  add("path", previous.path, current.path);
  add("vcs", previous.vcs, current.vcs);
  add("vcs_ref", previous.vcs_ref, current.vcs_ref);
  add("version", previous.version, current.version);
  add("supersedes", previous.supersedes, current.supersedes);
  add("status", previous.status, current.status);
  return changes;
}

async function registerSystemUnlocked(
  root: string,
  input: RegisterSystemInput,
  options: SystemsRegistryOptions = {},
): Promise<RegisterSystemResult> {
  const now = options.now ?? new Date();
  const snapshot = await loadSystemsRegistrySnapshot(root);
  const existing = snapshot?.registry ?? null;
  const normalizedPath = normalizeRegistryPath(root, input.path);
  const selector = input.name ?? path.basename(path.resolve(root, input.path));
  if (!selector || selector !== selector.trim()) {
    throw new FrameworkError(`system selector is not canonical: '${selector}'`);
  }
  if (existing && systemRecordForSelector(existing, selector)) {
    throw new FrameworkAlreadyExistsError(
      withSemanticModel(`system already registered: ${selector}`, "systemAlreadyRegistered"),
    );
  }

  const record: SystemRecord = {
    path: normalizedPath,
    status: !existing || input.primary ? "primary" : "active",
    vcs: input.vcs ?? "embedded",
    vcs_ref: input.vcsRef ?? "",
    version: input.version ?? "0.1.0",
    supersedes: [...(input.supersedes ?? [])],
  };
  const registry: SystemsRegistry = existing
    ? {
        ...existing,
        systems: systemMap([...Object.entries(existing.systems), [selector, record]]),
      }
    : {
        __schema: 3,
        primary: selector,
        systems: { [selector]: record },
        updated_at: nowIso(now),
      };
  if (input.primary || !existing) setPrimaryInPlace(registry, selector, nowIso(now).slice(0, 10));

  const savedRegistry = await saveSystemsRegistry(root, registry, {
    expectedRevision: snapshot?.revision ?? null,
  });
  const savedSystem = systemRecordForSelector(savedRegistry, selector);
  if (!savedSystem) throw new FrameworkError(`registered system missing after save: ${selector}`);
  const eventFile = await appendEvent(
    root,
    {
      event: "system.registered",
      selector,
      path: savedSystem.path,
      vcs: savedSystem.vcs,
      primary: savedSystem.status === "primary",
    },
    now,
  );
  return {
    root,
    registry: savedRegistry,
    selector,
    system: savedSystem,
    eventFile: toPosixPath(path.relative(root, eventFile)),
  };
}

async function updateSystemUnlocked(
  root: string,
  selector: string,
  input: UpdateSystemInput,
  options: SystemsRegistryOptions = {},
): Promise<UpdateSystemResult> {
  const now = options.now ?? new Date();
  const snapshot = await requireSystemsRegistrySnapshot(root);
  const registry = snapshot.registry;
  const entry = await findSystemEntry(registry, selector);
  if (entry.system.status === "archived") {
    throw new FrameworkError(`cannot update an archived system: ${entry.selector}`);
  }
  const previous = cloneSystemRecord(entry.system);
  let updated = cloneSystemRecord(entry.system);
  if (input.path !== undefined)
    updated = { ...updated, path: normalizeRegistryPath(root, input.path) };
  if (input.vcs !== undefined) updated = { ...updated, vcs: input.vcs };
  if (input.vcsRef !== undefined) updated = { ...updated, vcs_ref: input.vcsRef };
  if (input.version !== undefined) updated = { ...updated, version: input.version };
  if (input.supersedes !== undefined) updated = { ...updated, supersedes: [...input.supersedes] };
  registry.systems[entry.selector] = updated;
  const previousPrimary =
    input.primary && registry.primary !== entry.selector ? registry.primary : null;
  if (input.primary) setPrimaryInPlace(registry, entry.selector, nowIso(now).slice(0, 10));

  const savedRegistry = await saveSystemsRegistry(root, registry, {
    expectedRevision: snapshot.revision,
  });
  const savedSystem = systemRecordForSelector(savedRegistry, entry.selector);
  if (!savedSystem)
    throw new FrameworkError(`updated system missing after save: ${entry.selector}`);
  const changes = collectSystemUpdateChanges(previous, savedSystem);
  const eventFile = await appendEvent(
    root,
    {
      event: "system.updated",
      selector: entry.selector,
      changed_fields: changes.map((change) => change.field),
      changes,
      primary: savedSystem.status === "primary",
      previous_primary: previousPrimary,
    },
    now,
  );
  return {
    root,
    registry: savedRegistry,
    selector: entry.selector,
    previous,
    system: savedSystem,
    changes,
    eventFile: toPosixPath(path.relative(root, eventFile)),
  };
}

async function promoteSystemUnlocked(
  root: string,
  selector: string,
  options: SystemsRegistryOptions = {},
): Promise<PromoteSystemResult> {
  const now = options.now ?? new Date();
  const snapshot = await requireSystemsRegistrySnapshot(root);
  const registry = snapshot.registry;
  const entry = await findSystemEntry(registry, selector);
  if (entry.system.status === "archived") {
    throw new FrameworkError(`cannot promote an archived system: ${entry.selector}`);
  }
  const previousSelector = registry.primary === entry.selector ? null : registry.primary;
  const previousRecord = previousSelector
    ? systemRecordForSelector(registry, previousSelector)
    : undefined;
  setPrimaryInPlace(registry, entry.selector, nowIso(now).slice(0, 10));
  const savedRegistry = await saveSystemsRegistry(root, registry, {
    expectedRevision: snapshot.revision,
  });
  const savedSystem = systemRecordForSelector(savedRegistry, entry.selector);
  if (!savedSystem)
    throw new FrameworkError(`promoted system missing after save: ${entry.selector}`);
  const eventFile = await appendEvent(
    root,
    {
      event: "system.promoted",
      selector: entry.selector,
      previous_primary: previousSelector,
    },
    now,
  );
  return {
    root,
    registry: savedRegistry,
    selector: entry.selector,
    system: savedSystem,
    previousPrimary:
      previousSelector && previousRecord
        ? {
            selector: previousSelector,
            system: systemRecordForSelector(savedRegistry, previousSelector) ?? previousRecord,
          }
        : null,
    eventFile: toPosixPath(path.relative(root, eventFile)),
  };
}

/**
 * Phase 8 deliberately stops at logical archive. No registered source is
 * copied, moved, deleted, or represented by a fictitious physical locator.
 */
async function archiveSystemUnlocked(
  root: string,
  selector: string,
  input: ArchiveSystemInput = {},
): Promise<ArchiveSystemResult> {
  const now = input.now ?? new Date();
  const snapshot = await requireSystemsRegistrySnapshot(root);
  const registry = snapshot.registry;
  const entry = await findSystemEntry(registry, selector);
  if (entry.system.status === "archived") {
    throw new FrameworkAlreadyExistsError(`system already archived: ${entry.selector}`);
  }
  if (entry.system.status === "primary") {
    throw new FrameworkError(
      `cannot archive the primary system; promote another system first: ${entry.selector}`,
    );
  }
  const { absorbed_on: _absorbedOn, ...record } = entry.system;
  const archived: SystemRecord = {
    ...record,
    status: "archived",
    archived_on: nowIso(now).slice(0, 10),
  };
  if (input.dryRun) {
    return {
      root,
      dryRun: true,
      archiveMode: "logical",
      registry,
      selector: entry.selector,
      system: archived,
      eventFile: null,
    };
  }
  registry.systems[entry.selector] = archived;
  const savedRegistry = await saveSystemsRegistry(root, registry, {
    expectedRevision: snapshot.revision,
  });
  const savedSystem = systemRecordForSelector(savedRegistry, entry.selector);
  if (!savedSystem)
    throw new FrameworkError(`archived system missing after save: ${entry.selector}`);
  const eventFile = await appendEvent(
    root,
    { event: "system.archived", selector: entry.selector, mode: "logical" },
    now,
  );
  return {
    root,
    dryRun: false,
    archiveMode: "logical",
    registry: savedRegistry,
    selector: entry.selector,
    system: savedSystem,
    eventFile: toPosixPath(path.relative(root, eventFile)),
  };
}

export async function registerSystem(
  root: string,
  input: RegisterSystemInput,
  options: SystemsRegistryOptions = {},
): Promise<RegisterSystemResult> {
  return withWorkspaceMutationCoordination(root, () =>
    registerSystemUnlocked(root, input, options),
  );
}

export async function updateSystem(
  root: string,
  selector: string,
  input: UpdateSystemInput,
  options: SystemsRegistryOptions = {},
): Promise<UpdateSystemResult> {
  return withWorkspaceMutationCoordination(root, () =>
    updateSystemUnlocked(root, selector, input, options),
  );
}

export async function promoteSystem(
  root: string,
  selector: string,
  options: SystemsRegistryOptions = {},
): Promise<PromoteSystemResult> {
  return withWorkspaceMutationCoordination(root, () =>
    promoteSystemUnlocked(root, selector, options),
  );
}

export async function archiveSystem(
  root: string,
  selector: string,
  input: ArchiveSystemInput = {},
): Promise<ArchiveSystemResult> {
  return withWorkspaceMutationCoordination(root, () =>
    archiveSystemUnlocked(root, selector, input),
  );
}

export async function listSystems(root: string): Promise<{
  readonly registry: SystemsRegistry;
  readonly systems: SystemEntry[];
}> {
  const registry = await requireSystemsRegistry(root);
  const order: Record<SystemStatus, number> = {
    primary: 0,
    active: 1,
    superseded: 2,
    archived: 3,
  };
  const systems = Object.entries(registry.systems)
    .map(([selector, system]) => ({ selector, system }))
    .sort(
      (left, right) =>
        order[left.system.status] - order[right.system.status] ||
        left.selector.localeCompare(right.selector),
    );
  return { registry, systems };
}
