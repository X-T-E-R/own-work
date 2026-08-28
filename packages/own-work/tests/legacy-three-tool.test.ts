import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const legacyCli = process.env.ASSAY_V014_CLI;
const ownCli = path.resolve(process.cwd(), "dist/cli.js");
const absorbCli = path.resolve(
  process.cwd(),
  "../../../absorb-anything/packages/absorb-anything/dist/cli.js",
);
const roots: string[] = [];

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!legacyCli)("legacy .assay three-tool contract", { timeout: 120_000 }, () => {
  it("operates in place, preserves the old CLI before migration, and migrates once", async () => {
    const oldCli = legacyCli as string;
    const root = await mkdtemp(path.join(os.tmpdir(), "ownwork-legacy-"));
    roots.push(root);
    expect((await run(oldCli, ["init", root, "--name", "Legacy", "--no-agents"])).exitCode).toBe(0);
    expect(await exists(path.join(root, ".assay"))).toBe(true);
    expect(await exists(path.join(root, ".absorb"))).toBe(false);

    const oldTask = await run(oldCli, [
      "task",
      "create",
      "--title",
      "Legacy seed",
      "--root",
      root,
      "--json",
    ]);
    expect(oldTask.exitCode, oldTask.stderr).toBe(0);
    const oldTaskId = (JSON.parse(oldTask.stdout) as { task: { id: string } }).task.id;
    await mkdir(path.join(root, "systems", "app"), { recursive: true });
    expect(
      (
        await run(oldCli, [
          "system",
          "register",
          "systems/app",
          "--name",
          "app",
          "--primary",
          "--root",
          root,
        ])
      ).exitCode,
    ).toBe(0);

    const material = path.join(root, "legacy-material");
    await mkdir(material);
    await writeFile(path.join(material, "source.txt"), "legacy source\n", "utf8");
    expect(
      (await run(absorbCli, ["add", material, "legacy-source", "--root", root])).exitCode,
    ).toBe(0);
    const analysis = await run(absorbCli, [
      "analysis",
      "new",
      "Legacy analysis",
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
          "Legacy knowledge",
          "--from-analysis",
          analysisPath,
          "--root",
          root,
        ])
      ).exitCode,
    ).toBe(0);

    expect((await run(ownCli, ["init", root, "--no-agents"])).exitCode).toBe(0);
    const task = await run(ownCli, [
      "task",
      "create",
      "--title",
      "New tool task",
      "--root",
      root,
      "--json",
    ]);
    const taskId = (JSON.parse(task.stdout) as { task: { id: string } }).task.id;
    const roadmap = await run(ownCli, [
      "roadmap",
      "create",
      "--title",
      "Legacy roadmap",
      "--root",
      root,
      "--json",
    ]);
    const roadmapId = (JSON.parse(roadmap.stdout) as { item: { id: string } }).item.id;
    expect(
      (await run(ownCli, ["roadmap", "link-task", roadmapId, "--task", taskId, "--root", root]))
        .exitCode,
    ).toBe(0);
    const body = path.join(root, "legacy-spec.md");
    await writeFile(
      body,
      "## Purpose\n\nLegacy interop.\n\n## Scope\n\nWorkspace.\n\n## Requirements\n\n- Continue.\n\n## Constraints\n\n- In place.\n\n## Acceptance Criteria\n\n- Three tools run.\n\n## Non-Goals\n\n- Reverse migration.\n",
      "utf8",
    );
    expect(
      (
        await run(ownCli, [
          "spec",
          "promote",
          "--title",
          "Legacy Spec",
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

    for (const cli of [absorbCli, ownCli]) {
      for (const command of [["check"], ["status"], ["prime"]] as const) {
        const result = await run(cli, [...command, "--root", root]);
        expect(
          result.exitCode,
          `${cli} ${command.join(" ")}\n${result.stderr}\n${result.stdout}`,
        ).toBe(0);
      }
    }
    expect(await exists(path.join(root, ".absorb"))).toBe(false);
    expect(await exists(path.join(root, ".assay"))).toBe(true);

    expect((await run(oldCli, ["status", "--root", root])).exitCode).toBe(0);
    expect((await run(oldCli, ["check", "--root", root])).exitCode).toBe(0);
    expect(
      (await run(oldCli, ["task", "show", oldTaskId, "--root", root, "--json"])).exitCode,
    ).toBe(0);
    expect(
      (await run(oldCli, ["task", "create", "--title", "Legacy continues", "--root", root]))
        .exitCode,
    ).toBe(0);
    expect(await exists(path.join(root, ".absorb"))).toBe(false);

    const migrated = await run(ownCli, ["migrate-envelope", "--root", root, "--json"]);
    expect(migrated.exitCode, migrated.stderr).toBe(0);
    expect((JSON.parse(migrated.stdout) as { changed: boolean }).changed).toBe(true);
    expect(await exists(path.join(root, ".absorb"))).toBe(true);
    expect(await exists(path.join(root, ".assay"))).toBe(false);
    expect(
      (
        JSON.parse(
          (await run(absorbCli, ["migrate-envelope", "--root", root, "--json"])).stdout,
        ) as { changed: boolean }
      ).changed,
    ).toBe(false);
    expect(
      (
        JSON.parse((await run(ownCli, ["migrate-envelope", "--root", root, "--json"])).stdout) as {
          changed: boolean;
        }
      ).changed,
    ).toBe(false);

    for (const cli of [absorbCli, ownCli]) {
      for (const command of [["check"], ["status"], ["prime"]] as const)
        expect((await run(cli, [...command, "--root", root])).exitCode).toBe(0);
    }
    expect(
      (await run(ownCli, ["task", "create", "--title", "After migration", "--root", root]))
        .exitCode,
    ).toBe(0);
    expect(
      (await run(absorbCli, ["add", material, "after-migration", "--root", root])).exitCode,
    ).toBe(0);

    await mkdir(path.join(root, ".assay"));
    const conflict = await run(ownCli, ["migrate-envelope", "--root", root]);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain("Both .absorb and .assay exist");
    expect(await readFile(path.join(root, ".absorb", "manifest.json"), "utf8")).toContain(
      '"framework_version": "0.14.0"',
    );
  });
});
