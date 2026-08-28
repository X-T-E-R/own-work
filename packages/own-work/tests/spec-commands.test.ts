import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BuiltCliRunner,
  createBuiltCliRunner,
  createInitializedCliWorkspace,
  createIsolatedRegistryRoot,
  createTempDirectoryFixture,
} from "./helpers.js";

const tempDirs = createTempDirectoryFixture("assay-spec-cli");
let cliRunner: BuiltCliRunner;

beforeEach(async () => {
  cliRunner = createBuiltCliRunner({ registryRoot: await createIsolatedRegistryRoot(tempDirs) });
});

afterEach(async () => tempDirs.cleanup());

async function workspace(): Promise<string> {
  return createInitializedCliWorkspace({
    tempDirs,
    runner: cliRunner,
    directoryName: "spec",
    bare: true,
  });
}

const body = `## Purpose

CLI behavior.

## Scope

Spec commands.

## Requirements

- Explicit lifecycle.

## Constraints

- No approval aliases.

## Acceptance Criteria

- Commands succeed.

## Non-Goals

- Automatic activation.
`;

describe("assay spec CLI", { timeout: 60_000 }, () => {
  it("exposes only the frozen lifecycle surface and runs a real flow", async () => {
    const root = await workspace();
    const help = await cliRunner.runCli(["spec", "--help"]);
    expect(help.exitCode, help.stderr).toBe(0);
    for (const name of [
      "create",
      "promote",
      "show",
      "list",
      "update",
      "activate",
      "retire",
      "replace",
      "archive",
      "validate",
    ])
      expect(help.stdout).toContain(name);
    for (const forbidden of ["accept", "supersede", "deprecate", "current", "delete"]) {
      expect(help.stdout).not.toContain(forbidden);
    }

    const created = await cliRunner.runCli([
      "spec",
      "create",
      "--title",
      "CLI contract",
      "--scope",
      "project",
      "--strength",
      "required",
      "--root",
      root,
      "--json",
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    const record = JSON.parse(created.stdout) as {
      item: { id: string; state: string; revision: number };
      path: string;
    };
    expect(record.item).toMatchObject({ id: "spec-0001-cli-contract", state: "draft" });
    await writeFile(path.join(root, record.path, "specification.md"), body, "utf8");

    const active = await cliRunner.runCli([
      "spec",
      "activate",
      record.item.id,
      "--expected-revision",
      "0",
      "--root",
      root,
      "--json",
    ]);
    expect(active.exitCode, active.stderr).toBe(0);
    expect((JSON.parse(active.stdout) as { item: { state: string } }).item.state).toBe("active");
    const retired = await cliRunner.runCli([
      "spec",
      "retire",
      record.item.id,
      "--root",
      root,
      "--json",
    ]);
    expect(retired.exitCode, retired.stderr).toBe(0);
    const archived = await cliRunner.runCli([
      "spec",
      "archive",
      record.item.id,
      "--root",
      root,
      "--json",
    ]);
    expect(archived.exitCode, archived.stderr).toBe(0);
    expect((JSON.parse(archived.stdout) as { archived: boolean }).archived).toBe(true);
  });

  it("promotes only an explicit source plus independent body and reports invalid combinations", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "analyses", "references"), { recursive: true });
    await writeFile(
      path.join(root, "analyses", "references", "source.md"),
      "analysis bytes",
      "utf8",
    );
    const bodyFile = path.join(root, "body.md");
    await writeFile(bodyFile, body, "utf8");
    const promoted = await cliRunner.runCli([
      "spec",
      "promote",
      "--title",
      "Promoted",
      "--scope",
      "project",
      "--strength",
      "recommended",
      "--from-analysis",
      "analyses/references/source.md",
      "--body",
      bodyFile,
      "--root",
      root,
      "--json",
    ]);
    expect(promoted.exitCode, promoted.stderr).toBe(0);
    const result = JSON.parse(promoted.stdout) as {
      item: { state: string; derived_from: unknown[] };
    };
    expect(result.item.state).toBe("draft");
    expect(result.item.derived_from).toHaveLength(1);

    const invalid = await cliRunner.runCli([
      "spec",
      "promote",
      "--title",
      "Invalid",
      "--scope",
      "project",
      "--strength",
      "required",
      "--from-analysis",
      "analyses/references/source.md",
      "--from-task",
      "task-0001-missing",
      "--task-file",
      "prd.md",
      "--body",
      bodyFile,
      "--root",
      root,
    ]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("SPEC_PROVENANCE_INVALID");
  });
});
