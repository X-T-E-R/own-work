import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
  pathExists,
} from "./helpers.js";

const tempDirs = createTempDirectoryFixture("assay-system-cli");
let registryRoot = "";
let cliRunner: BuiltCliRunner;

async function tempDir(): Promise<string> {
  return tempDirs.createTempDir();
}

async function runCli(args: readonly string[]) {
  return cliRunner.runCli(args);
}

afterEach(async () => {
  await tempDirs.cleanup();
});

beforeEach(async () => {
  registryRoot = await createIsolatedRegistryRoot(tempDirs);
  cliRunner = createBuiltCliRunner({ registryRoot });
});

async function initWorkspace(name: string): Promise<string> {
  return createInitializedCliWorkspace({ tempDirs, runner: cliRunner, directoryName: name });
}

describe("assay system CLI", () => {
  it("exposes system command help with all subcommands", async () => {
    const result = await runCli(["system", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("System registry operations");
    for (const sub of ["register", "update", "promote", "archive", "list", "show"]) {
      expect(result.stdout).toContain(sub);
    }
    expect(result.stderr).toBe("");
  });

  it("exposes system update help with metadata flags", async () => {
    const result = await runCli(["system", "update", "--help"]);

    expect(result.exitCode).toBe(0);
    for (const flag of [
      "--path",
      "--vcs",
      "--vcs-ref",
      "--system-version",
      "--supersedes",
      "--primary",
    ]) {
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).not.toContain("intent-authority");
    expect(result.stdout).not.toContain("intent-pointer");
    expect(result.stdout).not.toContain("contract-file");
    expect(result.stderr).toBe("");
  });

  it("register creates a registry entry and event without a sidecar", async () => {
    const root = await initWorkspace("Register");
    const systemPath = path.join(root, "systems", "demo-core");
    await mkdir(systemPath, { recursive: true });

    const result = await runCli([
      "system",
      "register",
      "systems/demo-core",
      "--root",
      root,
      "--vcs",
      "embedded",
      "--system-version",
      "0.2.0",
      "--primary",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Registered system: demo-core");
    expect(result.stdout).toContain("Status: primary");
    expect(result.stdout).not.toContain("Contract:");
    expect(result.stdout).toContain("Event: .absorb/events/");
    expect(await pathExists(path.join(root, ".absorb", "systems-registry.json"))).toBe(true);
    expect(await pathExists(path.join(root, "systems", "demo-core", "system.yaml"))).toBe(false);

    const check = await runCli(["check", "--root", root]);
    expect(check.exitCode).toBe(0);
    expect(check.stdout).not.toContain("contract file missing");
  });

  it("register rejects duplicate system names", async () => {
    const root = await initWorkspace("Dupe");
    await mkdir(path.join(root, "systems", "dupe"), { recursive: true });
    await runCli(["system", "register", "systems/dupe", "--root", root, "--name", "dupe"]);

    const second = await runCli([
      "system",
      "register",
      "systems/dupe-2",
      "--root",
      root,
      "--name",
      "dupe",
    ]);

    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("already registered");
  });

  it("update corrects vcs metadata and preserves omitted fields", async () => {
    const root = await initWorkspace("UpdateVcs");
    await mkdir(path.join(root, "systems", "skill-creator"), { recursive: true });
    await mkdir(path.join(root, "systems", "old-skill"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/old-skill",
      "--root",
      root,
      "--name",
      "old-skill",
    ]);
    await runCli([
      "system",
      "register",
      "systems/skill-creator",
      "--root",
      root,
      "--name",
      "skill-creator",
      "--vcs",
      "embedded",
      "--system-version",
      "0.2.0",
      "--supersedes",
      "old-skill",
    ]);

    const result = await runCli([
      "system",
      "update",
      "skill-creator",
      "--root",
      root,
      "--vcs",
      "independent-git",
      "--vcs-ref",
      "main",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Updated system: skill-creator");
    expect(result.stdout).toContain("Status: active");
    expect(result.stdout).toContain("Registry: .absorb/systems-registry.json");
    expect(result.stdout).toContain("Changed fields: vcs, vcs_ref");
    expect(result.stdout).toContain("Event: .absorb/events/");

    const show = await runCli(["system", "show", "skill-creator", "--root", root, "--json"]);
    expect(show.exitCode).toBe(0);
    expect(JSON.parse(show.stdout)).toMatchObject({
      selector: "skill-creator",
      path: "systems/skill-creator",
      status: "active",
      vcs: "independent-git",
      vcs_ref: "main",
      version: "0.2.0",
      supersedes: ["old-skill"],
    });
  });

  it("list shows systems sorted with primary marked", async () => {
    const root = await initWorkspace("ListSystems");
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await mkdir(path.join(root, "systems", "beta"), { recursive: true });
    await runCli(["system", "register", "systems/beta", "--root", root, "--name", "beta"]);
    await runCli([
      "system",
      "register",
      "systems/alpha",
      "--root",
      root,
      "--name",
      "alpha",
      "--primary",
      "--supersedes",
      "beta",
    ]);

    const result = await runCli(["system", "list", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("* primary");
    expect(result.stdout).toContain("alpha");
    expect(result.stdout).toContain("beta");
    expect(result.stdout).toContain("supersedes beta");
    // alpha (primary) should appear before beta (active)
    expect(result.stdout.indexOf("alpha")).toBeLessThan(result.stdout.indexOf("beta"));
  });

  it("list --json emits structured output", async () => {
    const root = await initWorkspace("ListJson");
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/alpha",
      "--root",
      root,
      "--name",
      "alpha",
      "--primary",
    ]);

    const result = await runCli(["system", "list", "--root", root, "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.primary).toBe("alpha");
    expect(parsed.systems).toHaveLength(1);
    expect(parsed.systems[0]).toMatchObject({ selector: "alpha", status: "primary" });
  });

  it("list --status filters by status", async () => {
    const root = await initWorkspace("ListFilter");
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await mkdir(path.join(root, "systems", "beta"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/alpha",
      "--root",
      root,
      "--name",
      "alpha",
      "--primary",
    ]);
    await runCli(["system", "register", "systems/beta", "--root", root, "--name", "beta"]);

    const result = await runCli(["system", "list", "--root", root, "--status", "primary"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("alpha");
    expect(result.stdout).not.toContain("beta\n");
  });

  it("show returns details only by the exact selector", async () => {
    const root = await initWorkspace("Show");
    await mkdir(path.join(root, "systems", "alpha-core"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/alpha-core",
      "--root",
      root,
      "--name",
      "alpha-core",
      "--primary",
      "--vcs",
      "independent-git",
      "--vcs-ref",
      "main",
    ]);

    const byName = await runCli(["system", "show", "alpha-core", "--root", root]);
    expect(byName.exitCode).toBe(0);
    expect(byName.stdout).toContain("alpha-core (primary)");
    expect(byName.stdout).toContain("independent-git@main");

    const byPrefix = await runCli(["system", "show", "alpha", "--root", root]);
    expect(byPrefix.exitCode).toBe(1);
    expect(byPrefix.stderr).toContain("system not found");
  });

  it("show --json emits structured output", async () => {
    const root = await initWorkspace("ShowJson");
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/alpha",
      "--root",
      root,
      "--name",
      "alpha",
      "--primary",
    ]);

    const result = await runCli(["system", "show", "alpha", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ selector: "alpha", status: "primary" });
  });

  it("promote demotes the previous primary to superseded", async () => {
    const root = await initWorkspace("Promote");
    await mkdir(path.join(root, "systems", "a"), { recursive: true });
    await mkdir(path.join(root, "systems", "b"), { recursive: true });
    await runCli(["system", "register", "systems/a", "--root", root, "--name", "a", "--primary"]);
    await runCli(["system", "register", "systems/b", "--root", root, "--name", "b"]);

    const result = await runCli(["system", "promote", "b", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Promoted: b");
    expect(result.stdout).toContain("Previous primary: a (now superseded)");

    const list = await runCli(["system", "list", "--root", root, "--json"]);
    const parsed = JSON.parse(list.stdout);
    expect(parsed.primary).toBe("b");
    const a = parsed.systems.find((s: { selector: string }) => s.selector === "a");
    expect(a.status).toBe("superseded");
  });

  it("archive dry-run reports a logical transition without moving files", async () => {
    const root = await initWorkspace("ArchiveDry");
    await mkdir(path.join(root, "systems", "active"), { recursive: true });
    await mkdir(path.join(root, "systems", "old"), { recursive: true });
    await writeFile(path.join(root, "systems", "old", "marker.txt"), "x", "utf8");
    await runCli([
      "system",
      "register",
      "systems/active",
      "--root",
      root,
      "--name",
      "active",
      "--primary",
    ]);
    await runCli(["system", "register", "systems/old", "--root", root, "--name", "old"]);

    const result = await runCli(["system", "archive", "old", "--root", root, "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(result.stdout).toContain("Archive mode: logical");
    expect(result.stdout).not.toContain("systems/archive/");
    // Source still present
    expect(await pathExists(path.join(root, "systems", "old", "marker.txt"))).toBe(true);
  });

  it("archive apply leaves the directory and marks system logically archived", async () => {
    const root = await initWorkspace("ArchiveApply");
    await mkdir(path.join(root, "systems", "active"), { recursive: true });
    await mkdir(path.join(root, "systems", "old"), { recursive: true });
    await writeFile(path.join(root, "systems", "old", "marker.txt"), "x", "utf8");
    await runCli([
      "system",
      "register",
      "systems/active",
      "--root",
      root,
      "--name",
      "active",
      "--primary",
    ]);
    await runCli(["system", "register", "systems/old", "--root", root, "--name", "old"]);

    const result = await runCli(["system", "archive", "old", "--root", root, "--apply"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("applied");
    expect(result.stdout).toContain("Archive mode: logical");
    expect(await pathExists(path.join(root, "systems", "old"))).toBe(true);

    const list = await runCli(["system", "list", "--root", root, "--json"]);
    const parsed = JSON.parse(list.stdout);
    const old = parsed.systems.find((s: { selector: string }) => s.selector === "old");
    expect(old.status).toBe("archived");
    expect(old).not.toHaveProperty("archive_path");
  });

  it("archive refuses to archive the primary system", async () => {
    const root = await initWorkspace("ArchivePrimary");
    await mkdir(path.join(root, "systems", "only"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/only",
      "--root",
      root,
      "--name",
      "only",
      "--primary",
    ]);

    const result = await runCli(["system", "archive", "only", "--root", root, "--apply"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot archive the primary system");
  });

  it("show returns non-zero for unknown system", async () => {
    const root = await initWorkspace("ShowMissing");
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    await runCli([
      "system",
      "register",
      "systems/alpha",
      "--root",
      root,
      "--name",
      "alpha",
      "--primary",
    ]);

    const result = await runCli(["system", "show", "nope", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("system not found");
  });

  it("list returns non-zero when no registry exists", async () => {
    const root = await initWorkspace("NoRegistry");

    const result = await runCli(["system", "list", "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No systems registry");
  });
});
