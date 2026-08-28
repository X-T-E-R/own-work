import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const cli = path.join(repo, "packages", "own-work", "dist", "cli.js");
const pkg = JSON.parse(
  await readFile(path.join(repo, "packages", "own-work", "package.json"), "utf8"),
);
const temp = await mkdtemp(path.join(os.tmpdir(), "ownwork-smoke-"));
async function run(args, expected = 0) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args]);
    if (expected !== 0)
      throw new Error(`expected exit ${expected}, got 0: ownwork ${args.join(" ")}`);
    return result;
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number") {
      if (error.code !== expected)
        throw new Error(
          `expected exit ${expected}, got ${error.code}: ownwork ${args.join(" ")}\n${error.stderr ?? ""}`,
        );
      return error;
    }
    throw error;
  }
}
try {
  const version = (await run(["--version"])).stdout.trim();
  if (version !== pkg.version)
    throw new Error(`CLI version ${version} != package version ${pkg.version}`);
  const help = (await run(["--help"])).stdout;
  for (const command of [
    "init",
    "check",
    "status",
    "migrate-envelope",
    "prime",
    "explain",
    "task",
    "roadmap",
    "spec",
    "system",
  ])
    if (!help.includes(command)) throw new Error(`root help is missing ${command}`);
  const root = path.join(temp, "workspace");
  await run(["init", root, "--name", "Smoke", "--no-agents"]);
  await run(["check", "--root", root]);
  await run(["status", "--root", root]);
  await run(["prime", "--root", root]);
  await run(["explain", "task"]);
  const task = JSON.parse(
    (await run(["task", "create", "--title", "Smoke task", "--root", root, "--json"])).stdout,
  );
  const roadmap = JSON.parse(
    (await run(["roadmap", "create", "--title", "Smoke roadmap", "--root", root, "--json"])).stdout,
  );
  await run(["roadmap", "link-task", roadmap.item.id, "--task", task.task.id, "--root", root]);
  const body = path.join(temp, "spec.md");
  await writeFile(
    body,
    "## Purpose\n\nSmoke.\n\n## Scope\n\nCLI.\n\n## Requirements\n\n- Run.\n\n## Constraints\n\n- Local.\n\n## Acceptance Criteria\n\n- Pass.\n\n## Non-Goals\n\n- Publish.\n",
    "utf8",
  );
  await run([
    "spec",
    "promote",
    "--title",
    "Smoke Spec",
    "--scope",
    "project",
    "--strength",
    "required",
    "--from-task",
    task.task.id,
    "--task-file",
    "prd.md",
    "--body",
    body,
    "--root",
    root,
  ]);
  await run(["system", "list", "--root", root]);
  await run(["task", "show", "not-a-task", "--root", root], 1);
  await mkdir(path.join(root, ".assay"));
  await run(["migrate-envelope", "--root", root], 1);
  console.log(`ownwork smoke passed (${pkg.version})`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
