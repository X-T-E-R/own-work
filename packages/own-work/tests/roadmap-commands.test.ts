import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
} from "./helpers.js";

const tempDirs = createTempDirectoryFixture("assay-roadmap-cli");
let cliRunner: BuiltCliRunner;

beforeEach(async () => {
  cliRunner = createBuiltCliRunner({ registryRoot: await createIsolatedRegistryRoot(tempDirs) });
});

afterEach(async () => tempDirs.cleanup());

async function workspace(): Promise<string> {
  return createInitializedCliWorkspace({
    tempDirs,
    runner: cliRunner,
    directoryName: "roadmap",
    bare: true,
  });
}

describe("assay roadmap CLI", { timeout: 60_000 }, () => {
  it("exposes the native surface and runs create, link, list, terminal, and archive", async () => {
    const root = await workspace();
    const help = await cliRunner.runCli(["roadmap", "--help"]);
    expect(help.exitCode, help.stderr).toBe(0);
    for (const name of [
      "create",
      "show",
      "list",
      "update",
      "link-task",
      "unlink-task",
      "realize",
      "retire",
      "archive",
      "validate",
    ]) {
      expect(help.stdout).toContain(name);
    }

    const created = await cliRunner.runCli([
      "roadmap",
      "create",
      "--title",
      "Ship roadmap",
      "--root",
      root,
      "--json",
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    const roadmap = JSON.parse(created.stdout) as { item: { id: string; revision: number } };
    expect(roadmap.item.id).toBe("roadmap-0001-ship-roadmap");

    const taskCreated = await cliRunner.runCli([
      "task",
      "create",
      "--title",
      "Build",
      "--root",
      root,
      "--json",
    ]);
    expect(taskCreated.exitCode, taskCreated.stderr).toBe(0);
    const task = JSON.parse(taskCreated.stdout) as { task: { id: string } };
    const linked = await cliRunner.runCli([
      "roadmap",
      "link-task",
      roadmap.item.id,
      "--task",
      task.task.id,
      "--expected-revision",
      "0",
      "--root",
      root,
      "--json",
    ]);
    expect(linked.exitCode, linked.stderr).toBe(0);

    const list = await cliRunner.runCli([
      "roadmap",
      "list",
      "--task",
      task.task.id,
      "--root",
      root,
      "--json",
    ]);
    expect(list.exitCode, list.stderr).toBe(0);
    expect((JSON.parse(list.stdout) as { items: unknown[] }).items).toHaveLength(1);

    const realized = await cliRunner.runCli([
      "roadmap",
      "realize",
      roadmap.item.id,
      "--expected-revision",
      "1",
      "--root",
      root,
      "--json",
    ]);
    expect(realized.exitCode, realized.stderr).toBe(0);
    const archived = await cliRunner.runCli([
      "roadmap",
      "archive",
      roadmap.item.id,
      "--root",
      root,
      "--json",
    ]);
    expect(archived.exitCode, archived.stderr).toBe(0);
    expect((JSON.parse(archived.stdout) as { archived: boolean }).archived).toBe(true);
  });

  it("returns partial rows and a nonzero exit when storage has issues", async () => {
    const root = await workspace();
    await cliRunner.runCli(["roadmap", "create", "--title", "Healthy", "--root", root]);
    const linked = await cliRunner.runCli([
      "roadmap",
      "create",
      "--title",
      "Broken link",
      "--root",
      root,
      "--json",
    ]);
    const id = (JSON.parse(linked.stdout) as { item: { id: string } }).item.id;
    const file = `${root}/project/roadmap/${id}/item.yaml`;
    const { readFile, writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "task_refs: []",
        "task_refs:\n  - kind: assay.task\n    id: task-9999-missing",
      ),
      "utf8",
    );
    const result = await cliRunner.runCli(["roadmap", "list", "--root", root, "--json"]);
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stdout) as { items: unknown[]; issues: { code: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.issues.some((issue) => issue.code.startsWith("ROADMAP_"))).toBe(true);
  });

  it("rejects malformed cursor and Task filter ids with stable codes", async () => {
    const root = await workspace();
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const cursor = await cliRunner.runCli(["roadmap", "list", "--cursor", uuid, "--root", root]);
    expect(cursor.exitCode).toBe(1);
    expect(cursor.stderr).toContain("ROADMAP_ID_INVALID");
    const task = await cliRunner.runCli(["roadmap", "list", "--task", uuid, "--root", root]);
    expect(task.exitCode).toBe(1);
    expect(task.stderr).toContain("ROADMAP_TASK_ID_INVALID");
  });
});
