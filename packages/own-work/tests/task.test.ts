import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { fixturePath, writeBareTemplate } from "./helpers.js";

import {
  archiveTask,
  bindTask,
  checkOwnWork as checkFramework,
  checkpointTask,
  clearTaskContext,
  contextTask,
  createTask,
  currentTask,
  finishTask,
  initOwnWork as initFramework,
  listTasks,
  setTaskArchiveProbeForTests,
  setTaskRelations,
  setTaskTransactionProbeForTests,
  showTask,
  updateTaskStatus,
  validateTasks,
} from "../src/index.js";
import { TASK_ENVELOPE_KEYS } from "../src/tasks/task-record.js";
import {
  TaskLockUnavailableError,
  setTaskLockProbeForTests,
  setTaskLockWaitForTests,
  setTaskStorageProbeForTests,
  withTaskLock,
  withTaskLockUncoordinatedForTests,
} from "../src/tasks/task-storage.js";

const roots: string[] = [];
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

async function workspace(
  name: string,
  _mode: "standalone" | "overlay" = "standalone",
): Promise<string> {
  const root = fixturePath("own-work-task");
  roots.push(root);
  const template = await writeBareTemplate(root);
  await initFramework({ target: root, name, template, standalone: true });
  return root;
}
function taskFile(root: string, id: string, overlay = false): string {
  return path.join(root, ...(overlay ? [".absorb", "tasks"] : ["tasks"]), id, "task.json");
}

