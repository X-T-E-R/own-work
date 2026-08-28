import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const ownCli = path.resolve(process.cwd(), "dist/cli.js");
const absorbCli = path.resolve(
  process.cwd(),
  "../../../absorb-anything/packages/absorb-anything/dist/cli.js",
);

async function run(cli: string, args: readonly string[]) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args]);
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number")
      return {
        exitCode: error.code,
        stdout: "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
        stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
      };
    throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function byteLedger(root: string, relativeRoots: readonly string[]) {
  const ledger: Record<string, string> = {};
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(relative, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile())
        ledger[child] = createHash("sha256")
          .update(await readFile(path.join(root, child)))
          .digest("hex");
    }
  };
  for (const relative of relativeRoots) await visit(relative);
  return ledger;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mixed product envelope contract", { timeout: 120_000 }, () => {
  it("keeps absorb-owned and own-work-owned bytes isolated in one .absorb envelope", async () => {
    expect(await exists(absorbCli)).toBe(true);
    const root = await mkdtemp(path.join(os.tmpdir(), "ownwork-mixed-"));
    roots.push(root);
    const material = path.join(root, "material-input");
    await mkdir(material);
    await writeFile(path.join(material, "note.txt"), "source bytes\n", "utf8");

    expect((await run(absorbCli, ["init", root, "--name", "Mixed", "--no-agents"])).exitCode).toBe(
      0,
    );
    expect((await run(absorbCli, ["add", material, "sample", "--root", root])).exitCode).toBe(0);
    const analysis = await run(absorbCli, [
      "analysis",
      "new",
      "Decision",
      "--root",
      root,
      "--json",
    ]);
    expect(analysis.exitCode, analysis.stderr).toBe(0);
    const analysisPath = (JSON.parse(analysis.stdout) as { path: string }).path;
    expect(
      (
        await run(absorbCli, [
          "knowledge",
          "add",
          "pattern",
          "Kept",
          "--from-analysis",
          analysisPath,
          "--root",
          root,
        ])
      ).exitCode,
    ).toBe(0);
    const absorbBefore = await byteLedger(root, [
      ".absorb/sources",
      ".absorb/analyses",
      ".absorb/knowledge",
    ]);

    expect((await run(ownCli, ["init", root, "--name", "Mixed", "--no-agents"])).exitCode).toBe(0);
    const taskResult = await run(ownCli, [
      "task",
      "create",
      "--title",
      "Build",
      "--root",
      root,
      "--json",
    ]);
    expect(taskResult.exitCode, taskResult.stderr).toBe(0);
    const taskId = (JSON.parse(taskResult.stdout) as { task: { id: string } }).task.id;
    const roadmapResult = await run(ownCli, [
      "roadmap",
      "create",
      "--title",
      "Ship",
      "--root",
      root,
      "--json",
    ]);
    const roadmapId = (JSON.parse(roadmapResult.stdout) as { item: { id: string } }).item.id;
    expect(
      (await run(ownCli, ["roadmap", "link-task", roadmapId, "--task", taskId, "--root", root]))
        .exitCode,
    ).toBe(0);
    const body = path.join(root, "spec-body.md");
    await writeFile(
      body,
      "## Purpose\n\nMixed contract.\n\n## Scope\n\nWorkspace.\n\n## Requirements\n\n- Keep peers.\n\n## Constraints\n\n- Shared envelope.\n\n## Acceptance Criteria\n\n- Checks pass.\n\n## Non-Goals\n\n- None.\n",
      "utf8",
    );
    expect(
      (
        await run(ownCli, [
          "spec",
          "promote",
          "--title",
          "Mixed Spec",
          "--scope",
          "project",
          "--strength",
          "required",
          "--from-task",
          taskId,
          "--task-file",
          "prd.md",
          "--body",
          body,
          "--root",
          root,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      await byteLedger(root, [".absorb/sources", ".absorb/analyses", ".absorb/knowledge"]),
    ).toEqual(absorbBefore);

    const ownBefore = await byteLedger(root, [
      ".absorb/tasks",
      ".absorb/project/roadmap",
      ".absorb/project/specs",
    ]);
    for (const command of [["check"], ["status"], ["prime"]] as const) {
      const result = await run(absorbCli, [...command, "--root", root]);
      expect(result.exitCode, result.stderr).toBe(0);
    }
    expect(
      await byteLedger(root, [".absorb/tasks", ".absorb/project/roadmap", ".absorb/project/specs"]),
    ).toEqual(ownBefore);
    expect((await run(ownCli, ["check", "--root", root])).exitCode).toBe(0);
    expect((await run(ownCli, ["status", "--root", root])).exitCode).toBe(0);
    expect((await run(ownCli, ["prime", "--root", root])).exitCode).toBe(0);
    expect(await exists(path.join(root, ".absorb"))).toBe(true);
    expect(await exists(path.join(root, ".assay"))).toBe(false);

    const foreignAdoptions = path.join(root, ".absorb", "source-adoptions");
    await mkdir(foreignAdoptions, { recursive: true });
    await writeFile(path.join(foreignAdoptions, "bad.yaml"), "bad", "utf8");
    expect((await run(ownCli, ["check", "--root", root])).exitCode).toBe(0);

    const sourceRecord = path.join(root, ".absorb", "sources", "sample", "source.yaml");
    const validSourceRecord = await readFile(sourceRecord);
    await writeFile(sourceRecord, "bad", "utf8");
    const ownCheckWithBadSource = await run(ownCli, ["check", "--root", root]);
    expect(ownCheckWithBadSource.exitCode, ownCheckWithBadSource.stderr).toBe(0);
    expect((await run(absorbCli, ["check", "--root", root])).exitCode).toBe(1);
    await writeFile(sourceRecord, validSourceRecord);

    await mkdir(path.join(root, ".absorb", "tasks", "task-9999-bad"), { recursive: true });
    await writeFile(
      path.join(root, ".absorb", "tasks", "task-9999-bad", "task.json"),
      "bad",
      "utf8",
    );
    expect((await run(absorbCli, ["check", "--root", root])).exitCode).toBe(0);
    const ownCheck = await run(ownCli, ["check", "--root", root]);
    expect(ownCheck.exitCode).toBe(1);
    expect(ownCheck.stdout).toContain("task-9999-bad");
  });
});
