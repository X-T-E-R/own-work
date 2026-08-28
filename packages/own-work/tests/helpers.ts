import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export function fixtureRoot(): string {
  const root = path.join(tmpdir(), `own-work-test-fixtures-${process.pid}`);
  mkdirSync(root, { recursive: true });
  return root;
}
export function fixturePath(name: string): string {
  return path.join(fixtureRoot(), `${name}-${randomUUID()}`);
}
export interface TempDirectoryFixture {
  readonly roots: readonly string[];
  createTempDir(): Promise<string>;
  cleanup(): Promise<void>;
}
export function createTempDirectoryFixture(prefix: string): TempDirectoryFixture {
  const roots: string[] = [];
  return {
    get roots() {
      return [...roots];
    },
    async createTempDir() {
      await mkdir(fixtureRoot(), { recursive: true });
      const root = await mkdtemp(path.join(fixtureRoot(), `${prefix}-`));
      roots.push(root);
      return root;
    },
    async cleanup() {
      await Promise.all(
        roots
          .splice(0)
          .map((root) =>
            rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
          ),
      );
    },
  };
}
export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
export async function writeBareTemplate(root: string): Promise<string> {
  const descriptor = `${root}.template.yaml`;
  await mkdir(path.dirname(descriptor), { recursive: true });
  await writeFile(
    descriptor,
    "__schema: 1\ndescription: Shared core only.\ndirectories: []\nfiles: []\n",
    "utf8",
  );
  return descriptor;
}
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface BuiltCliRunner {
  readonly packageRoot: string;
  readonly cliPath: string;
  runCli(
    args: readonly string[],
    options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
  ): Promise<CliResult>;
  runCliIn(
    cwd: string,
    args: readonly string[],
    options?: { readonly env?: NodeJS.ProcessEnv },
  ): Promise<CliResult>;
}
export function createBuiltCliRunner(
  options: {
    readonly packageRoot?: string;
    readonly cliPath?: string;
    readonly registryRoot?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): BuiltCliRunner {
  const packageRoot = options.packageRoot ?? process.cwd();
  const cliPath = options.cliPath ?? path.join(packageRoot, "dist", "cli.js");
  async function runCliIn(
    cwd: string,
    args: readonly string[],
    runOptions: { readonly env?: NodeJS.ProcessEnv } = {},
  ): Promise<CliResult> {
    try {
      const result = await execFileAsync(process.execPath, [cliPath, ...args], {
        cwd,
        env: { ...process.env, ...options.env, ...runOptions.env },
      });
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
  return {
    packageRoot,
    cliPath,
    runCli: (args, runOptions = {}) =>
      runCliIn(runOptions.cwd ?? packageRoot, args, runOptions.env ? { env: runOptions.env } : {}),
    runCliIn,
  };
}
export async function createIsolatedRegistryRoot(
  tempDirs: TempDirectoryFixture,
  directoryName = "registry",
): Promise<string> {
  return path.join(await tempDirs.createTempDir(), directoryName);
}
export async function createInitializedCliWorkspace(options: {
  readonly tempDirs: TempDirectoryFixture;
  readonly runner: BuiltCliRunner;
  readonly directoryName: string;
  readonly projectName?: string;
  readonly bare?: boolean;
  readonly extraArgs?: readonly string[];
}): Promise<string> {
  const root = path.join(await options.tempDirs.createTempDir(), options.directoryName);
  const result = await options.runner.runCli([
    "init",
    root,
    "--name",
    options.projectName ?? options.directoryName,
    "--standalone",
    "--no-agents",
    ...(options.extraArgs ?? []),
  ]);
  if (result.exitCode !== 0) throw new Error(`Expected ownwork init to succeed: ${result.stderr}`);
  return root;
}
