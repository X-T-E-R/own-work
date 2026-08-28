import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { fixturePath, writeBareTemplate } from "./helpers.js";

import {
  archiveRoadmap,
  archiveTask,
  checkOwnWork as checkFramework,
  createRoadmap,
  createTask,
  finishTask,
  initOwnWork as initFramework,
  linkRoadmapTask,
  listRoadmaps,
  realizeRoadmap,
  retireRoadmap,
  setRoadmapArchiveProbeForTests,
  setRoadmapMutationProbeForTests,
  showRoadmap,
  unlinkRoadmapTask,
  updateRoadmap,
  validateRoadmaps,
} from "../src/index.js";

const roots: string[] = [];

async function workspace(name: string): Promise<string> {
  const root = fixturePath("assay-roadmap");
  roots.push(root);
  const template = await writeBareTemplate(root);
  await initFramework({ target: root, name, template, standalone: true });
  return root;
}

function itemFile(root: string, id: string, archived = false): string {
  return path.join(root, "project", "roadmap", ...(archived ? ["archive"] : []), id, "item.yaml");
}

afterEach(async () => {
  setRoadmapMutationProbeForTests(undefined);
  setRoadmapArchiveProbeForTests(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Roadmap", { timeout: 60_000 }, () => {
  it("allocates readable stable ids and preserves reader-owned outcome prose", async () => {
    const root = await workspace("路线图");
    const first = await createRoadmap({ root, title: "路线图" });
    const second = await createRoadmap({ root, title: "路线图" });
    expect(first.item.id).toBe("roadmap-0001");
    expect(second.item.id).toBe("roadmap-0002");
    const outcome = path.join(root, first.path, "outcome.md");
    const prose = "# User Problem\n\nReader edit.\n";
    await writeFile(outcome, prose, "utf8");
    const renamed = await updateRoadmap({
      root,
      id: first.item.id,
      title: "Renamed",
      horizon: "now",
      order: 0,
      expectedRevision: 0,
    });
    expect(renamed.item.id).toBe(first.item.id);
    expect(renamed.item.revision).toBe(1);
    expect(await readFile(outcome, "utf8")).toBe(prose);
    expect(
      await readFile(path.join(root, "project", "roadmap", "README.md"), "utf8"),
    ).not.toContain(first.item.id);
  });

  it("links live and archived Tasks without writing Task bytes or propagating status", async () => {
    const root = await workspace("Links");
    const roadmap = await createRoadmap({ root, title: "Ship" });
    const task = await createTask({ root, title: "Implement" });
    const taskFile = path.join(root, task.path, "task.json");
    const before = await readFile(taskFile);
    await linkRoadmapTask({ root, id: roadmap.item.id, task: task.task.id });
    expect(await readFile(taskFile)).toEqual(before);
    const itemBytes = await readFile(itemFile(root, roadmap.item.id));
    await finishTask({ root, id: task.task.id });
    await archiveTask({ root, id: task.task.id });
    expect(await readFile(itemFile(root, roadmap.item.id))).toEqual(itemBytes);
    const shown = await showRoadmap({ root, id: roadmap.item.id });
    expect(shown.item.state).toBe("candidate");
    expect(shown.tasks).toEqual([
      expect.objectContaining({
        id: task.task.id,
        status: "done",
        archived: true,
        unresolved: false,
      }),
    ]);
    await rm(path.join(root, "tasks", "archive", task.task.id), { recursive: true });
    expect((await showRoadmap({ root, id: roadmap.item.id })).tasks[0]).toMatchObject({
      unresolved: true,
    });
    await unlinkRoadmapTask({ root, id: roadmap.item.id, task: task.task.id });
    expect((await showRoadmap({ root, id: roadmap.item.id })).item.task_refs).toEqual([]);
    await expect(
      linkRoadmapTask({
        root,
        id: roadmap.item.id,
        task: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).rejects.toMatchObject({ code: "ROADMAP_TASK_ID_INVALID" });
    const raw = parse(await readFile(itemFile(root, roadmap.item.id), "utf8")) as Record<
      string,
      unknown
    >;
    raw.task_refs = [{ kind: "assay.task", id: "123e4567-e89b-42d3-a456-426614174000" }];
    await writeFile(itemFile(root, roadmap.item.id), stringify(raw), "utf8");
    await expect(showRoadmap({ root, id: roadmap.item.id })).rejects.toMatchObject({
      code: "ROADMAP_INVALID",
    });
  });

  it("rejects dangling and concurrent cyclic graph writes", async () => {
    const root = await workspace("Graph");
    const left = await createRoadmap({ root, title: "Left" });
    const right = await createRoadmap({ root, title: "Right" });
    await expect(
      updateRoadmap({ root, id: left.item.id, dependsOn: ["roadmap-9999-missing"] }),
    ).rejects.toMatchObject({ code: "ROADMAP_RELATION_INVALID" });
    const results = await Promise.allSettled([
      updateRoadmap({ root, id: left.item.id, dependsOn: [right.item.id] }),
      updateRoadmap({ root, id: right.item.id, dependsOn: [left.item.id] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("enforces terminal lifecycle, CAS, idempotent archive, and live/archive conflicts", async () => {
    const root = await workspace("Lifecycle");
    const item = await createRoadmap({ root, title: "Lifecycle" });
    await expect(
      updateRoadmap({ root, id: item.item.id, title: "stale", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "ROADMAP_REVISION_CONFLICT" });
    const realized = await realizeRoadmap({ root, id: item.item.id });
    await expect(
      updateRoadmap({ root, id: item.item.id, state: "committed" }),
    ).rejects.toMatchObject({ code: "ROADMAP_TERMINAL" });
    const archived = await archiveRoadmap({ root, id: realized.item.id });
    expect(archived.archived).toBe(true);
    expect((await archiveRoadmap({ root, id: realized.item.id })).archived).toBe(true);
    await cp(
      path.join(root, archived.path),
      path.join(root, "project", "roadmap", realized.item.id),
      { recursive: true },
    );
    await expect(archiveRoadmap({ root, id: realized.item.id })).rejects.toMatchObject({
      code: "ROADMAP_CONFLICT",
    });

    const retired = await createRoadmap({ root, title: "Old" });
    const successor = await createRoadmap({ root, title: "New" });
    await expect(
      updateRoadmap({ root, id: retired.item.id, supersededBy: [successor.item.id] }),
    ).rejects.toMatchObject({ code: "ROADMAP_RELATION_INVALID" });
    expect(
      (
        await updateRoadmap({
          root,
          id: retired.item.id,
          state: "retired",
          supersededBy: [successor.item.id],
        })
      ).item.state,
    ).toBe("retired");
    await expect(retireRoadmap({ root, id: realized.item.id })).rejects.toMatchObject({
      code: "ROADMAP_CONFLICT",
    });
  });

  it("rechecks external bytes, revision, and terminal state immediately before archive", async () => {
    const root = await workspace("Archive recheck");
    const item = await realizeRoadmap({
      root,
      id: (await createRoadmap({ root, title: "Archive race" })).item.id,
    });
    const file = itemFile(root, item.item.id);
    setRoadmapArchiveProbeForTests(async () => {
      const raw = parse(await readFile(file, "utf8")) as Record<string, unknown>;
      raw.state = "committed";
      raw.revision = Number(raw.revision) + 1;
      raw.updated_at = new Date().toISOString();
      await writeFile(file, stringify(raw), "utf8");
    });
    await expect(archiveRoadmap({ root, id: item.item.id })).rejects.toMatchObject({
      code: "ROADMAP_CONFLICT",
    });
    expect(await readFile(file, "utf8")).toContain("state: committed");
    expect(
      await readFile(itemFile(root, item.item.id, true), "utf8").catch(() => undefined),
    ).toBeUndefined();
  });

  it("serializes highest-sequence archive with allocation", async () => {
    const root = await workspace("Archive allocator lock");
    const highest = await realizeRoadmap({
      root,
      id: (await createRoadmap({ root, title: "Old slug" })).item.id,
    });
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    setRoadmapArchiveProbeForTests(async () => {
      enteredResolve?.();
      await release;
    });
    const archiving = archiveRoadmap({ root, id: highest.item.id });
    await entered;
    let createdSettled = false;
    const creating = createRoadmap({ root, title: "New slug" }).finally(() => {
      createdSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(createdSettled).toBe(false);
    releaseResolve?.();
    await archiving;
    expect((await creating).item.id).toBe("roadmap-0002-new-slug");
  });

  it("rejects an external byte change instead of overwriting it", async () => {
    const root = await workspace("External write");
    const item = await createRoadmap({ root, title: "Original" });
    const file = itemFile(root, item.item.id);
    let external = "";
    setRoadmapMutationProbeForTests(async () => {
      external = (await readFile(file, "utf8")).replace("title: Original", "title: External");
      await writeFile(file, external, "utf8");
    });
    await expect(
      updateRoadmap({ root, id: item.item.id, title: "Assay update", expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "ROADMAP_CONFLICT" });
    expect(await readFile(file, "utf8")).toBe(external);
  });

  it("keeps healthy siblings visible with malformed UTF-8, dangling refs, and pagination", async () => {
    const root = await workspace("Partial");
    const first = await createRoadmap({ root, title: "First" });
    const second = await createRoadmap({ root, title: "Second" });
    const third = await createRoadmap({ root, title: "Third" });
    await writeFile(itemFile(root, second.item.id), Buffer.from([0xff]));
    const thirdRaw = parse(await readFile(itemFile(root, third.item.id), "utf8")) as Record<
      string,
      unknown
    >;
    thirdRaw.task_refs = [{ kind: "assay.task", id: "task-9999-missing" }];
    await writeFile(itemFile(root, third.item.id), stringify(thirdRaw), "utf8");
    const list = await listRoadmaps({ root, archived: "all", limit: 1 });
    expect(list.items.map((item) => item.id)).toEqual([first.item.id]);
    expect(list.next_cursor).toBe(first.item.id);
    expect(list.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["ROADMAP_INVALID_ENCODING", "ROADMAP_TASK_UNRESOLVED"]),
    );
    expect((await validateRoadmaps({ root })).valid).toBe(false);
    expect(
      (await checkFramework({ root })).rows.some(
        (row) => row.path.endsWith(second.item.id) && row.status === "error",
      ),
    ).toBe(true);
  });

  it("reports a redirecting item without following it or hiding healthy siblings", async () => {
    const root = await workspace("Redirect");
    const healthy = await createRoadmap({ root, title: "Healthy" });
    const outside = fixturePath("assay-roadmap-outside");
    roots.push(outside);
    await mkdir(outside, { recursive: true });
    await symlink(
      outside,
      path.join(root, "project", "roadmap", "roadmap-9999-redirect"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const checked = await checkFramework({ root });
    expect(checked.rows).toContainEqual(
      expect.objectContaining({ path: healthy.path, status: "ok" }),
    );
    expect(checked.rows).toContainEqual(
      expect.objectContaining({
        path: "project/roadmap/roadmap-9999-redirect",
        status: "error",
      }),
    );
    expect(await readFile(path.join(root, healthy.path, "outcome.md"), "utf8")).toContain(
      "# User Problem",
    );
  });

  it("requires an ordinary native Project before every Roadmap operation", async () => {
    const missing = await workspace("Missing Project");
    await rm(path.join(missing, "project"), { recursive: true });
    await expect(
      createRoadmap({ root: missing, title: "Must not recreate" }),
    ).rejects.toMatchObject({ code: "ROADMAP_PROJECT_INVALID" });
    expect(
      await readFile(path.join(missing, "project", "project.yaml"), "utf8").catch(() => undefined),
    ).toBeUndefined();
    expect(await readdir(path.join(missing, ".absorb", "roadmap-locks")).catch(() => [])).toEqual(
      [],
    );

    const redirected = await workspace("Redirected Project");
    const project = path.join(redirected, "project");
    const actual = path.join(redirected, "project-actual");
    await rm(actual, { recursive: true, force: true });
    await rename(project, actual);
    await symlink(actual, project, process.platform === "win32" ? "junction" : "dir");
    await expect(listRoadmaps({ root: redirected })).rejects.toMatchObject({
      code: "ROADMAP_PROJECT_INVALID",
    });
  });

  it("rejects malformed list cursors, Task filters, and unlink ids", async () => {
    const root = await workspace("Ingress validation");
    const item = await createRoadmap({ root, title: "Ingress" });
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    await expect(listRoadmaps({ root, cursor: uuid })).rejects.toMatchObject({
      code: "ROADMAP_ID_INVALID",
    });
    await expect(listRoadmaps({ root, task: uuid })).rejects.toMatchObject({
      code: "ROADMAP_TASK_ID_INVALID",
    });
    await expect(unlinkRoadmapTask({ root, id: item.item.id, task: uuid })).rejects.toMatchObject({
      code: "ROADMAP_TASK_ID_INVALID",
    });
  });
});
