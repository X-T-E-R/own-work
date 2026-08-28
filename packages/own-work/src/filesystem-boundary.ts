import type { FileHandle } from "node:fs/promises";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export interface IdentitySafePath {
  readonly resolved: string;
  readonly canonical: string;
  readonly windowsShortPathAlias: boolean;
}

function sameOpenFileIdentity(
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function sameFilesystemIdentity(left: string, right: string): Promise<boolean> {
  const [leftInfo, rightInfo] = await Promise.all([
    lstat(left, { bigint: true }),
    lstat(right, { bigint: true }),
  ]);
  return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
}

function hasDosShortNameComponent(value: string): boolean {
  const root = path.parse(value).root;
  return path
    .relative(root, value)
    .split(path.sep)
    .some((segment) => /~[0-9]+(?:\.|$)/i.test(segment));
}

async function hasOnlyOrdinaryIdentityEquivalentComponents(target: string): Promise<boolean> {
  const root = path.parse(target).root;
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) return false;
    const canonical = await realpath(cursor);
    if (!(await sameFilesystemIdentity(cursor, canonical))) return false;
  }
  return true;
}

/**
 * Resolve an existing path without confusing a Windows DOS 8.3 spelling with
 * a redirect. A lexical/canonical mismatch is accepted only on Windows, only
 * when the spelling contains a short-name component on the same volume, and
 * only after every traversed component and the final entry prove ordinary
 * identity equivalence. Symlinks, junctions, other reparse redirects, and
 * cross-volume aliases remain rejected.
 */
export async function identitySafeRealpath(target: string): Promise<IdentitySafePath | null> {
  const resolved = path.resolve(target);
  const named = await lstat(resolved);
  if (named.isSymbolicLink()) return null;

  const canonical = path.normalize(await realpath(resolved));
  if (!(await sameFilesystemIdentity(resolved, canonical))) return null;
  if (pathKey(resolved) === pathKey(canonical)) {
    return { resolved, canonical, windowsShortPathAlias: false };
  }

  if (
    process.platform !== "win32" ||
    path.parse(resolved).root.toLowerCase() !== path.parse(canonical).root.toLowerCase() ||
    !hasDosShortNameComponent(resolved) ||
    !(await hasOnlyOrdinaryIdentityEquivalentComponents(resolved))
  ) {
    return null;
  }

  return { resolved, canonical, windowsShortPathAlias: true };
}

/**
 * Prove that an already-open file is still the ordinary file named by target.
 *
 * Windows can report different path-stat and handle-stat identities when a
 * path contains a DOS 8.3 alias. Compare two open handles instead, while the
 * identity-safe path checks on both sides preserve redirect rejection. This
 * also keeps replacement detection: a name rebound after the caller opened
 * its handle produces a different verifier handle identity.
 */
export async function identitySafePathNamesOpenFile(
  target: string,
  handle: FileHandle,
  expectedPath?: IdentitySafePath,
): Promise<boolean> {
  const before = await identitySafeRealpath(target);
  if (!before) return false;
  if (expectedPath && pathKey(before.canonical) !== pathKey(expectedPath.canonical)) return false;

  const verifier = await open(target, "r");
  try {
    const [openedInfo, verifierInfo] = await Promise.all([handle.stat(), verifier.stat()]);
    if (
      !openedInfo.isFile() ||
      !verifierInfo.isFile() ||
      !sameOpenFileIdentity(openedInfo, verifierInfo)
    ) {
      return false;
    }
  } finally {
    await verifier.close();
  }

  const after = await identitySafeRealpath(target);
  return Boolean(after && pathKey(after.canonical) === pathKey(before.canonical));
}
