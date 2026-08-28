/**
 * Walk the Task tree without deciding what the records mean.
 *
 * `tasks/` is a navigation surface: any subdirectory a reader invents is a
 * legal prefix, and `tasks/research/deep/task-0007-x/` is the same Task as
 * `tasks/task-0007-x/`. Prefixes carry no schema and never appear in
 * `task.json`, so this walker exists to turn a nested tree back into the flat
 * set of stable ids the rest of Task already speaks. `tasks/archive/` is the
 * one reserved name, and it stays flat.
 */

import type { Dirent } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { isReadableId } from "absorb-anything-core";
import { listTaskDirectories } from "./task-storage.js";

/** Deep enough for any organizing scheme; shallow enough to bound a scan. */
export const MAX_TASK_PREFIX_DEPTH = 8;

export const TASK_ARCHIVE_DIRECTORY = "archive";

/** A directory in the Task tree that claims to be one Task. */
export interface TaskTreeEntry {
  readonly name: string;
  /** Posix-joined navigation prefix; empty at the flat root. */
  readonly prefix: string;
  readonly directory: string;
  readonly archived: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/** Something in the tree that is neither a Task nor a usable prefix. */
export interface TaskTreeFinding {
  readonly name: string;
  readonly directory: string;
  readonly archived: boolean;
  readonly message: string;
}

export interface TaskTree {
  readonly entries: readonly TaskTreeEntry[];
  readonly findings: readonly TaskTreeFinding[];
}

function joinPrefix(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}/${name}`;
}

async function holdsTaskEnvelope(directory: string): Promise<boolean> {
  try {
    return (await lstat(path.join(directory, "task.json"))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // An unreadable candidate is still a candidate; let the envelope read
    // produce the finding rather than hiding the directory in the prefix tree.
    return true;
  }
}

/**
 * A directory is a Task when its name is a stable Task id, or when it holds a
 * `task.json` under some other name. The second rule is what keeps a
 * hand-renamed Task visible as a storage finding instead of silently becoming
 * an empty prefix.
 */
async function isTaskCandidate(directory: string, name: string): Promise<boolean> {
  return isReadableId("task", name) || (await holdsTaskEnvelope(directory));
}

function nonDirectoryFinding(
  entry: Dirent,
  directory: string,
  archived: boolean,
): TaskTreeFinding | undefined {
  if (entry.isSymbolicLink()) {
    return {
      name: entry.name,
      directory,
      archived,
      message: "task storage must not cross a symbolic link, junction, or reparse point",
    };
  }
  return undefined;
}

async function walkLive(
  root: string,
  directory: string,
  prefix: string,
  depth: number,
  entries: TaskTreeEntry[],
  findings: TaskTreeFinding[],
): Promise<void> {
  for (const dirent of await listTaskDirectories(root, directory)) {
    // Skip in-flight create and atomic-write temporaries.
    if (dirent.name.startsWith(".")) continue;
    // `archive` is reserved only where the archive actually lives. Further
    // down it is an ordinary word a reader may want for a prefix.
    if (depth === 0 && dirent.name === TASK_ARCHIVE_DIRECTORY) continue;
    const child = path.join(directory, dirent.name);
    const symlinkFinding = nonDirectoryFinding(dirent, child, false);
    if (symlinkFinding) {
      findings.push(symlinkFinding);
      continue;
    }
    if (!dirent.isDirectory()) {
      // A Task id that is a file is a broken Task; anything else beside the
      // Tasks is a reader's own note and not Task's business.
      if (isReadableId("task", dirent.name)) {
        entries.push({
          name: dirent.name,
          prefix,
          directory: child,
          archived: false,
          isDirectory: false,
          isSymbolicLink: false,
        });
      }
      continue;
    }
    if (await isTaskCandidate(child, dirent.name)) {
      entries.push({
        name: dirent.name,
        prefix,
        directory: child,
        archived: false,
        isDirectory: true,
        isSymbolicLink: false,
      });
      continue;
    }
    if (depth >= MAX_TASK_PREFIX_DEPTH) {
      findings.push({
        name: dirent.name,
        directory: child,
        archived: false,
        message: `task prefix nesting is deeper than ${MAX_TASK_PREFIX_DEPTH} levels; prefixes are for navigation, so flatten this tree`,
      });
      continue;
    }
    await walkLive(root, child, joinPrefix(prefix, dirent.name), depth + 1, entries, findings);
  }
}

async function walkArchive(
  root: string,
  directory: string,
  entries: TaskTreeEntry[],
  findings: TaskTreeFinding[],
): Promise<void> {
  for (const dirent of await listTaskDirectories(root, directory)) {
    if (dirent.name.startsWith(".")) continue;
    const child = path.join(directory, dirent.name);
    const symlinkFinding = nonDirectoryFinding(dirent, child, true);
    if (symlinkFinding) {
      findings.push(symlinkFinding);
      continue;
    }
    if (!dirent.isDirectory()) {
      if (isReadableId("task", dirent.name)) {
        entries.push({
          name: dirent.name,
          prefix: TASK_ARCHIVE_DIRECTORY,
          directory: child,
          archived: true,
          isDirectory: false,
          isSymbolicLink: false,
        });
      }
      continue;
    }
    if (await isTaskCandidate(child, dirent.name)) {
      entries.push({
        name: dirent.name,
        prefix: TASK_ARCHIVE_DIRECTORY,
        directory: child,
        archived: true,
        isDirectory: true,
        isSymbolicLink: false,
      });
      continue;
    }
    findings.push({
      name: dirent.name,
      directory: child,
      archived: true,
      message:
        "tasks/archive/ is reserved for archived Tasks and stays flat, so it takes no navigation prefix; move this directory under a live prefix instead",
    });
  }
}

/**
 * Read every Task directory the tree holds, live and archived, plus whatever
 * the tree contains that cannot be either.
 */
export async function readTaskTree(options: {
  readonly root: string;
  readonly liveDirectory: string;
  readonly archiveDirectory: string;
  readonly includeArchived?: boolean;
}): Promise<TaskTree> {
  const entries: TaskTreeEntry[] = [];
  const findings: TaskTreeFinding[] = [];
  await walkLive(options.root, options.liveDirectory, "", 0, entries, findings);
  if (options.includeArchived !== false) {
    await walkArchive(options.root, options.archiveDirectory, entries, findings);
  }
  return { entries, findings };
}

/** Every place the tree holds this exact stable id. */
export function taskTreeLocations(tree: TaskTree, id: string): readonly TaskTreeEntry[] {
  return tree.entries.filter((entry) => entry.name === id);
}
