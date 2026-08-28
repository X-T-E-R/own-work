import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { fixturePath, writeBareTemplate } from "./helpers.js";

import {
  archiveTask,
  bindTask,
  checkOwnWork as checkFramework,
  createTask,
  currentTask,
  finishTask,
  initOwnWork as initFramework,
  listTasks,
  setTaskRelations,
  showTask,
  surveyTasks,
  validateTasks,
} from "../src/index.js";

const roots: string[] = [];

async function workspace(name: string): Promise<string> {
  const root = fixturePath("assay-task-prefix");
  roots.push(root);
  const template = await writeBareTemplate(root);
  await initFramework({ target: root, name, template, standalone: true });
  return root;
}

/** File an existing Task under a navigation prefix, the way a reader would. */
async function moveUnderPrefix(root: string, id: string, prefix: string): Promise<string> {
  const target = path.join(root, "tasks", ...prefix.split("/"), id);
  await mkdir(path.dirname(target), { recursive: true });
  await rename(path.join(root, "tasks", id), target);
  return target;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Task physical prefixes", () => {
  it("resolves a Task by id from any depth and leaves the envelope alone", async () => {
    const root = await workspace("PrefixResolution");
    const flat = await createTask({ root, title: "Stays flat" });
    const nested = await createTask({ root, title: "Gets filed" });
    const before = await readFile(path.join(root, "tasks", nested.task.id, "task.json"), "utf8");
    await moveUnderPrefix(root, nested.task.id, "research/deep");

    const shown = await showTask({ root, id: nested.task.id });
    expect(shown.path).toBe(`tasks/research/deep/${nested.task.id}`);
    expect(shown.task.id).toBe(nested.task.id);
    // A prefix is navigation, so nothing about it reaches the record.
    expect(
      await readFile(
        path.join(root, "tasks", "research", "deep", nested.task.id, "task.json"),
        "utf8",
      ),
    ).toBe(before);

    const listed = await listTasks({ root });
    expect(listed.issues).toEqual([]);
    expect(listed.tasks.map((task) => task.id).sort()).toEqual(
      [flat.task.id, nested.task.id].sort(),
    );
    expect(listed.tasks.find((task) => task.id === nested.task.id)?.path).toBe(
      `tasks/research/deep/${nested.task.id}`,
    );
  });

  it("keeps bindings, relations, and validation working across prefixes", async () => {
    const root = await workspace("PrefixReferences");
    const left = await createTask({ root, title: "Left" });
    const right = await createTask({ root, title: "Right" });
    await moveUnderPrefix(root, left.task.id, "wave/one");
    await moveUnderPrefix(root, right.task.id, "wave/two/deeper");

    await bindTask({ root, contextKey: "session:prefixed", id: left.task.id });
    const current = await currentTask({ root, contextKey: "session:prefixed" });
    expect(current).toMatchObject({ status: "current", path: `tasks/wave/one/${left.task.id}` });

    const related = await setTaskRelations({
      root,
      id: left.task.id,
      relations: [{ type: "contributes_to", task_id: right.task.id }],
    });
    expect(related.relations).toEqual([{ type: "contributes_to", task_id: right.task.id }]);

    const validation = await validateTasks({ root });
    expect(validation.valid).toBe(true);
    expect(validation.context_issues).toEqual([]);
    expect(validation.tasks.map((task) => task.path).sort()).toEqual([
      `tasks/wave/one/${left.task.id}`,
      `tasks/wave/two/deeper/${right.task.id}`,
    ]);
    expect((await checkFramework({ root })).ok).toBe(true);
  });

  it("allocates the next id from prefixed storage too", async () => {
    const root = await workspace("PrefixAllocation");
    const first = await createTask({ root, title: "First" });
    await moveUnderPrefix(root, first.task.id, "archive-candidates");
    const second = await createTask({ root, title: "Second" });
    expect(second.task.id.startsWith("task-0002-")).toBe(true);
    // Creation stays flat; organizing is a separate manual move.
    expect(second.path).toBe(`tasks/${second.task.id}`);
  });

  it("reports one id filed under two prefixes as a storage conflict", async () => {
    const root = await workspace("PrefixDuplicate");
    const duplicate = await createTask({ root, title: "Duplicate" });
    const sibling = await createTask({ root, title: "Sibling" });
    const first = await moveUnderPrefix(root, duplicate.task.id, "one");
    await cp(first, path.join(root, "tasks", "two", duplicate.task.id), { recursive: true });

    await expect(showTask({ root, id: duplicate.task.id })).rejects.toMatchObject({
      code: "TASK_CONFLICT",
    });
    const listed = await listTasks({ root });
    expect(listed.tasks.map((task) => task.id)).toEqual([sibling.task.id]);
    expect(listed.issues.filter((entry) => entry.id === duplicate.task.id)).toHaveLength(2);
    expect(
      listed.issues.every((entry) => entry.issues.some((issue) => issue.code === "TASK_CONFLICT")),
    ).toBe(true);
  });

  it("archives a prefixed Task flat and leaves the prefix behind", async () => {
    const root = await workspace("PrefixArchive");
    const created = await createTask({ root, title: "Filed then archived" });
    await moveUnderPrefix(root, created.task.id, "quarter/q3");
    await finishTask({ root, id: created.task.id });

    const archived = await archiveTask({ root, id: created.task.id });
    expect(archived.path).toBe(`tasks/archive/${created.task.id}`);
    expect(archived.archived).toBe(true);
    // An emptied prefix is invisible rather than a finding.
    expect((await listTasks({ root, archived: true })).issues).toEqual([]);
  });

  it("refuses a navigation prefix inside the reserved archive and allows the name elsewhere", async () => {
    const root = await workspace("ArchiveReserved");
    const reserved = await createTask({ root, title: "Reserved" });
    const elsewhere = await createTask({ root, title: "Elsewhere" });
    await finishTask({ root, id: reserved.task.id });
    await archiveTask({ root, id: reserved.task.id });
    await moveUnderPrefix(root, elsewhere.task.id, "research/archive");

    // `archive` below a prefix is an ordinary word.
    expect((await showTask({ root, id: elsewhere.task.id })).path).toBe(
      `tasks/research/archive/${elsewhere.task.id}`,
    );
    expect((await showTask({ root, id: elsewhere.task.id })).archived).toBe(false);

    const grouped = path.join(root, "tasks", "archive", "by-quarter");
    await mkdir(grouped, { recursive: true });
    await rename(
      path.join(root, "tasks", "archive", reserved.task.id),
      path.join(grouped, reserved.task.id),
    );

    const listed = await listTasks({ root, archived: true });
    const finding = listed.issues.find((entry) => entry.id === "by-quarter");
    expect(finding?.path).toBe("tasks/archive/by-quarter");
    expect(finding?.issues[0]?.message).toContain("reserved for archived Tasks and stays flat");
    expect((await checkFramework({ root })).ok).toBe(false);
  });

  it("ignores an in-flight temporary directory and a reader's own notes", async () => {
    const root = await workspace("PrefixNoise");
    const created = await createTask({ root, title: "Only Task" });
    await mkdir(path.join(root, "tasks", ".create-task-0009-abandoned"), { recursive: true });
    await mkdir(path.join(root, "tasks", "notes"), { recursive: true });
    await writeFile(path.join(root, "tasks", "README.md"), "# how I file Tasks\n", "utf8");
    await writeFile(path.join(root, "tasks", "notes", "why.md"), "because\n", "utf8");

    const listed = await listTasks({ root });
    expect(listed.tasks.map((task) => task.id)).toEqual([created.task.id]);
    expect(listed.issues).toEqual([]);
    expect((await checkFramework({ root })).ok).toBe(true);
  });
});

