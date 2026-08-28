import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { assertActiveEnvelopePath, withWorkspaceMutationCoordination } from "../coordination.js";
import { identitySafeRealpath } from "../filesystem-boundary.js";

export type TaskStorageProbePhase = "after-temp-sync" | "before-commit";
type TaskStorageProbe = (phase: TaskStorageProbePhase, target: string) => void | Promise<void>;
export type TaskLockProbeStage =
  | "after-owner-sync"
  | "before-claim"
  | "after-owner-entry-inspection";
type TaskLockProbe = (
  stage: TaskLockProbeStage,
  finalDirectory: string,
  temporaryDirectory: string,
) => void | Promise<void>;

let storageProbe: TaskStorageProbe | undefined;
let lockProbe: TaskLockProbe | undefined;
let lockWaitMs = 10_000;

/** Test-only failure injection for proving the atomic replacement boundary. */
export function setTaskStorageProbeForTests(probe: TaskStorageProbe | undefined): void {
  storageProbe = probe;
}

/** Test-only override for lock contention timing. */
export function setTaskLockWaitForTests(milliseconds: number | undefined): void {
  lockWaitMs = milliseconds ?? 10_000;
}

/** Test-only failure injection around the prepared-lock claim. */
export function setTaskLockProbeForTests(probe: TaskLockProbe | undefined): void {
  lockProbe = probe;
}

export class TaskStorageBoundaryError extends Error {
  readonly target: string;

  constructor(target: string, message: string) {
    super(message);
    this.name = "TaskStorageBoundaryError";
    this.target = target;
  }
}

export class TaskInvalidEncodingError extends Error {
  readonly target: string;

  constructor(target: string, cause?: unknown) {
    super(`task file is not valid UTF-8: ${target}`, cause === undefined ? undefined : { cause });
    this.name = "TaskInvalidEncodingError";
    this.target = target;
  }
}

export class TaskLockUnavailableError extends Error {
  readonly target: string;

  constructor(target: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TaskLockUnavailableError";
    this.target = target;
  }
}

/**
 * Windows keeps a delete-pending entry named but unopenable until the last
 * handle closes, so `lstat` and `realpath` answer EPERM/EACCES where POSIX
 * answers ENOENT. For a lock waiter both answers carry the same fact — the
 * entry it wanted is on its way out — and only ENOENT was being recognized.
 */
const WINDOWS_TEARDOWN_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Removal that has to succeed rides Node's documented Windows retry. */
const REMOVAL_RETRY = { maxRetries: 10, retryDelay: 20 } as const;

function isWindowsTeardown(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  let current = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const code = (current as NodeJS.ErrnoException).code;
    if (code !== undefined && WINDOWS_TEARDOWN_CODES.has(code)) return true;
    current = current.cause;
  }
  return false;
}

async function withTeardownRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= REMOVAL_RETRY.maxRetries || !isWindowsTeardown(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, REMOVAL_RETRY.retryDelay));
    }
  }
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** Reject redirecting path components below the workspace root. */
export async function assertTaskStorageBoundary(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isContained(resolvedRoot, resolvedTarget)) {
    throw new TaskStorageBoundaryError(target, "task storage path escapes the workspace root");
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new TaskStorageBoundaryError(
          current,
          "task storage crosses a symbolic link or junction",
        );
      }
      if (!(await identitySafeRealpath(current))) {
        throw new TaskStorageBoundaryError(current, "task storage crosses a reparse boundary");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function readTaskText(root: string, file: string): Promise<string> {
  await assertTaskStorageBoundary(root, file);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new TaskStorageBoundaryError(file, "task file is not a regular file");
  }
  const bytes = await readFile(file);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TaskInvalidEncodingError(file, error);
  }
}

