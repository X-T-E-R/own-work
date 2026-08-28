import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAnalysis, readableSequence } from "absorb-anything-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { fixturePath, writeBareTemplate } from "./helpers.js";

import {
  activateSpec,
  archiveSpec,
  checkOwnWork as checkFramework,
  createRoadmap,
  createSpec,
  createTask,
  initOwnWork as initFramework,
  listSpecs,
  promoteSpec,
  registerSystem,
  replaceSpec,
  retireSpec,
  setSpecArchiveProbeForTests,
  setSpecMutationProbeForTests,
  setSpecPromotionProbeForTests,
  showSpec,
  updateSpec,
  validateSpecs,
} from "../src/index.js";

const roots: string[] = [];

async function workspace(name: string): Promise<string> {
  const root = fixturePath("assay-spec");
  roots.push(root);
  const template = await writeBareTemplate(root);
  await initFramework({ target: root, name, template, standalone: true });
  return root;
}

function specFile(root: string, id: string, archived = false): string {
  return path.join(root, "project", "specs", ...(archived ? ["archive"] : []), id, "spec.yaml");
}

function bodyFile(root: string, id: string, archived = false): string {
  return path.join(
    root,
    "project",
    "specs",
    ...(archived ? ["archive"] : []),
    id,
    "specification.md",
  );
}

const validBody = `## Purpose

Define observable behavior.

## Scope

The native Spec module.

## Requirements

- Preserve reader bytes.

## Constraints

- No implicit approval.

## Acceptance Criteria

- Focused tests pass.

## Non-Goals

- Semantic quality scoring.
`;