describe("Task discovery and integrity are separate views", () => {
  it("keeps envelope health in list and moves the lineage graph to validate", async () => {
    const root = await workspace("ListSplit");
    const healthy = await createTask({ root, title: "Healthy" });
    const dangling = await createTask({ root, title: "Dangling" });
    const target = await createTask({ root, title: "Target" });
    await setTaskRelations({
      root,
      id: dangling.task.id,
      relations: [{ type: "contributes_to", task_id: target.task.id }],
    });
    // Break the lineage after the write that validated it.
    await rm(path.join(root, "tasks", target.task.id), { recursive: true, force: true });

    const listed = await listTasks({ root });
    expect(listed.issues).toEqual([]);
    expect(listed.tasks.map((task) => task.id).sort()).toEqual(
      [dangling.task.id, healthy.task.id].sort(),
    );

    const validation = await validateTasks({ root });
    expect(validation.valid).toBe(false);
    expect(validation.tasks.find((task) => task.id === dangling.task.id)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "TASK_NOT_FOUND" })],
    });
    expect(validation.tasks.find((task) => task.id === healthy.task.id)?.valid).toBe(true);
  });

  it("still reports an unreadable envelope and an id that disagrees with its directory", async () => {
    const root = await workspace("EnvelopeHealth");
    const valid = await createTask({ root, title: "Valid" });
    const broken = path.join(root, "tasks", "research", "task-0090-broken");
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, "task.json"), "{not json", "utf8");
    await writeFile(path.join(broken, "prd.md"), "# broken\n", "utf8");
    const mismatched = path.join(root, "tasks", "research", "task-0091-mismatched");
    await mkdir(mismatched, { recursive: true });
    const envelope = JSON.parse(
      await readFile(path.join(root, "tasks", valid.task.id, "task.json"), "utf8"),
    ) as Record<string, unknown>;
    await writeFile(path.join(mismatched, "task.json"), `${JSON.stringify(envelope)}\n`, "utf8");
    await writeFile(path.join(mismatched, "prd.md"), "# mismatched\n", "utf8");

    const listed = await listTasks({ root });
    expect(listed.tasks.map((task) => task.id)).toEqual([valid.task.id]);
    expect(listed.issues.map((entry) => entry.id).sort()).toEqual([
      "task-0090-broken",
      "task-0091-mismatched",
    ]);
    expect(listed.issues.every((entry) => entry.issues[0]?.code === "TASK_INVALID")).toBe(true);
  });

  it("reads Task files at record depth and stays at the envelope for discovery", async () => {
    const root = await workspace("SurveyDepth");
    const created = await createTask({ root, title: "Corrupt contract" });
    await writeFile(path.join(root, "tasks", created.task.id, "prd.md"), Buffer.from([0xff]));

    const envelope = await surveyTasks({ root });
    expect(envelope.ok).toBe(true);
    expect(envelope.tasks[0]).toMatchObject({ id: created.task.id, valid: true });
    expect((await listTasks({ root })).issues).toEqual([]);

    const record = await surveyTasks({ root, depth: "record" });
    expect(record.ok).toBe(false);
    expect(record.tasks[0]?.issues[0]?.code).toBe("TASK_INVALID_ENCODING");
  });
});