async function rewriteTask(
  root: string,
  id: string,
  mutate: (record: Record<string, unknown>) => void,
): Promise<void> {
  const file = taskFile(root, id);
  const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  mutate(record);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  setTaskStorageProbeForTests(undefined);
  setTaskLockProbeForTests(undefined);
  setTaskLockWaitForTests(undefined);
  setTaskTransactionProbeForTests(undefined);
  setTaskArchiveProbeForTests(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Task creation and Markdown contract", () => {
  it("creates a complete compatibility envelope and required PRD in standalone mode", async () => {
    const root = await workspace("Create-standalone");
    const created = await createTask({
      root,
      title: "Ship Native Task",
      description: "Verify native behavior",
    });
    expect(created.task.id).toBe("task-0001-ship-native-task");
    expect(created.task.status).toBe("active");
    expect(created.path).toBe(`tasks/${created.task.id}`);
    expect(created.prd).toBe(
      "# Ship Native Task\n\n## Goal\n\nVerify native behavior\n\n## Acceptance Criteria\n\n- [ ] The intended outcome is complete and backed by recorded verification evidence.\n",
    );
    const raw = JSON.parse(await readFile(taskFile(root, created.task.id), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(raw).slice(0, 24)).toEqual(TASK_ENVELOPE_KEYS);
    expect(Object.keys(raw).slice(0, 24)).toHaveLength(24);
    expect((raw.meta as Record<string, unknown>).assay).toMatchObject({
      record_version: "0.1",
      revision: 0,
      relations: [],
    });
  });

  it("allows duplicate titles while generating independent durable ids", async () => {
    const root = await workspace("DuplicateTitle");
    const first = await createTask({ root, title: "Same title" });
    const second = await createTask({ root, title: "Same title" });
    expect(first.task.id).not.toBe(second.task.id);
    expect(first.task.name).toBe("same-title");
    expect(second.task.name).toBe("same-title");
  });

  it("allocates under one create lock across concurrency and archived history", async () => {
    const root = await workspace("Concurrent readable ids");
    const [left, right] = await Promise.all([
      createTask({ root, title: "并发" }),
      createTask({ root, title: "并发" }),
    ]);
    expect(new Set([left.task.id, right.task.id])).toEqual(new Set(["task-0001", "task-0002"]));
    await archiveTask({ root, id: (await finishTask({ root, id: left.task.id })).task.id });
    expect((await createTask({ root, title: "Next" })).task.id).toBe("task-0003-next");
  });

  it("serializes highest-sequence archive with allocation", async () => {
    const root = await workspace("Archive allocator lock");
    const highest = await finishTask({
      root,
      id: (await createTask({ root, title: "Old slug" })).task.id,
    });
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    setTaskArchiveProbeForTests(async () => {
      enteredResolve?.();
      await release;
    });
    const archiving = archiveTask({ root, id: highest.task.id });
    await entered;
    let createdSettled = false;
    const creating = createTask({ root, title: "New slug" }).finally(() => {
      createdSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(createdSettled).toBe(false);
    releaseResolve?.();
    await archiving;
    expect((await creating).task.id).toBe("task-0002-new-slug");
  });

  it("rejects UUID-shaped ids across native lookup, context, relation, and archive APIs", async () => {
    const root = await workspace("Readable only");
    const task = await createTask({ root, title: "Readable" });
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    await expect(showTask({ root, id: uuid })).rejects.toMatchObject({ code: "TASK_ID_INVALID" });
    await expect(bindTask({ root, contextKey: "uuid", id: uuid })).rejects.toMatchObject({
      code: "TASK_ID_INVALID",
    });
    await expect(archiveTask({ root, id: uuid })).rejects.toMatchObject({
      code: "TASK_ID_INVALID",
    });
    await expect(listTasks({ root, cursor: uuid })).rejects.toMatchObject({
      code: "TASK_ID_INVALID",
    });
    await expect(
      setTaskRelations({
        root,
        id: task.task.id,
        relations: [{ type: "continues", task_id: uuid }],
      }),
    ).rejects.toMatchObject({ code: "TASK_ID_INVALID" });
  });

  it("writes handoff only at a valid explicit checkpoint", async () => {
    const root = await workspace("Checkpoint");
    const task = await createTask({ root, title: "Checkpoint" });
    expect(task.handoff).toBeUndefined();
    await expect(
      checkpointTask({ root, id: task.task.id, handoff: "# Current State\n" }),
    ).rejects.toMatchObject({ code: "TASK_INVALID" });
    expect(
      await lstat(path.join(root, "tasks", task.task.id, "handoff.md")).catch(() => null),
    ).toBeNull();
    const checkpoint = await checkpointTask({
      root,
      id: task.task.id,
      handoff: HANDOFF,
    });
    expect(checkpoint.handoff).toBe(HANDOFF);
    expect(checkpoint.revision).toBe(1);
  });

  it("rolls back a committed handoff when task replacement fails", async () => {
    const root = await workspace("CheckpointRollback");
    const created = await createTask({ root, title: "Checkpoint rollback" });
    const initial = await checkpointTask({ root, id: created.task.id, handoff: HANDOFF });
    const replacement = HANDOFF.replace("state", "replacement state");
    let handoffCommitted = false;
    setTaskStorageProbeForTests((phase, target) => {
      if (phase !== "before-commit") return;
      if (target.endsWith("handoff.md")) handoffCommitted = true;
      if (handoffCommitted && target.endsWith("task.json")) {
        throw new Error("fail task replacement after handoff commit");
      }
    });
    await expect(
      checkpointTask({
        root,
        id: created.task.id,
        handoff: replacement,
        expectedRevision: initial.revision,
      }),
    ).rejects.toMatchObject({ code: "TASK_IO_ERROR" });
    setTaskStorageProbeForTests(undefined);
    const recovered = await showTask({ root, id: created.task.id });
    expect(recovered.handoff).toBe(HANDOFF);
    expect(recovered.revision).toBe(initial.revision);
    expect(
      await lstat(path.join(root, "tasks", created.task.id, ".assay-checkpoint.json")).catch(
        () => null,
      ),
    ).toBeNull();
    expect(
      (
        await checkpointTask({
          root,
          id: created.task.id,
          handoff: replacement,
          expectedRevision: initial.revision,
        })
      ).revision,
    ).toBe(initial.revision + 1);
  });

  it("recovers a crash-left checkpoint on exact current without scanning bad history", async () => {
    const root = await workspace("CheckpointCrashRecovery");
    const created = await createTask({ root, title: "Checkpoint crash" });
    const initial = await checkpointTask({ root, id: created.task.id, handoff: HANDOFF });
    await bindTask({ root, contextKey: "session:checkpoint", id: created.task.id });
    await mkdir(path.join(root, "tasks", "invalid-native-id"));
    setTaskTransactionProbeForTests((stage) => (stage === "after-handoff" ? "crash" : undefined));
    await expect(
      checkpointTask({
        root,
        id: created.task.id,
        handoff: HANDOFF.replace("state", "crash state"),
        expectedRevision: initial.revision,
      }),
    ).rejects.toMatchObject({ code: "TASK_IO_ERROR" });
    setTaskTransactionProbeForTests(undefined);
    expect(
      await lstat(path.join(root, "tasks", created.task.id, ".assay-checkpoint.json")),
    ).toBeDefined();
    const current = await currentTask({ root, contextKey: "session:checkpoint" });
    expect(current.status).toBe("current");
    if (current.status !== "current") throw new Error("expected current task");
    expect(current.handoff).toBe(HANDOFF);
    expect(current.revision).toBe(initial.revision);
    expect(
      await lstat(path.join(root, "tasks", created.task.id, ".assay-checkpoint.json")).catch(
        () => null,
      ),
    ).toBeNull();
  });

  it("finishes recovery to the new checkpoint when the revision commit reached disk", async () => {
    const root = await workspace("CheckpointForwardRecovery");
    const created = await createTask({ root, title: "Checkpoint forward" });
    setTaskTransactionProbeForTests((stage) => (stage === "after-task" ? "crash" : undefined));
    await expect(
      checkpointTask({
        root,
        id: created.task.id,
        handoff: HANDOFF,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "TASK_IO_ERROR" });
    setTaskTransactionProbeForTests(undefined);
    const recovered = await showTask({ root, id: created.task.id });
    expect(recovered.handoff).toBe(HANDOFF);
    expect(recovered.revision).toBe(1);
    expect(
      await lstat(path.join(root, "tasks", created.task.id, ".assay-checkpoint.json")).catch(
        () => null,
      ),
    ).toBeNull();
  });

  it("rejects a redirecting checkpoint transaction path", async () => {
    const root = await workspace("CheckpointBoundary");
    const created = await createTask({ root, title: "Checkpoint boundary" });
    const outside = `${fixturePath("assay-task-transaction")}.json`;
    roots.push(outside);
    await writeFile(outside, "outside\n", "utf8");
    try {
      await symlink(
        outside,
        path.join(root, "tasks", created.task.id, ".assay-checkpoint.json"),
        "file",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(showTask({ root, id: created.task.id })).rejects.toMatchObject({
      code: "TASK_STORAGE_BOUNDARY",
    });
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });
});

describe("native Task lifecycle and selection", () => {
  it("reads aliases, resumes paused tasks, and never implicitly reopens terminal tasks", async () => {
    const root = await workspace("Statuses");
    const created = await createTask({ root, title: "Statuses" });
    await rewriteTask(root, created.task.id, (record) => {
      record.status = "planning";
    });
    expect((await showTask({ root, id: created.task.id })).task.status).toBe("active");
    expect(
      (await updateTaskStatus({ root, id: created.task.id, status: "paused" })).task.status,
    ).toBe("paused");
    expect(
      (await updateTaskStatus({ root, id: created.task.id, status: "open" })).task.status,
    ).toBe("active");
    const done = await finishTask({ root, id: created.task.id });
    expect(done.task.status).toBe("done");
    await expect(
      updateTaskStatus({ root, id: created.task.id, status: "active" }),
    ).rejects.toMatchObject({ code: "TASK_TERMINAL" });
  });

  it("selects only explicit id or exact context and never active-count fallback", async () => {
    const root = await workspace("Context");
    const first = await createTask({ root, title: "First" });
    const second = await createTask({ root, title: "Second" });
    expect(await currentTask({ root })).toEqual({ root: path.resolve(root), status: "none" });
    expect(await currentTask({ root, contextKey: "session:none" })).toEqual({
      root: path.resolve(root),
      status: "none",
    });
    await bindTask({ root, contextKey: "session:one", id: first.task.id });
    expect((await currentTask({ root, contextKey: "session:one" })).status).toBe("current");
    expect(
      ((await currentTask({ root, contextKey: "session:one" })) as { task: { id: string } }).task
        .id,
    ).toBe(first.task.id);
    await expect(
      bindTask({ root, contextKey: "session:one", id: second.task.id }),
    ).rejects.toMatchObject({ code: "TASK_CONTEXT_CONFLICT" });
    await bindTask({ root, contextKey: "session:one", id: second.task.id, rebind: true });
    expect(
      (
        (await currentTask({ root, id: first.task.id, contextKey: "session:one" })) as {
          task: { id: string };
        }
      ).task.id,
    ).toBe(first.task.id);
    await clearTaskContext({ root, contextKey: "session:one" });
    expect((await currentTask({ root, contextKey: "session:one" })).status).toBe("none");
  });
});

describe("native Task relations, archive, and pagination", () => {
  it("stores typed non-propagating relations and rejects self/cycles", async () => {
    const root = await workspace("Relations");
    const parent = await createTask({ root, title: "Parent" });
    const child = await createTask({
      root,
      title: "Child",
      relations: [{ type: "contributes_to", task_id: parent.task.id }],
    });
    expect(child.relations).toEqual([{ type: "contributes_to", task_id: parent.task.id }]);
    expect((await showTask({ root, id: parent.task.id })).relations).toEqual([]);
    await expect(
      setTaskRelations({
        root,
        id: parent.task.id,
        relations: [{ type: "continues", task_id: child.task.id }],
      }),
    ).rejects.toMatchObject({ code: "TASK_RELATION_CYCLE" });
    await expect(
      setTaskRelations({
        root,
        id: child.task.id,
        relations: [{ type: "supersedes", task_id: child.task.id }],
      }),
    ).rejects.toMatchObject({ code: "TASK_RELATION_INVALID" });
  });

  // 12 lock-contention rounds run ~25s unloaded on Windows; the default 30s times out under parallel CI load.
  it("serializes concurrent relation writes so a cycle cannot pass two stale reads", { timeout: 120_000 }, async () => {
    const root = await workspace("ConcurrentRelations");
    for (let round = 0; round < 12; round += 1) {
      const left = await createTask({ root, title: `Left ${round}` });
      const right = await createTask({ root, title: `Right ${round}` });
      const writes = await Promise.allSettled([
        setTaskRelations({
          root,
          id: left.task.id,
          relations: [{ type: "continues", task_id: right.task.id }],
        }),
        setTaskRelations({
          root,
          id: right.task.id,
          relations: [{ type: "continues", task_id: left.task.id }],
        }),
      ]);
      expect(writes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      const rejected = writes.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "TASK_RELATION_CYCLE" });
    }
  }, 30_000);

  it("archives terminal tasks independently and lists bounded pages", async () => {
    const root = await workspace("Archive");
    const tasks = await Promise.all(
      Array.from({ length: 4 }, (_, index) => createTask({ root, title: `Task ${index}` })),
    );
    const firstTask = tasks[0];
    const secondTask = tasks[1];
    if (firstTask === undefined || secondTask === undefined) throw new Error("task fixture failed");
    const archived = await archiveTask({
      root,
      id: (await finishTask({ root, id: firstTask.task.id })).task.id,
    });
    expect(archived.archived).toBe(true);
    expect((await archiveTask({ root, id: archived.task.id })).archived).toBe(true);
    expect((await showTask({ root, id: archived.task.id })).archived).toBe(true);
    await expect(archiveTask({ root, id: secondTask.task.id })).rejects.toMatchObject({
      code: "TASK_NOT_TERMINAL",
    });
    const first = await listTasks({ root, archived: true, limit: 2 });
    expect(first.tasks).toHaveLength(2);
    expect(first.next_cursor).toBeDefined();
    const cursor = first.next_cursor;
    expect(cursor).toBeDefined();
    const second = await listTasks({
      root,
      archived: true,
      limit: 2,
      cursor: cursor as string,
    });
    expect(second.tasks).toHaveLength(2);
    expect(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size).toBe(4);
  });
});

describe("native Task persistence hardening", () => {
  it("preserves unknown JSON fields and rejects one stale concurrent revision", async () => {
    const root = await workspace("Concurrency");
    const created = await createTask({ root, title: "Concurrent" });
    await rewriteTask(root, created.task.id, (record) => {
      record.future_field = { keep: true };
    });
    const writes = await Promise.allSettled([
      updateTaskStatus({
        root,
        id: created.task.id,
        status: "paused",
        expectedRevision: 0,
      }),
      checkpointTask({
        root,
        id: created.task.id,
        handoff: HANDOFF,
        expectedRevision: 0,
      }),
    ]);
    expect(writes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = writes.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "TASK_REVISION_CONFLICT" });
    const raw = JSON.parse(await readFile(taskFile(root, created.task.id), "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw.future_field).toEqual({ keep: true });
  });

  it("isolates corrupt history from exact task/context reads and check reports each record", async () => {
    const root = await workspace("CorruptIsolation");
    const valid = await createTask({ root, title: "Valid" });
    await bindTask({ root, contextKey: "session:valid", id: valid.task.id });
    const corrupt = path.join(root, "tasks", "broken");
    await mkdir(corrupt);
    await writeFile(path.join(corrupt, "task.json"), "{broken", "utf8");
    await writeFile(path.join(corrupt, "prd.md"), "# broken\n", "utf8");
    expect((await showTask({ root, id: valid.task.id })).task.id).toBe(valid.task.id);
    expect(
      ((await currentTask({ root, contextKey: "session:valid" })) as { task: { id: string } }).task
        .id,
    ).toBe(valid.task.id);
    const validation = await validateTasks({ root });
    expect(validation.valid).toBe(false);
    expect(validation.tasks.find((task) => task.id === valid.task.id)?.valid).toBe(true);
    expect(validation.tasks.find((task) => task.id === "broken")?.valid).toBe(false);
    const check = await checkFramework({ root });
    expect(check.rows.find((row) => row.path === "tasks/broken")).toMatchObject({
      status: "error",
    });
    expect(check.rows.find((row) => row.path === `tasks/${valid.task.id}`)).toMatchObject({
      status: "ok",
    });
  });

  it("requires readable directory identity and keeps invalid manual ids out of list pages", async () => {
    const root = await workspace("StrictIdentity");
    const valid = await createTask({ root, title: "Valid sibling" });
    const manual = path.join(root, "tasks", "manual-id");
    await mkdir(manual);
    const raw = JSON.parse(await readFile(taskFile(root, valid.task.id), "utf8")) as Record<
      string,
      unknown
    >;
    raw.id = "manual-id";
    await writeFile(path.join(manual, "task.json"), `${JSON.stringify(raw)}\n`, "utf8");
    await writeFile(path.join(manual, "prd.md"), "# Manual\n", "utf8");
    await expect(showTask({ root, id: "manual-id" })).rejects.toMatchObject({
      code: "TASK_ID_INVALID",
    });
    const validation = await validateTasks({ root });
    expect(validation.tasks.find((task) => task.id === "manual-id")).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "TASK_ID_INVALID" })],
    });
    const list = await listTasks({ root });
    expect(list.tasks.map((task) => task.id)).toEqual([valid.task.id]);
    expect(list.issues).toEqual([expect.objectContaining({ id: "manual-id", valid: false })]);
  });

  it("marks live/archive duplicates invalid without breaking valid sibling pagination", async () => {
    const root = await workspace("DuplicateLocations");
    const duplicate = await createTask({ root, title: "Duplicate" });
    const sibling = await createTask({ root, title: "Sibling" });
    const archive = path.join(root, "tasks", "archive", duplicate.task.id);
    await mkdir(path.dirname(archive), { recursive: true });
    await cp(path.join(root, "tasks", duplicate.task.id), archive, { recursive: true });
    await expect(showTask({ root, id: duplicate.task.id })).rejects.toMatchObject({
      code: "TASK_CONFLICT",
    });
    const validation = await validateTasks({ root });
    const conflicts = validation.tasks.filter((task) => task.id === duplicate.task.id);
    expect(conflicts).toHaveLength(2);
    expect(conflicts.every((task) => !task.valid)).toBe(true);
    expect(
      conflicts.every((task) => task.issues.some((issue) => issue.code === "TASK_CONFLICT")),
    ).toBe(true);
    expect(validation.tasks.find((task) => task.id === sibling.task.id)?.valid).toBe(true);
    const list = await listTasks({ root, archived: true, limit: 1 });
    expect(list.tasks).toEqual([expect.objectContaining({ id: sibling.task.id, valid: true })]);
    expect(list.issues.filter((task) => task.id === duplicate.task.id)).toHaveLength(2);
    const check = await checkFramework({ root });
    expect(
      check.rows.filter((row) => row.path.endsWith(duplicate.task.id) && row.status === "error"),
    ).toHaveLength(2);
  });

  it("reports fatal UTF-8 errors from show, validate, and check", async () => {
    const root = await workspace("InvalidEncoding");
    const created = await createTask({ root, title: "Encoding" });
    await writeFile(path.join(root, "tasks", created.task.id, "prd.md"), Buffer.from([0xff]));
    await expect(showTask({ root, id: created.task.id })).rejects.toMatchObject({
      code: "TASK_INVALID_ENCODING",
    });
    const validation = await validateTasks({ root });
    expect(validation.tasks[0]?.issues).toEqual([
      expect.objectContaining({ code: "TASK_INVALID_ENCODING" }),
    ]);
    const check = await checkFramework({ root });
    expect(check.rows.find((row) => row.path.endsWith(created.task.id))?.message).toContain(
      "TASK_INVALID_ENCODING",
    );
  });

  it("recovers only an old lock owned by a dead pid", async () => {
    const root = await workspace("StaleLock");
    const created = await createTask({ root, title: "Stale lock" });
    const exitedProcess = execa(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = exitedProcess.pid;
    await exitedProcess;
    if (deadPid === undefined) throw new Error("failed to capture child pid");
    const lock = path.join(root, ".absorb", "task-locks", created.task.id);
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, "owner.json"),
      `${JSON.stringify({
        token: randomUUID(),
        pid: deadPid,
        created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      })}\n`,
      "utf8",
    );
    expect(
      (await updateTaskStatus({ root, id: created.task.id, status: "paused" })).task.status,
    ).toBe("paused");
    expect(await lstat(lock).catch(() => null)).toBeNull();
  });

  it("quarantines an aged ownerless lock left by the previous lock protocol", async () => {
    const root = await workspace("OwnerlessLock");
    const created = await createTask({ root, title: "Ownerless lock" });
    const lock = path.join(root, ".absorb", "task-locks", created.task.id);
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lock, old, old);
    expect(
      (await updateTaskStatus({ root, id: created.task.id, status: "paused" })).task.status,
    ).toBe("paused");
    expect(await lstat(lock).catch(() => null)).toBeNull();
  });

  it("never publishes an ownerless final lock when prepared-owner claim fails", async () => {
    const root = await workspace("PreparedLockClaim");
    const parent = path.join(root, ".absorb", "task-locks");
    const lock = path.join(parent, "fault-injected");
    setTaskLockProbeForTests((stage) => {
      if (stage === "after-owner-sync") throw new Error("simulated crash before lock claim");
    });
    await expect(withTaskLock(root, lock, async () => undefined)).rejects.toThrow(
      /simulated crash before lock claim/,
    );
    expect(await lstat(lock).catch(() => null)).toBeNull();
    expect((await readdir(parent)).filter((name) => name.startsWith("fault-injected"))).toEqual([]);
    setTaskLockProbeForTests(undefined);
    expect(await withTaskLock(root, lock, async () => "claimed")).toBe("claimed");
    expect(await lstat(lock).catch(() => null)).toBeNull();
  });

  it("retries when a holder releases between owner inspection and owner read", async () => {
    const root = await workspace("LockReleaseRace");
    const lock = path.join(root, ".absorb", "task-locks", "release-race");
    let releaseHolder: (() => void) | undefined;
    let markHolderReady: (() => void) | undefined;
    const holderReady = new Promise<void>((resolve) => {
      markHolderReady = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withTaskLockUncoordinatedForTests(root, lock, async () => {
      markHolderReady?.();
      await hold;
    });
    await holderReady;
    let injected = false;
    setTaskLockProbeForTests(async (stage, finalDirectory) => {
      if (stage === "after-owner-entry-inspection" && finalDirectory === lock && !injected) {
        injected = true;
        releaseHolder?.();
        await holder;
      }
    });
    expect(await withTaskLockUncoordinatedForTests(root, lock, async () => "waiter-claimed")).toBe(
      "waiter-claimed",
    );
    expect(injected).toBe(true);
    expect(await lstat(lock).catch(() => null)).toBeNull();
  });

  it("fails closed on unknown lock ownership and releases only its own token", async () => {
    const root = await workspace("LockOwnership");
    const created = await createTask({ root, title: "Lock ownership" });
    const unknown = path.join(root, ".absorb", "task-locks", created.task.id);
    await mkdir(unknown, { recursive: true });
    await writeFile(path.join(unknown, "owner.json"), "{}\n", "utf8");
    await expect(showTask({ root, id: created.task.id })).rejects.toMatchObject({
      code: "TASK_CONFLICT",
    });
    expect(await lstat(unknown)).toBeDefined();
    await rm(unknown, { recursive: true, force: true });

    setTaskLockWaitForTests(20);
    await mkdir(unknown, { recursive: true });
    await writeFile(
      path.join(unknown, "owner.json"),
      `${JSON.stringify({
        token: randomUUID(),
        pid: process.pid,
        created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      })}\n`,
      "utf8",
    );
    await expect(showTask({ root, id: created.task.id })).rejects.toMatchObject({
      code: "TASK_CONFLICT",
    });
    expect(await lstat(unknown)).toBeDefined();
    await rm(unknown, { recursive: true, force: true });
    setTaskLockWaitForTests(undefined);

    const changed = path.join(root, ".absorb", "task-locks", "owner-change");
    await expect(
      withTaskLock(root, changed, async () => {
        await writeFile(
          path.join(changed, "owner.json"),
          `${JSON.stringify({
            token: randomUUID(),
            pid: process.pid,
            created_at: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
      }),
    ).rejects.toBeInstanceOf(TaskLockUnavailableError);
    expect(await lstat(changed)).toBeDefined();
  });

  it("reports a dangling context without hiding valid task rows", async () => {
    const root = await workspace("DanglingContext");
    const valid = await createTask({ root, title: "Valid" });
    await writeFile(
      path.join(root, ".absorb", "task-contexts.json"),
      `${JSON.stringify({ version: 1, bindings: { "session:missing": randomUUID() } }, null, 2)}\n`,
      "utf8",
    );
    const validation = await validateTasks({ root });
    expect(validation.tasks.find((task) => task.id === valid.task.id)?.valid).toBe(true);
    expect(validation.context_issues).toEqual([
      expect.objectContaining({ code: "TASK_ID_INVALID" }),
    ]);
    await expect(contextTask({ root, contextKey: "session:missing" })).rejects.toMatchObject({
      code: "TASK_ID_INVALID",
    });
    const check = await checkFramework({ root });
    expect(check.rows.find((row) => row.path === ".absorb/task-contexts.json")).toMatchObject({
      status: "error",
    });
    expect(check.rows.find((row) => row.path === `tasks/${valid.task.id}`)).toMatchObject({
      status: "ok",
    });
  });

  it("keeps the old record intact when atomic replacement fails", async () => {
    const root = await workspace("Atomic");
    const created = await createTask({ root, title: "Atomic" });
    const before = await readFile(taskFile(root, created.task.id), "utf8");
    setTaskStorageProbeForTests((phase) => {
      if (phase === "before-commit") throw new Error("injected atomic failure");
    });
    await expect(
      updateTaskStatus({ root, id: created.task.id, status: "paused" }),
    ).rejects.toMatchObject({ code: "TASK_IO_ERROR" });
    expect(await readFile(taskFile(root, created.task.id), "utf8")).toBe(before);
  });

  it("rejects a redirecting tasks directory", async () => {
    const root = await workspace("Boundary");
    const outside = fixturePath("assay-task-outside");
    roots.push(outside);
    await mkdir(outside);
    const target = path.join(root, "tasks");
    await rm(target, { recursive: true, force: true });
    try {
      await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(createTask({ root, title: "Escape" })).rejects.toMatchObject({
      code: "TASK_STORAGE_BOUNDARY",
    });
    expect(await readdir(outside)).toEqual([]);
  });
});
