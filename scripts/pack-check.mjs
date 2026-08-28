import { exec, execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const repo = path.resolve(import.meta.dirname, "..");
const destination = await mkdtemp(path.join(os.tmpdir(), "ownwork-pack-"));
try {
  const pnpmArgs = ["--filter", "own-work", "pack", "--pack-destination", destination];
  if (process.platform === "win32") {
    await execAsync(`pnpm --filter own-work pack --pack-destination "${destination}"`, {
      cwd: repo,
    });
  } else {
    await execFileAsync("pnpm", pnpmArgs, { cwd: repo });
  }
  const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1)
    throw new Error(`expected one package archive, found ${archives.join(", ")}`);
  const { stdout } = await execFileAsync("tar", ["-tf", path.join(destination, archives[0])]);
  const files = stdout.trim().split(/\r?\n/).sort();
  for (const required of [
    "package/LICENSE",
    "package/README.md",
    "package/package.json",
    "package/dist/cli.js",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ])
    if (!files.includes(required)) throw new Error(`package is missing ${required}`);
  const unexpected = files.filter(
    (file) =>
      !file.startsWith("package/dist/") &&
      !["package/LICENSE", "package/README.md", "package/package.json"].includes(file),
  );
  if (unexpected.length > 0) throw new Error(`unexpected package files: ${unexpected.join(", ")}`);
  console.log(`pack check passed (${files.length} files)`);
} finally {
  await rm(destination, { recursive: true, force: true });
}
