import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { identitySafePathNamesOpenFile, identitySafeRealpath } from "../src/filesystem-boundary.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("identity-safe filesystem boundaries", () => {
  it("accepts an ordinary path and rejects a symlink or junction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ownwork-identity-boundary-"));
    roots.push(root);
    const target = path.join(root, "target");
    const redirect = path.join(root, "redirect");
    await mkdir(target);
    await symlink(target, redirect, process.platform === "win32" ? "junction" : "dir");

    await expect(identitySafeRealpath(target)).resolves.toEqual(
      expect.objectContaining({ resolved: path.resolve(target), canonical: expect.any(String) }),
    );
    await expect(identitySafeRealpath(redirect)).resolves.toBeNull();
  });

  it("binds an open authority file to its current name and rejects replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ownwork-open-identity-"));
    roots.push(root);
    const target = path.join(root, "authority.json");
    const displaced = path.join(root, "authority.old.json");
    await writeFile(target, "old\n", "utf8");

    const safePath = await identitySafeRealpath(target);
    expect(safePath).not.toBeNull();
    if (!safePath) throw new Error("ordinary authority path was rejected");
    const handle = await open(target, "r");
    try {
      await expect(identitySafePathNamesOpenFile(target, handle, safePath)).resolves.toBe(true);
      await rename(target, displaced);
      await writeFile(target, "new\n", "utf8");
      await expect(identitySafePathNamesOpenFile(target, handle, safePath)).resolves.toBe(false);
    } finally {
      await handle.close();
    }
  });
});
