import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly "working-directory"?: string;
};

describe("hosted CI contract", () => {
  it("installs pnpm before Node cache setup and builds both sibling dependencies", async () => {
    const repository = path.resolve(process.cwd(), "../..");
    const workflow = parse(
      await readFile(path.join(repository, ".github", "workflows", "ci.yml"), "utf8"),
    ) as { jobs: { check: { strategy: { matrix: { os: string[] } }; steps: Step[] } } };
    const steps = workflow.jobs.check.steps;

    expect(workflow.jobs.check.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
    expect(steps.findIndex((step) => step.uses === "pnpm/action-setup@v4")).toBeLessThan(
      steps.findIndex((step) => step.uses === "actions/setup-node@v4"),
    );

    expect(steps).toContainEqual(
      expect.objectContaining({
        uses: "actions/checkout@v4",
        with: expect.objectContaining({ path: "own-work" }),
      }),
    );
    expect(steps).toContainEqual(
      expect.objectContaining({
        uses: "actions/checkout@v4",
        with: expect.objectContaining({
          repository: "${{ github.repository_owner }}/absorb-anything",
          path: "absorb-anything",
        }),
      }),
    );
    expect(steps).toContainEqual(
      expect.objectContaining({
        uses: "actions/checkout@v4",
        with: expect.objectContaining({
          repository: "${{ github.repository_owner }}/assay",
          ref: "v0.14.0",
          path: "assay",
        }),
      }),
    );

    const ownInstall = steps.findIndex(
      (step) =>
        step.run === "pnpm install --frozen-lockfile" && step["working-directory"] === "own-work",
    );
    for (const sibling of ["absorb-anything", "assay"]) {
      expect(
        steps.findIndex(
          (step) => step.run === "pnpm build" && step["working-directory"] === sibling,
        ),
      ).toBeLessThan(ownInstall);
    }

    const legacyCli = "${{ github.workspace }}/assay/packages/assay-cli/dist/cli.js";
    for (const runner of ["Linux", "Windows"]) {
      const gate = steps.find((step) => step.if === `runner.os == '${runner}'`);
      expect(gate?.env?.ASSAY_V014_CLI).toBe(legacyCli);
      expect(gate?.["working-directory"]).toBe("own-work");
    }

    const [posixGate, windowsGate] = await Promise.all([
      readFile(path.join(repository, "scripts", "check.sh"), "utf8"),
      readFile(path.join(repository, "scripts", "legacy-three-tool.ps1"), "utf8"),
    ]);
    for (const gate of [posixGate, windowsGate]) {
      expect(gate).toContain("ASSAY_V014_CLI");
      expect(gate).toContain("legacy-three-tool.test.ts");
      expect(gate).toContain("CI requires ASSAY_V014_CLI");
    }
  });

  it("keeps the manifest publishable while local dev resolves the sibling checkout", async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
    };
    // The published manifest must carry a real version range; a file: path would
    // ship a package nobody can install.
    expect(manifest.dependencies["absorb-anything-core"]).toBe("^0.1.0");

    const workspace = parse(
      await readFile(path.resolve(process.cwd(), "../../pnpm-workspace.yaml"), "utf8"),
    ) as { overrides?: Record<string, string> };
    expect(workspace.overrides?.["absorb-anything-core"]).toBe(
      "file:../absorb-anything/packages/absorb-anything-core",
    );
  });
});