export async function removeTaskFile(root: string, file: string): Promise<void> {
  await assertTaskStorageBoundary(root, file);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new TaskStorageBoundaryError(file, "task file is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(file, { force: true });
}

/**
 * Every entry a Task directory holds, in a stable order. Deciding which of
 * them are Tasks, prefixes, or the reserved archive belongs to the tree walk.
 */
export async function listTaskDirectories(root: string, directory: string): Promise<Dirent[]> {
  await assertTaskStorageBoundary(root, directory);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export async function atomicWriteTaskText(
  root: string,
  target: string,
  text: string,
): Promise<void> {
  await assertTaskStorageBoundary(root, target);
  await mkdir(path.dirname(target), { recursive: true });
  await assertTaskStorageBoundary(root, path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await storageProbe?.("after-temp-sync", target);
    await handle.close();
    handle = undefined;
    await storageProbe?.("before-commit", target);
    await assertTaskStorageBoundary(root, target);
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function withTaskLockRaw<T>(
  root: string,
  lockDirectory: string,
  callback: () => Promise<T>,
  probe: TaskLockProbe | undefined,
): Promise<T> {
  await assertTaskStorageBoundary(root, lockDirectory);
  const parent = path.dirname(lockDirectory);
  await mkdir(parent, { recursive: true });
  await assertTaskStorageBoundary(root, parent);
  const deadline = Date.now() + lockWaitMs;
  const token = randomUUID();
  while (true) {
    await assertTaskStorageBoundary(root, parent);
    if (await tryClaimLock(root, lockDirectory, token, probe)) break;
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(lockDirectory);
    } catch (inspectionError) {
      if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (isWindowsTeardown(inspectionError) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw inspectionError;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TaskStorageBoundaryError(lockDirectory, "task lock path is not a real directory");
    }
    try {
      await lstat(path.join(lockDirectory, "owner.json"));
    } catch (ownerError) {
      if (isWindowsTeardown(ownerError) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      if ((ownerError as NodeJS.ErrnoException).code === "ENOENT") {
        const current = await lstatIfPresent(lockDirectory);
        if (current === undefined || !sameDirectoryIdentity(info, current)) continue;
        if (Date.now() - Number(current.mtimeMs) >= STALE_LOCK_AGE_MS) {
          if (!(await observedOwnerlessIsCurrent(lockDirectory, current))) continue;
          await quarantineLock(lockDirectory, `ownerless-${token}`);
          continue;
        }
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        if (!(await observedOwnerlessIsCurrent(lockDirectory, current))) continue;
        throw new TaskLockUnavailableError(
          lockDirectory,
          `ownerless task lock is too new for recovery; explicit repair is required: ${lockDirectory}`,
        );
      }
      throw ownerError;
    }
    await probe?.("after-owner-entry-inspection", lockDirectory, lockDirectory);
    let owner: LockOwner;
    try {
      owner = await readLockOwner(root, lockDirectory);
    } catch (error) {
      const current = await lstatIfPresent(lockDirectory);
      if (current === undefined) continue;
      if (isWindowsTeardown(error) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      if (errorHasCode(error, "ENOENT")) {
        if ((await lstatIfPresent(path.join(lockDirectory, "owner.json"))) !== undefined) {
          continue;
        }
        if (Date.now() - Number(current.mtimeMs) >= STALE_LOCK_AGE_MS) {
          if (!(await observedOwnerlessIsCurrent(lockDirectory, current))) continue;
          await quarantineLock(lockDirectory, `ownerless-read-${token}`);
          continue;
        }
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        if (!(await observedOwnerlessIsCurrent(lockDirectory, current))) continue;
        throw new TaskLockUnavailableError(
          lockDirectory,
          `ownerless task lock is too new for recovery; explicit repair is required: ${lockDirectory}`,
        );
      }
      if (!sameDirectoryIdentity(info, current)) continue;
      throw error;
    }
    const age = Date.now() - Date.parse(owner.created_at);
    const processState = processIsDead(owner.pid);
    if (processState === "unknown") {
      if (!(await observedOwnerIsCurrent(root, lockDirectory, info, owner.token))) continue;
      throw new TaskLockUnavailableError(
        lockDirectory,
        `task lock owner state is unknown; refusing recovery: ${lockDirectory}`,
      );
    }
    if (processState === "dead" && age >= STALE_LOCK_AGE_MS) {
      if (!(await observedOwnerIsCurrent(root, lockDirectory, info, owner.token))) continue;
      await quarantineLock(lockDirectory, `dead-${owner.token}`);
      continue;
    }
    if (Date.now() >= deadline) {
      if (!(await observedOwnerIsCurrent(root, lockDirectory, info, owner.token))) continue;
      throw new TaskLockUnavailableError(
        lockDirectory,
        `task lock is held by pid ${owner.pid}: ${lockDirectory}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  try {
    outcome = { ok: true, value: await callback() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let owner: LockOwner;
  try {
    owner = await withTeardownRetry(() => readLockOwner(root, lockDirectory));
  } catch (releaseError) {
    // A callback that already detected a redirect/identity violation must not
    // have that security finding masked by our intentionally fail-closed
    // refusal to release a lock through the changed path.
    if (!outcome.ok) throw outcome.error;
    throw releaseError;
  }
  if (owner.token !== token) {
    throw new TaskLockUnavailableError(
      lockDirectory,
      `task lock ownership changed; refusing release: ${lockDirectory}`,
    );
  }
  await rm(lockDirectory, { recursive: true, force: true, ...REMOVAL_RETRY });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export async function withTaskLock<T>(
  root: string,
  lockDirectory: string,
  callback: () => Promise<T>,
): Promise<T> {
  return withWorkspaceMutationCoordination(root, async () => {
    await assertActiveEnvelopePath(root, lockDirectory);
    return withTaskLockRaw(root, lockDirectory, callback, lockProbe);
  });
}

/** Test-only access to the task-lock protocol without the workspace owner gate. */
export async function withTaskLockUncoordinatedForTests<T>(
  root: string,
  lockDirectory: string,
  callback: () => Promise<T>,
): Promise<T> {
  return withTaskLockRaw(root, lockDirectory, callback, lockProbe);
}

interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly created_at: string;
}

const STALE_LOCK_AGE_MS = 5 * 60 * 1000;

function errorHasCode(error: unknown, expected: string): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if ((current as NodeJS.ErrnoException).code === expected) return true;
    current = current.cause;
  }
  return false;
}

async function lstatIfPresent(
  target: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (isWindowsTeardown(error)) return undefined;
    throw error;
  }
}

function sameDirectoryIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

async function observedOwnerIsCurrent(
  root: string,
  directory: string,
  observedDirectory: Awaited<ReturnType<typeof lstat>>,
  observedToken: string,
): Promise<boolean> {
  const currentDirectory = await lstatIfPresent(directory);
  if (
    currentDirectory === undefined ||
    !sameDirectoryIdentity(observedDirectory, currentDirectory)
  ) {
    return false;
  }
  try {
    return (await readLockOwner(root, directory)).token === observedToken;
  } catch (error) {
    const afterFailure = await lstatIfPresent(directory);
    if (afterFailure === undefined || !sameDirectoryIdentity(currentDirectory, afterFailure)) {
      return false;
    }
    throw error;
  }
}

async function observedOwnerlessIsCurrent(
  directory: string,
  observedDirectory: Awaited<ReturnType<typeof lstat>>,
): Promise<boolean> {
  const currentDirectory = await lstatIfPresent(directory);
  if (
    currentDirectory === undefined ||
    !sameDirectoryIdentity(observedDirectory, currentDirectory)
  ) {
    return false;
  }
  try {
    await lstat(path.join(directory, "owner.json"));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const afterOwnerCheck = await lstatIfPresent(directory);
  return afterOwnerCheck !== undefined && sameDirectoryIdentity(currentDirectory, afterOwnerCheck);
}

async function tryClaimLock(
  root: string,
  finalDirectory: string,
  token: string,
  probe: TaskLockProbe | undefined,
): Promise<boolean> {
  const temporaryDirectory = `${finalDirectory}.claim-${token}`;
  await assertTaskStorageBoundary(root, temporaryDirectory);
  try {
    await mkdir(temporaryDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path.dirname(temporaryDirectory), { recursive: true });
    return false;
  }
  let claimed = false;
  try {
    await writeLockOwner(root, temporaryDirectory, token);
    await probe?.("after-owner-sync", finalDirectory, temporaryDirectory);
    await assertTaskStorageBoundary(root, path.dirname(finalDirectory));
    try {
      await lstat(finalDirectory);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await probe?.("before-claim", finalDirectory, temporaryDirectory);
    try {
      await rename(temporaryDirectory, finalDirectory);
      claimed = true;
    } catch (error) {
      try {
        await lstat(finalDirectory);
        return false;
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") throw error;
        throw inspectionError;
      }
    }
    const owner = await readLockOwner(root, finalDirectory);
    if (owner.token !== token) {
      throw new TaskLockUnavailableError(
        finalDirectory,
        `prepared task lock claim has the wrong owner: ${finalDirectory}`,
      );
    }
    return true;
  } catch (error) {
    if (claimed) {
      const owner = await readLockOwner(root, finalDirectory).catch(() => undefined);
      if (owner?.token === token) {
        await rm(finalDirectory, { recursive: true, force: true, ...REMOVAL_RETRY }).catch(
          () => undefined,
        );
      }
    }
    throw error;
  } finally {
    if (!claimed) {
      // An orphaned claim is what makes a sibling's coordination rmdir fail.
      await rm(temporaryDirectory, { recursive: true, force: true, ...REMOVAL_RETRY }).catch(
        () => undefined,
      );
    }
  }
}

async function quarantineLock(directory: string, suffix: string): Promise<void> {
  const quarantine = `${directory}.quarantine-${suffix}-${randomUUID()}`;
  try {
    await rename(directory, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true, ...REMOVAL_RETRY });
}

async function writeLockOwner(root: string, directory: string, token: string): Promise<void> {
  const file = path.join(directory, "owner.json");
  await assertTaskStorageBoundary(root, file);
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLockOwner(root: string, directory: string): Promise<LockOwner> {
  const file = path.join(directory, "owner.json");
  let value: unknown;
  try {
    value = JSON.parse(await readTaskText(root, file)) as unknown;
  } catch (error) {
    throw new TaskLockUnavailableError(
      directory,
      `task lock owner metadata is missing or invalid: ${directory}`,
      error,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { token?: unknown }).token !== "string" ||
    !Number.isSafeInteger((value as { pid?: unknown }).pid) ||
    typeof (value as { created_at?: unknown }).created_at !== "string" ||
    !Number.isFinite(Date.parse((value as { created_at: string }).created_at))
  ) {
    throw new TaskLockUnavailableError(
      directory,
      `task lock owner metadata is invalid: ${directory}`,
    );
  }
  return value as LockOwner;
}

function processIsDead(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}
