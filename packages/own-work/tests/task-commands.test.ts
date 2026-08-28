import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
} from "./helpers.js";

const tempDirs = createTempDirectoryFixture("assay-task-cli");
let cliRunner: BuiltCliRunner;

const HANDOFF = [
  "# Current State",
  "",
  "state",
  "",
  "## Completed Outcomes",
  "",
  "done",
  "",
  "## Working State",
  "",
  "code",
  "",
  "## Verification Evidence",
  "",
  "checks",
  "",
  "## Next Action",
  "",
  "next",
  "",
  "## Open Blockers and Decisions",
  "",
  "none",
  "",
].join("\n");

beforeEach(async () => {
  cliRunner = createBuiltCliRunner({
    registryRoot: await createIsolatedRegistryRoot(tempDirs),
  });
});

afterEach(async () => {
  await tempDirs.cleanup();
});

async function workspace(name: string): Promise<string> {
  return createInitializedCliWorkspace({
    tempDirs,
    runner: cliRunner,
    directoryName: name,
    bare: true,
  });
}

async function create(
  root: string,
  title: string,
  extra: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const result = await cliRunner.runCli([
    "task",
    "create",
    "--title",
    title,
    ...extra,
    "--root",
    root,
    "--json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function taskId(result: Record<string, unknown>): string {
  return (result.task as { id: string }).id;
}

describe("assay task CLI", { timeout: 60_000 }, () => {
  it("exposes every native command without requiring a plugin and runs a human create/show chain", async () => {
    const help = await cliRunner.runCli(["task", "--help"]);
    expect(help.exitCode, help.stderr).toBe(0);
    for (const command of [
      "create",
      "show",
      "list",
      "status",
      "checkpoint",
      "finish",
      "archive",
      "bind",
      "clear",
      "current",
      "context",
      "relations",
      "validate",
    ]) {
      expect(help.stdout).toContain(command);
    }
    expect(help.stdout).not.toContain("update-resume");

    const root = await workspace("human-chain");
    const created = await cliRunner.runCli([
      "task",
      "create",
      "--title",
      "Native Task",
      "--description",
      "Markdown, not JSON",
      "--creator",
      "Codex",
      "--priority",
      "P1",
      "--root",
      root,
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(created.stdout).toContain("Title: Native Task");
    expect(created.stdout).toContain("Status: active");
    expect(created.stdout).toContain("Revision: 0");
    expect(created.stdout).toContain("# Native Task");
    expect(created.stdout).toContain("Markdown, not JSON");
    const id = created.stdout.match(/Task: (task-\d{4,}(?:-[a-z0-9-]+)?)/)?.[1];
    expect(id).toBeDefined();
    if (id === undefined) throw new Error("created task id not found");

    const shown = await cliRunner.runCli(["task", "show", id, "--root", root]);
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`Path: tasks/${id}`);
    expect(shown.stdout).toContain("Handoff: (none)");
  });

  it("rejects a malformed list cursor with a stable Task code", async () => {
    const root = await workspace("invalid-cursor");
    const result = await cliRunner.runCli([
      "task",
      "list",
      "--cursor",
      "123e4567-e89b-42d3-a456-426614174000",
      "--root",
      root,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("TASK_ID_INVALID");
  });

  it("keeps duplicate titles independent and preserves exact Markdown checkpoint bytes", async () => {
    const root = await workspace("markdown");
    const first = await create(root, "Same title");
    const second = await create(root, "Same title");
    expect(taskId(first)).not.toBe(taskId(second));
    expect((first.task as { name: string }).name).toBe("same-title");
    expect((second.task as { name: string }).name).toBe("same-title");

    const inputDirectory = await tempDirs.createTempDir();
    const handoffFile = path.join(inputDirectory, "handoff.md");
    await writeFile(handoffFile, HANDOFF, "utf8");
    const checkpoint = await cliRunner.runCli([
      "task",
      "checkpoint",
      taskId(first),
      "--from",
      handoffFile,
      "--expected-revision",
      "0",
      "--root",
      root,
      "--json",
    ]);
    expect(checkpoint.exitCode, checkpoint.stderr).toBe(0);
    expect((JSON.parse(checkpoint.stdout) as { handoff: string }).handoff).toBe(HANDOFF);
    expect(await readFile(path.join(root, "tasks", taskId(first), "handoff.md"), "utf8")).toBe(
      HANDOFF,
    );
  });

  it("uses exact context focus, explicit id precedence, and no active-count fallback", async () => {
    const root = await workspace("context");
    const first = await create(root, "First", ["--context", "session:one"]);
    const second = await create(root, "Second");

    const none = await cliRunner.runCli(["task", "current", "--root", root, "--json"]);
    expect(none.exitCode, none.stderr).toBe(0);
    expect(JSON.parse(none.stdout)).toEqual({ root: path.resolve(root), status: "none" });

    const focused = await cliRunner.runCli([
      "task",
      "current",
      "--context",
      "session:one",
      "--root",
      root,
      "--json",
    ]);
    expect(focused.exitCode, focused.stderr).toBe(0);
    expect((JSON.parse(focused.stdout) as { task: { id: string } }).task.id).toBe(taskId(first));

    const explicit = await cliRunner.runCli([
      "task",
      "current",
      "--id",
      taskId(second),
      "--context",
      "session:one",
      "--root",
      root,
      "--json",
    ]);
    expect(explicit.exitCode, explicit.stderr).toBe(0);
    expect((JSON.parse(explicit.stdout) as { task: { id: string } }).task.id).toBe(taskId(second));

    const context = await cliRunner.runCli([
      "task",
      "context",
      "--context",
      "session:one",
      "--root",
      root,
    ]);
    expect(context.exitCode, context.stderr).toBe(0);
    expect(context.stdout).toContain("Context: session:one");
    expect(context.stdout).toContain("Title: First");
    expect(context.stdout).toContain("PRD:");

    const rebound = await cliRunner.runCli([
      "task",
      "bind",
      taskId(second),
      "--context",
      "session:one",
      "--rebind",
      "--root",
      root,
    ]);
    expect(rebound.exitCode, rebound.stderr).toBe(0);
    const cleared = await cliRunner.runCli([
      "task",
      "clear",
      "--context",
      "session:one",
      "--root",
      root,
    ]);
    expect(cleared.exitCode, cleared.stderr).toBe(0);
  });

  it("pauses, resumes, finishes, rejects implicit reopen, and reports revision conflicts", async () => {
    const root = await workspace("lifecycle");
    const created = await create(root, "Lifecycle");
    const id = taskId(created);

    for (const [status, revision] of [
      ["paused", "0"],
      ["active", "1"],
    ] as const) {
      const changed = await cliRunner.runCli([
        "task",
        "status",
        id,
        status,
        "--expected-revision",
        revision,
        "--root",
        root,
        "--json",
      ]);
      expect(changed.exitCode, changed.stderr).toBe(0);
    }

    const stale = await cliRunner.runCli([
      "task",
      "finish",
      id,
      "--expected-revision",
      "1",
      "--root",
      root,
    ]);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain("TASK_REVISION_CONFLICT");

    const finished = await cliRunner.runCli([
      "task",
      "finish",
      id,
      "--expected-revision",
      "2",
      "--root",
      root,
      "--json",
    ]);
    expect(finished.exitCode, finished.stderr).toBe(0);
    expect((JSON.parse(finished.stdout) as { task: { status: string } }).task.status).toBe("done");

    const reopened = await cliRunner.runCli(["task", "status", id, "active", "--root", root]);
    expect(reopened.exitCode).toBe(1);
    expect(reopened.stderr).toContain("TASK_TERMINAL");
  });

  it("archives terminal tasks and provides deterministic paginated archive scopes", async () => {
    const root = await workspace("archive-list");
    const records = await Promise.all([
      create(root, "Alpha"),
      create(root, "Beta"),
      create(root, "Gamma"),
    ]);
    const firstRecord = records[0];
    if (firstRecord === undefined) throw new Error("task fixture failed");
    const archivedId = taskId(firstRecord);
    await cliRunner.runCli(["task", "finish", archivedId, "--root", root]);
    const archived = await cliRunner.runCli(["task", "archive", archivedId, "--root", root]);
    expect(archived.exitCode, archived.stderr).toBe(0);

    const live = await cliRunner.runCli(["task", "list", "--root", root, "--json"]);
    expect(live.exitCode, live.stderr).toBe(0);
    expect((JSON.parse(live.stdout) as { tasks: { id: string }[] }).tasks).toHaveLength(2);

    const onlyArchived = await cliRunner.runCli([
      "task",
      "list",
      "--archived",
      "archived",
      "--root",
      root,
      "--json",
    ]);
    expect(onlyArchived.exitCode, onlyArchived.stderr).toBe(0);
    expect((JSON.parse(onlyArchived.stdout) as { tasks: { id: string }[] }).tasks).toEqual([
      expect.objectContaining({ id: archivedId, archived: true }),
    ]);

    const firstPage = await cliRunner.runCli([
      "task",
      "list",
      "--archived",
      "all",
      "--limit",
      "1",
      "--root",
      root,
      "--json",
    ]);
    const repeat = await cliRunner.runCli([
      "task",
      "list",
      "--archived",
      "all",
      "--limit",
      "1",
      "--root",
      root,
      "--json",
    ]);
    expect(repeat.stdout).toBe(firstPage.stdout);
    const page = JSON.parse(firstPage.stdout) as { next_cursor: string; tasks: { id: string }[] };
    const next = await cliRunner.runCli([
      "task",
      "list",
      "--archived",
      "all",
      "--limit",
      "1",
      "--cursor",
      page.next_cursor,
      "--root",
      root,
      "--json",
    ]);
    expect(next.exitCode, next.stderr).toBe(0);
    const firstPageTask = page.tasks[0];
    const nextPageTask = (JSON.parse(next.stdout) as { tasks: { id: string }[] }).tasks[0];
    if (firstPageTask === undefined || nextPageTask === undefined) {
      throw new Error("pagination fixture failed");
    }
    expect(nextPageTask.id).not.toBe(firstPageTask.id);
  });

  it("lists valid siblings while surfacing machine-readable storage conflicts", async () => {
    const root = await workspace("list-partial-health");
    const duplicate = await create(root, "Duplicate");
    const sibling = await create(root, "Valid sibling");
    const duplicateId = taskId(duplicate);
    const archive = path.join(root, "tasks", "archive", duplicateId);
    await mkdir(path.dirname(archive), { recursive: true });
    await cp(path.join(root, "tasks", duplicateId), archive, { recursive: true });

    const json = await cliRunner.runCli([
      "task",
      "list",
      "--archived",
      "all",
      "--root",
      root,
      "--json",
    ]);
    expect(json.exitCode).toBe(1);
    const payload = JSON.parse(json.stdout) as {
      tasks: { id: string }[];
      issues: { id: string; archived: boolean; issues: { code: string }[] }[];
    };
    expect(payload.tasks).toEqual([expect.objectContaining({ id: taskId(sibling) })]);
    expect(payload.issues.filter((issue) => issue.id === duplicateId)).toHaveLength(2);
    expect(
      payload.issues.every((entry) => entry.issues.some((issue) => issue.code === "TASK_CONFLICT")),
    ).toBe(true);

    const human = await cliRunner.runCli(["task", "list", "--archived", "all", "--root", root]);
    expect(human.exitCode).toBe(1);
    expect(human.stdout).toContain(taskId(sibling));
    expect(human.stdout).toContain("Task storage issues:");
    expect(human.stdout).toContain(duplicateId);
    expect(human.stdout).toContain("TASK_CONFLICT");
  });

  it("parses repeated relations, requires explicit clear, and preserves cycle errors", async () => {
    const root = await workspace("relations");
    const first = await create(root, "First");
    const second = await create(root, "Second");
    const third = await create(root, "Third", [
      "--relation",
      `continues:${taskId(first)}`,
      "--relation",
      `contributes_to:${taskId(second)}`,
    ]);
    expect((third.relations as unknown[]).length).toBe(2);

    const missingMode = await cliRunner.runCli([
      "task",
      "relations",
      taskId(first),
      "--root",
      root,
    ]);
    expect(missingMode.exitCode).toBe(1);
    expect(missingMode.stderr).toContain("TASK_RELATION_INVALID");

    const cycle = await cliRunner.runCli([
      "task",
      "relations",
      taskId(first),
      "--relation",
      `continues:${taskId(third)}`,
      "--root",
      root,
    ]);
    expect(cycle.exitCode).toBe(1);
    expect(cycle.stderr).toContain("TASK_RELATION_CYCLE");

    const cleared = await cliRunner.runCli([
      "task",
      "relations",
      taskId(third),
      "--clear",
      "--expected-revision",
      "0",
      "--root",
      root,
      "--json",
    ]);
    expect(cleared.exitCode, cleared.stderr).toBe(0);
    expect((JSON.parse(cleared.stdout) as { relations: unknown[] }).relations).toEqual([]);
  });

  it("fails closed on bad UTF-8, missing options, bind conflicts, and invalid persisted data", async () => {
    const root = await workspace("invalid");
    const first = await create(root, "First", ["--context", "occupied"]);

    const partial = await cliRunner.runCli([
      "task",
      "create",
      "--title",
      "Still Created",
      "--context",
      "occupied",
      "--root",
      root,
    ]);
    expect(partial.exitCode).toBe(1);
    expect(partial.stderr).toContain("TASK_CONTEXT_CONFLICT");
    expect(partial.stderr).toContain("was created but not bound");

    const missingTitle = await cliRunner.runCli(["task", "create", "--root", root]);
    expect(missingTitle.exitCode).toBe(1);
    expect(missingTitle.stderr).toContain("required option '--title <text>' not specified");

    const inputDirectory = await tempDirs.createTempDir();
    const invalidUtf8 = path.join(inputDirectory, "invalid.md");
    await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
    const badMarkdown = await cliRunner.runCli([
      "task",
      "checkpoint",
      taskId(first),
      "--from",
      invalidUtf8,
      "--root",
      root,
    ]);
    expect(badMarkdown.exitCode).toBe(1);
    expect(badMarkdown.stderr).toContain("TASK_INVALID");
    expect(badMarkdown.stderr).toContain("not valid UTF-8");

    const taskFile = path.join(root, "tasks", taskId(first), "task.json");
    const corrupt = "{broken\n";
    await writeFile(taskFile, corrupt, "utf8");
    const validation = await cliRunner.runCli(["task", "validate", "--root", root, "--json"]);
    expect(validation.exitCode).toBe(1);
    expect((JSON.parse(validation.stdout) as { valid: boolean }).valid).toBe(false);
    expect(await readFile(taskFile, "utf8")).toBe(corrupt);
  });
});