afterEach(async () => {
  setSpecMutationProbeForTests(undefined);
  setSpecArchiveProbeForTests(undefined);
  setSpecPromotionProbeForTests(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Spec", { timeout: 60_000 }, () => {
  it("lazily creates storage, allocates across live/archive, and preserves body bytes", async () => {
    const root = await workspace("Specs");
    expect(await readFile(path.join(root, "project", "specs", "README.md"), "utf8")).toContain(
      "# Specifications",
    );
    const first = await createSpec({
      root,
      title: "Duplicate",
      scope: "project",
      strength: "required",
    });
    expect(first.item.id).toBe("spec-0001-duplicate");
    expect(first.item.state).toBe("draft");
    expect(first.item.derived_from).toEqual([]);
    const edited = Buffer.from(validBody, "utf8");
    await writeFile(bodyFile(root, first.item.id), edited);
    const renamed = await updateSpec({
      root,
      id: first.item.id,
      title: "Renamed",
      expectedRevision: 0,
    });
    expect(renamed.item.id).toBe(first.item.id);
    expect(await readFile(bodyFile(root, first.item.id))).toEqual(edited);
    await retireSpec({ root, id: first.item.id, expectedRevision: 1 });
    await archiveSpec({ root, id: first.item.id });
    const second = await createSpec({
      root,
      title: "Duplicate",
      scope: "project",
      strength: "recommended",
    });
    expect(second.item.id).toBe("spec-0002-duplicate");
    expect(await readFile(path.join(root, "project", "specs", "README.md"), "utf8")).not.toContain(
      second.item.id,
    );
  });

  it("activates only structurally complete bodies and never treats activation as approval", async () => {
    const root = await workspace("Activation");
    const draft = await createSpec({
      root,
      title: "Contract",
      scope: "project",
      strength: "required",
    });
    await expect(activateSpec({ root, id: draft.item.id })).rejects.toMatchObject({
      code: "SPEC_BODY_INVALID",
    });
    await writeFile(bodyFile(root, draft.item.id), validBody, "utf8");
    const active = await activateSpec({ root, id: draft.item.id, expectedRevision: 0 });
    expect(active.item.state).toBe("active");
    expect(active.item.revision).toBe(1);
    await expect(updateSpec({ root, id: draft.item.id, title: "No" })).rejects.toMatchObject({
      code: "SPEC_TERMINAL",
    });
    await expect(activateSpec({ root, id: draft.item.id })).rejects.toMatchObject({
      code: "SPEC_TERMINAL",
    });
  });

  it("promotes exact Analysis and Task bytes into draft provenance without source mutation", async () => {
    const root = await workspace("Promotion");
    const analysis = await createAnalysis({ root, title: "Pinned analysis" });
    const analysisPath = path.join(root, analysis.path);
    const analysisBytes = await readFile(analysisPath);
    const body = path.join(root, "clean-spec.md");
    await writeFile(body, validBody, "utf8");
    const promoted = await promoteSpec({
      root,
      title: "From analysis",
      scope: "project",
      strength: "required",
      bodyFile: body,
      fromAnalysis: analysis.path,
    });
    expect(promoted.item.state).toBe("draft");
    expect(promoted.item.derived_from).toEqual([
      {
        kind: "assay.analysis",
        path: analysis.path,
        sha256: createHash("sha256").update(analysisBytes).digest("hex"),
      },
    ]);
    expect(await readFile(analysisPath)).toEqual(analysisBytes);
    expect(await readFile(bodyFile(root, promoted.item.id))).toEqual(await readFile(body));

    const task = await createTask({ root, title: "Pinned task" });
    const roadmap = await createRoadmap({ root, title: "Unrelated roadmap" });
    const roadmapItemPath = path.join(root, roadmap.path, "item.yaml");
    const roadmapOutcomePath = path.join(root, roadmap.path, "outcome.md");
    const roadmapItemBytes = await readFile(roadmapItemPath);
    const roadmapOutcomeBytes = await readFile(roadmapOutcomePath);
    const taskPath = path.join(root, task.path, "prd.md");
    const taskBytes = await readFile(taskPath);
    const fromTask = await promoteSpec({
      root,
      title: "From task",
      scope: "project",
      strength: "recommended",
      bodyFile: body,
      fromTask: task.task.id,
      taskFile: "prd.md",
    });
    expect(fromTask.item.derived_from[0]).toEqual({
      kind: "assay.task",
      id: task.task.id,
      file: "prd.md",
      sha256: createHash("sha256").update(taskBytes).digest("hex"),
    });
    expect(await readFile(taskPath)).toEqual(taskBytes);
    expect(await readFile(roadmapItemPath)).toEqual(roadmapItemBytes);
    expect(await readFile(roadmapOutcomePath)).toEqual(roadmapOutcomeBytes);
  });

  it("reports provenance drift without changing active state", async () => {
    const root = await workspace("Drift");
    const analysis = await createAnalysis({ root, title: "Drift source" });
    const body = path.join(root, "body.md");
    await writeFile(body, validBody, "utf8");
    const spec = await promoteSpec({
      root,
      title: "Drift spec",
      scope: "project",
      strength: "required",
      bodyFile: body,
      fromAnalysis: analysis.path,
    });
    await activateSpec({ root, id: spec.item.id });
    await writeFile(path.join(root, analysis.path), "changed", "utf8");
    const validation = await validateSpecs({ root, id: spec.item.id });
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual([expect.objectContaining({ code: "SPEC_PROVENANCE_DRIFT" })]);
    expect((await showSpec({ root, id: spec.item.id })).item.state).toBe("active");
  });

  it("replaces only the old item, requires active successors, and archives idempotently", async () => {
    const root = await workspace("Replace");
    const old = await createSpec({ root, title: "Old", scope: "project", strength: "required" });
    const successor = await createSpec({
      root,
      title: "New",
      scope: "project",
      strength: "required",
    });
    await writeFile(bodyFile(root, successor.item.id), validBody, "utf8");
    const active = await activateSpec({ root, id: successor.item.id });
    const successorBytes = await readFile(specFile(root, successor.item.id));
    const replaced = await replaceSpec({ root, id: old.item.id, with: [successor.item.id] });
    expect(replaced.item).toMatchObject({ state: "retired", superseded_by: [successor.item.id] });
    expect(await readFile(specFile(root, successor.item.id))).toEqual(successorBytes);
    expect((await showSpec({ root, id: active.item.id })).item.state).toBe("active");
    expect((await archiveSpec({ root, id: old.item.id })).archived).toBe(true);
    expect((await archiveSpec({ root, id: old.item.id })).archived).toBe(true);
  });

  it("rejects a successor graph edit immediately before replacement publication", async () => {
    const root = await workspace("Replacement race");
    const old = await createSpec({ root, title: "Old", scope: "project", strength: "required" });
    const successor = await createSpec({
      root,
      title: "Successor",
      scope: "project",
      strength: "required",
    });
    await writeFile(bodyFile(root, successor.item.id), validBody, "utf8");
    await activateSpec({ root, id: successor.item.id });
    setSpecMutationProbeForTests(async (id) => {
      if (id !== old.item.id) return;
      const file = specFile(root, successor.item.id);
      const raw = parse(await readFile(file, "utf8")) as Record<string, unknown>;
      raw.state = "retired";
      raw.superseded_by = [old.item.id];
      raw.revision = Number(raw.revision) + 1;
      raw.updated_at = new Date().toISOString();
      await writeFile(file, stringify(raw), "utf8");
    });

    await expect(
      replaceSpec({ root, id: old.item.id, with: [successor.item.id] }),
    ).rejects.toMatchObject({ code: "SPEC_CONFLICT" });
    expect((await showSpec({ root, id: old.item.id })).item).toMatchObject({
      state: "draft",
      revision: 0,
      superseded_by: [],
    });
    expect(
      (await validateSpecs({ root })).issues.filter(
        (issue) => issue.code === "SPEC_RELATION_CYCLE",
      ),
    ).toEqual([]);
  });

  it("keeps healthy siblings visible and integrates issues into check", async () => {
    const root = await workspace("Partial");
    const healthy = await createSpec({
      root,
      title: "Healthy",
      scope: "project",
      strength: "required",
    });
    const broken = await createSpec({
      root,
      title: "Broken",
      scope: "project",
      strength: "required",
    });
    await writeFile(specFile(root, broken.item.id), "not: [valid", "utf8");
    const listed = await listSpecs({ root, archived: "all" });
    expect(listed.items.map((item) => item.id)).toEqual([healthy.item.id]);
    expect(listed.issues).toEqual([expect.objectContaining({ id: broken.item.id })]);
    expect((await showSpec({ root, id: healthy.item.id })).item.id).toBe(healthy.item.id);
    expect((await checkFramework({ root })).rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `project/specs/${healthy.item.id}`, status: "ok" }),
        expect.objectContaining({ path: `project/specs/${broken.item.id}`, status: "error" }),
      ]),
    );
  });

  it("keeps create staging outside readable Spec inventory", async () => {
    const root = await workspace("Invisible staging");
    const existing = await createSpec({
      root,
      title: "Existing",
      scope: "project",
      strength: "required",
    });
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    setSpecPromotionProbeForTests(async (id) => {
      if (id === existing.item.id) return;
      enteredResolve?.();
      await release;
    });
    const creating = createSpec({
      root,
      title: "Concurrent",
      scope: "project",
      strength: "required",
    });
    await entered;
    const during = await listSpecs({ root, archived: "all" });
    expect(during.items.map((item) => item.id)).toEqual([existing.item.id]);
    expect(during.issues).toEqual([]);
    expect((await validateSpecs({ root })).valid).toBe(true);
    releaseResolve?.();
    const published = await creating;
    expect((await showSpec({ root, id: published.item.id })).item.title).toBe("Concurrent");
  });

  it("isolates malformed archive roots from healthy live rows and exact show", async () => {
    const root = await workspace("Malformed archive root");
    const first = await createSpec({
      root,
      title: "First",
      scope: "project",
      strength: "required",
    });
    const second = await createSpec({
      root,
      title: "Second",
      scope: "project",
      strength: "required",
    });
    const archive = path.join(root, "project", "specs", "archive");
    await writeFile(archive, "not a directory", "utf8");

    for (const result of [
      await listSpecs({ root, archived: "all" }),
      await validateSpecs({ root }),
    ]) {
      expect(result.issues).toEqual([expect.objectContaining({ path: "project/specs/archive" })]);
    }
    expect((await listSpecs({ root, archived: "all" })).items.map((item) => item.id)).toEqual([
      first.item.id,
      second.item.id,
    ]);
    expect((await showSpec({ root, id: first.item.id })).item.id).toBe(first.item.id);

    await rm(archive, { force: true });
    const outside = fixturePath("assay-spec-archive");
    roots.push(outside);
    await mkdir(outside);
    await symlink(outside, archive, "junction");
    const redirected = await listSpecs({ root, archived: "all" });
    expect(redirected.items.map((item) => item.id)).toEqual([first.item.id, second.item.id]);
    expect(redirected.issues).toEqual([
      expect.objectContaining({
        code: "SPEC_STORAGE_BOUNDARY",
        path: "project/specs/archive",
      }),
    ]);
    expect((await showSpec({ root, id: second.item.id })).item.id).toBe(second.item.id);

    const malformedLiveRoot = await workspace("Malformed live root");
    await rm(path.join(malformedLiveRoot, "project", "specs"), { recursive: true, force: true });
    await writeFile(path.join(malformedLiveRoot, "project", "specs"), "not a directory", "utf8");
    const liveList = await listSpecs({ root: malformedLiveRoot, archived: "all" });
    expect(liveList.items).toEqual([]);
    expect(liveList.issues).toEqual([expect.objectContaining({ path: "project/specs" })]);
    expect((await validateSpecs({ root: malformedLiveRoot })).issues).toEqual([
      expect.objectContaining({ path: "project/specs" }),
    ]);
  });

  it("emits one cycle diagnostic per member", async () => {
    const root = await workspace("Cycle diagnostics");
    const left = await createSpec({ root, title: "Left", scope: "project", strength: "required" });
    const right = await createSpec({
      root,
      title: "Right",
      scope: "project",
      strength: "required",
    });
    for (const [record, successor] of [
      [left, right.item.id],
      [right, left.item.id],
    ] as const) {
      const file = specFile(root, record.item.id);
      const raw = parse(await readFile(file, "utf8")) as Record<string, unknown>;
      raw.state = "retired";
      raw.superseded_by = [successor];
      raw.revision = 1;
      raw.updated_at = new Date().toISOString();
      await writeFile(file, stringify(raw), "utf8");
    }
    const validation = await validateSpecs({ root });
    for (const id of [left.item.id, right.item.id]) {
      const record = validation.items.find((item) => item.id === id);
      expect(record?.issues.filter((issue) => issue.code === "SPEC_RELATION_CYCLE")).toHaveLength(
        1,
      );
    }
  });

  it("detects external metadata/body/source edits at publication boundaries", async () => {
    const root = await workspace("Conflicts");
    const spec = await createSpec({ root, title: "Race", scope: "project", strength: "required" });
    setSpecMutationProbeForTests(async () => {
      const raw = parse(await readFile(specFile(root, spec.item.id), "utf8")) as Record<
        string,
        unknown
      >;
      raw.title = "external";
      await writeFile(specFile(root, spec.item.id), stringify(raw), "utf8");
    });
    await expect(updateSpec({ root, id: spec.item.id, title: "Assay" })).rejects.toMatchObject({
      code: "SPEC_CONFLICT",
    });
    setSpecMutationProbeForTests(undefined);

    await writeFile(bodyFile(root, spec.item.id), validBody, "utf8");
    await activateSpec({ root, id: spec.item.id });
    await retireSpec({ root, id: spec.item.id });
    setSpecArchiveProbeForTests(async () => {
      await writeFile(bodyFile(root, spec.item.id), `${validBody}\nexternal`, "utf8");
    });
    await expect(archiveSpec({ root, id: spec.item.id })).rejects.toMatchObject({
      code: "SPEC_CONFLICT",
    });

    const analysis = await createAnalysis({ root, title: "Race analysis" });
    const body = path.join(root, "promotion-body.md");
    await writeFile(body, validBody, "utf8");
    setSpecPromotionProbeForTests(async () => {
      await writeFile(path.join(root, analysis.path), "external", "utf8");
    });
    await expect(
      promoteSpec({
        root,
        title: "Race promotion",
        scope: "project",
        strength: "required",
        bodyFile: body,
        fromAnalysis: analysis.path,
      }),
    ).rejects.toMatchObject({ code: "SPEC_CONFLICT" });
  });

  it("rejects invalid UTF-8 and redirected body or provenance files", async () => {
    const root = await workspace("File boundaries");
    const draft = await createSpec({
      root,
      title: "Invalid body",
      scope: "project",
      strength: "required",
    });
    await writeFile(bodyFile(root, draft.item.id), Buffer.from([0xff]));
    await expect(activateSpec({ root, id: draft.item.id })).rejects.toMatchObject({
      code: "SPEC_INVALID_ENCODING",
    });

    const analysisDirectory = path.join(root, "analyses", "references");
    await mkdir(analysisDirectory, { recursive: true });
    const outside = fixturePath("assay-spec-source");
    roots.push(outside);
    await mkdir(outside);
    await writeFile(path.join(outside, "source.md"), "outside", "utf8");
    await symlink(outside, path.join(root, "analyses", "redirect"), "junction");
    const cleanBody = path.join(root, "clean-body.md");
    await writeFile(cleanBody, validBody, "utf8");
    await expect(
      promoteSpec({
        root,
        title: "Redirected source",
        scope: "project",
        strength: "required",
        bodyFile: cleanBody,
        fromAnalysis: "analyses/redirect/source.md",
      }),
    ).rejects.toMatchObject({ code: "SPEC_STORAGE_BOUNDARY" });

    const bodyLinkDirectory = path.join(root, "body-link");
    await symlink(path.dirname(cleanBody), bodyLinkDirectory, "junction");
    const bodyLink = path.join(bodyLinkDirectory, path.basename(cleanBody));
    await expect(
      promoteSpec({
        root,
        title: "Redirected body",
        scope: "project",
        strength: "required",
        bodyFile: bodyLink,
        fromAnalysis: "analyses/redirect/source.md",
      }),
    ).rejects.toMatchObject({ code: "SPEC_BODY_INVALID" });
  });

  it("rejects unknown legacy contents and reparse redirects without overwriting", async () => {
    const root = await workspace("Boundaries");
    await mkdir(path.join(root, "project", "specs"), { recursive: true });
    await writeFile(path.join(root, "project", "specs", "legacy.txt"), "unknown", "utf8");
    await expect(
      createSpec({ root, title: "No", scope: "project", strength: "required" }),
    ).rejects.toMatchObject({ code: "SPEC_INVALID" });
    await rm(path.join(root, "project", "specs"), { recursive: true });
    const outside = fixturePath("assay-spec-outside");
    roots.push(outside);
    await mkdir(outside);
    await symlink(outside, path.join(root, "project", "specs"), "junction");
    await expect(
      createSpec({ root, title: "No", scope: "project", strength: "required" }),
    ).rejects.toMatchObject({ code: "SPEC_STORAGE_BOUNDARY" });
  });

  it("reports live/archive duplicate conflicts", async () => {
    const root = await workspace("Duplicates");
    const spec = await retireSpec({
      root,
      id: (await createSpec({ root, title: "Old", scope: "project", strength: "required" })).item
        .id,
    });
    await archiveSpec({ root, id: spec.item.id });
    await cp(
      path.join(root, "project", "specs", "archive", spec.item.id),
      path.join(root, "project", "specs", spec.item.id),
      { recursive: true },
    );
    await expect(showSpec({ root, id: spec.item.id })).rejects.toMatchObject({
      code: "SPEC_CONFLICT",
    });
    expect((await validateSpecs({ root, id: spec.item.id })).valid).toBe(false);
  });

  it("validates exact Project and registered System scopes", async () => {
    const root = await workspace("Scopes");
    await registerSystem(root, { name: "api", path: "systems/api" });
    expect(
      (
        await createSpec({
          root,
          title: "System contract",
          scope: "system:api",
          strength: "required",
        })
      ).item.scope,
    ).toEqual({ kind: "system", id: "api" });
    await expect(
      createSpec({ root, title: "Missing", scope: "system:missing", strength: "required" }),
    ).rejects.toMatchObject({ code: "SPEC_SCOPE_INVALID" });
  });

  it("propagates an r2 System cutover fault from scope validation without writes", async () => {
    const root = await workspace("Scope cutover");
    await registerSystem(root, { name: "api", path: "systems/api" });
    const spec = await createSpec({
      root,
      title: "System scoped requirement",
      scope: "system:api",
      strength: "required",
    });
    const registryFile = path.join(root, ".absorb", "systems-registry.json");
    const oldRegistry = {
      __schema: 2,
      primary: "api",
      systems: {
        api: {
          name: "api",
          path: "systems/api",
          status: "primary",
          vcs: "embedded",
          vcs_ref: "",
          version: "0.1.0",
          contract_file: "systems/api/system.yaml",
          supersedes: [],
          absorbed_on: null,
          archived_on: null,
          archive_path: null,
        },
      },
      updated_at: "2026-08-08T00:00:00.000Z",
    };
    await writeFile(registryFile, `${JSON.stringify(oldRegistry)}\n`, "utf8");
    const before = await readFile(registryFile, "utf8");
    const entriesBefore = (await readdir(path.join(root, ".absorb"))).sort();

    for (const operation of [
      () => validateSpecs({ root, id: spec.item.id }),
      () => listSpecs({ root, scope: "system:api" }),
      () => showSpec({ root, id: spec.item.id }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "WORKSPACE_CUTOVER_REQUIRED",
        observed: "0.14.0+s4+l8+r2",
        required: "0.14.0+s4+l8+r3",
      });
    }
    expect(await readFile(registryFile, "utf8")).toBe(before);
    expect((await readdir(path.join(root, ".absorb"))).sort()).toEqual(entriesBefore);
  });

  it("serializes concurrent allocation without duplicate ids", async () => {
    const root = await workspace("Concurrent allocation");
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createSpec({ root, title: `Concurrent ${index}`, scope: "project", strength: "required" }),
      ),
    );
    expect(new Set(created.map((record) => record.item.id)).size).toBe(8);
    expect(
      created
        .map((record) => readableSequence(record.item.id, "spec"))
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
