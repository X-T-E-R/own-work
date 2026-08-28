import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  addSource,
  migrateEnvelope,
  withWorkspaceMutationCoordination as withCoreMutation,
} from "absorb-anything-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  migrateOwnWorkEnvelope,
  setEnvelopeMigrationProbeForTests,
  setWorkspaceMutationProbeForTests,
} from "../src/coordination.js";
import { initOwnWork } from "../src/lifecycle.js";
import { registerSystem } from "../src/systems-registry.js";
import { createTask } from "../src/task.js";
import { createTempDirectoryFixture, pathExists } from "./helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(settled).toBe(false);
}

async function ledger(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        result[path.relative(directory, absolute).replaceAll("\\", "/")] = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
      }
    }
  };
  await visit(directory);
  return result;
}

const fixture = createTempDirectoryFixture("ownwork-shared-coordination");

afterEach(async () => {
  setWorkspaceMutationProbeForTests(undefined);
  setEnvelopeMigrationProbeForTests(undefined);
  await fixture.cleanup();
});

async function workspace(legacy = false): Promise<string> {
  const root = await fixture.createTempDir();
  await initOwnWork({ target: root, name: "Coordination", agents: false });
  if (legacy) await rename(path.join(root, ".absorb"), path.join(root, ".assay"));
  return root;
}

async function sourceInput(root: string, name: string): Promise<string> {
  const input = path.join(root, `${name}-input`);
  await mkdir(input);
  await writeFile(path.join(input, "note.txt"), `${name}\n`, "utf8");
  return input;
}

describe("shared cross-product coordination", { timeout: 120_000 }, () => {
  it("keeps core mutation pending while a Task writer owns the shared gate", async () => {
    const root = await workspace();
    const acquired = deferred();
    const release = deferred();
    setWorkspaceMutationProbeForTests(async (stage) => {
      if (stage === "after-acquire") {
        acquired.resolve();
        await release.promise;
      }
    });

    const task = createTask({ root, title: "Held task" });
    await acquired.promise;
    const input = await sourceInput(root, "core-after-task");
    const source = addSource({ root, source: input, alias: "core-after-task" });
    await expectPending(source);

    release.resolve();
    await task;
    await source;
    expect(await pathExists(path.join(root, ".absorb", "sources", "core-after-task"))).toBe(true);
    expect(await pathExists(path.join(root, ".assay"))).toBe(false);
  });

  it("keeps core mutation pending while a System writer owns the shared gate", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "systems", "api"), { recursive: true });
    const acquired = deferred();
    const release = deferred();
    setWorkspaceMutationProbeForTests(async (stage) => {
      if (stage === "after-acquire") {
        acquired.resolve();
        await release.promise;
      }
    });

    const system = registerSystem(root, { path: "systems/api", name: "api" });
    await acquired.promise;
    const input = await sourceInput(root, "core-after-system");
    const source = addSource({ root, source: input, alias: "core-after-system" });
    await expectPending(source);

    release.resolve();
    await system;
    await source;
    expect(await pathExists(path.join(root, ".absorb", "sources", "core-after-system"))).toBe(true);
    expect(await pathExists(path.join(root, ".absorb", "coordination"))).toBe(false);
  });

  it("keeps Task and System writers pending while core owns workspace mutation", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "systems", "worker"), { recursive: true });
    const acquired = deferred();
    const release = deferred();
    const core = withCoreMutation(root, async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;

    const task = createTask({ root, title: "After core" });
    const system = registerSystem(root, { path: "systems/worker", name: "worker" });
    await expectPending(task);
    await expectPending(system);
    release.resolve();
    await core;
    await task;
    await system;

    const input = await sourceInput(root, "core-still-valid");
    await addSource({ root, source: input, alias: "core-still-valid" });
    expect(await pathExists(path.join(root, ".absorb", "sources", "core-still-valid"))).toBe(true);
    expect(await pathExists(path.join(root, ".assay"))).toBe(false);
  });

  it("makes migration wait for a held Task writer and leaves one envelope", async () => {
    const root = await workspace(true);
    const acquired = deferred();
    const release = deferred();
    setWorkspaceMutationProbeForTests(async (stage) => {
      if (stage === "after-acquire") {
        acquired.resolve();
        await release.promise;
      }
    });

    const task = createTask({ root, title: "Before migration" });
    await acquired.promise;
    const migration = migrateEnvelope(root);
    await expectPending(migration);
    expect(await pathExists(path.join(root, ".assay"))).toBe(true);
    expect(await pathExists(path.join(root, ".absorb"))).toBe(false);

    release.resolve();
    const created = await task;
    expect((await migration).changed).toBe(true);
    expect(await pathExists(path.join(root, ".assay"))).toBe(false);
    expect(await pathExists(path.join(root, ".absorb", "tasks", created.task.id))).toBe(true);
  });

  it("makes migration wait for a held System writer and leaves one envelope", async () => {
    const root = await workspace(true);
    await mkdir(path.join(root, "systems", "held"), { recursive: true });
    const acquired = deferred();
    const release = deferred();
    setWorkspaceMutationProbeForTests(async (stage) => {
      if (stage === "after-acquire") {
        acquired.resolve();
        await release.promise;
      }
    });

    const system = registerSystem(root, { path: "systems/held", name: "held" });
    await acquired.promise;
    const migration = migrateEnvelope(root);
    await expectPending(migration);
    release.resolve();
    await system;
    expect((await migration).changed).toBe(true);
    expect(await pathExists(path.join(root, ".assay"))).toBe(false);
    expect(await pathExists(path.join(root, ".absorb", "systems-registry.json"))).toBe(true);
  });

  it("makes ownwork migration wait for a held core mutation and preserves its bytes", async () => {
    const root = await workspace(true);
    const acquired = deferred();
    const release = deferred();
    const heldFile = path.join(root, ".assay", "knowledge", "core-held.txt");
    const core = withCoreMutation(root, async () => {
      await writeFile(heldFile, "core held bytes\n", "utf8");
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    const before = createHash("sha256")
      .update(await readFile(heldFile))
      .digest("hex");
    const migration = migrateOwnWorkEnvelope(root);
    await expectPending(migration);
    release.resolve();
    await core;
    expect((await migration).changed).toBe(true);
    expect(await pathExists(path.join(root, ".assay"))).toBe(false);
    const migrated = path.join(root, ".absorb", "knowledge", "core-held.txt");
    expect(
      createHash("sha256")
        .update(await readFile(migrated))
        .digest("hex"),
    ).toBe(before);
  });

  it("holds core, Task, and System writers behind migration without recreating .assay", async () => {
    const root = await workspace(true);
    await mkdir(path.join(root, "systems", "after"), { recursive: true });
    const input = await sourceInput(root, "core-after-migration");
    const tasksBefore = await ledger(path.join(root, ".assay", "tasks"));
    const acquired = deferred();
    const release = deferred();
    setEnvelopeMigrationProbeForTests(async () => {
      acquired.resolve();
      await release.promise;
    });

    const migration = migrateOwnWorkEnvelope(root);
    await acquired.promise;
    const source = addSource({ root, source: input, alias: "core-after-migration" });
    const task = createTask({ root, title: "Raced task" });
    const system = registerSystem(root, { path: "systems/after", name: "after" });
    await expectPending(source);
    await expectPending(task);
    await expectPending(system);
    release.resolve();

    expect((await migration).changed).toBe(true);
    await source;
    await expect(task).rejects.toThrow();
    await system;
    expect(await pathExists(path.join(root, ".assay"))).toBe(false);
    expect(await ledger(path.join(root, ".absorb", "tasks"))).toEqual(tasksBefore);
    expect(await pathExists(path.join(root, ".absorb", "sources", "core-after-migration"))).toBe(
      true,
    );
    expect(await pathExists(path.join(root, ".absorb", "systems-registry.json"))).toBe(true);
  });
});
