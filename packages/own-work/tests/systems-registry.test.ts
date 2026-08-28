import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FrameworkAlreadyExistsError,
  FrameworkError,
  FrameworkNotFoundError,
  SystemsRegistryCutoverRequiredError,
} from "absorb-anything-core";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureRoot } from "./helpers.js";

import {
  type SystemsRegistry,
  archiveSystem,
  checkOwnWork as checkFramework,
  findSystem,
  findSystemEntry,
  getOwnWorkStatus,
  initOwnWork as initFramework,
  listSystems,
  loadSystemsRegistry,
  loadSystemsRegistrySnapshot,
  promoteSystem,
  registerSystem,
  saveSystemsRegistry,
  setSystemsRegistrySaveProbeForTests,
  systemsRegistryPath,
  updateSystem,
} from "../src/index.js";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(fixtureRoot(), "assay-registry-s3-"));
  tempRoots.push(root);
  return root;
}

async function workspace(name = "Registry s3"): Promise<string> {
  const root = path.join(await tempDir(), "workspace");
  await initFramework({ target: root, name, standalone: true });
  return root;
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

function record(pathValue: string, status: "primary" | "active" = "active") {
  return {
    path: pathValue,
    status,
    vcs: "embedded" as const,
    vcs_ref: "",
    version: "1.0.0",
    supersedes: [] as string[],
  };
}

function registry(overrides: Partial<SystemsRegistry> = {}): SystemsRegistry {
  return {
    __schema: 3,
    primary: "alpha",
    systems: { alpha: record("systems/alpha", "primary") },
    updated_at: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

async function writeRawRegistry(root: string, value: unknown): Promise<string> {
  const file = systemsRegistryPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

afterEach(async () => {
  setSystemsRegistrySaveProbeForTests(undefined);
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("systems registry schema 3 authority", () => {
  it("round-trips the closed map-key record without duplicated identity or sidecar fields", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "systems", "alpha"), { recursive: true });
    const saved = await saveSystemsRegistry(root, registry(), { expectedRevision: null });
    const loaded = await loadSystemsRegistry(root);

    expect(saved.__schema).toBe(3);
    expect(loaded).toEqual(saved);
    expect(Object.keys(loaded?.systems.alpha ?? {})).toEqual([
      "path",
      "status",
      "vcs",
      "vcs_ref",
      "version",
      "supersedes",
    ]);
    const raw = await readFile(systemsRegistryPath(root), "utf8");
    expect(raw).not.toContain('"name"');
    expect(raw).not.toContain("contract_file");
    expect(raw).not.toContain("archive_path");
  });

  it("fails old r2 before recovery, semantic reads, locator access, or writes", async () => {
    const root = await workspace();
    const sidecar = path.join(root, "systems", "alpha", "system.yaml");
    await mkdir(path.dirname(sidecar), { recursive: true });
    await writeFile(sidecar, "malicious: should-never-be-read\n", "utf8");
    const old = {
      __schema: 2,
      primary: "alpha",
      systems: {
        alpha: {
          name: "alpha",
          path: "systems/alpha",
          status: "primary",
          vcs: "embedded",
          vcs_ref: "",
          version: "1.0.0",
          contract_file: "systems/alpha/system.yaml",
          supersedes: [],
          absorbed_on: null,
          archived_on: null,
          archive_path: null,
        },
      },
      updated_at: "2026-08-08T00:00:00.000Z",
    };
    const file = await writeRawRegistry(root, old);
    const before = await readFile(file, "utf8");
    let probeCalls = 0;
    setSystemsRegistrySaveProbeForTests(() => {
      probeCalls += 1;
    });

    await expect(listSystems(root)).rejects.toMatchObject({
      code: "WORKSPACE_CUTOVER_REQUIRED",
      observed: "0.14.0+s4+l8+r2",
      required: "0.14.0+s4+l8+r3",
      locator: "absorb-cutover:0.14.0+s4+l8+r2->0.14.0+s4+l8+r3",
    });
    await expect(updateSystem(root, "alpha", { version: "2.0.0" })).rejects.toBeInstanceOf(
      SystemsRegistryCutoverRequiredError,
    );
    await expect(
      registerSystem(root, { path: "systems/beta", name: "beta" }),
    ).rejects.toBeInstanceOf(SystemsRegistryCutoverRequiredError);
    await expect(
      saveSystemsRegistry(root, registry(), { expectedRevision: null }),
    ).rejects.toBeInstanceOf(SystemsRegistryCutoverRequiredError);
    expect(probeCalls).toBe(0);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readFile(sidecar, "utf8")).toBe("malicious: should-never-be-read\n");
    expect((await readdir(path.dirname(file))).some((name) => name.includes("authority-"))).toBe(
      false,
    );
  });

  it("rejects unknown record fields instead of repairing from ordinary content", async () => {
    const root = await workspace();
    const invalid = registry();
    (invalid.systems.alpha as Record<string, unknown>).name = "alpha";
    await writeRawRegistry(root, invalid);
    await expect(loadSystemsRegistry(root)).rejects.toThrow(/failed validation/);
  });

  it("rejects a stale whole-registry candidate instead of losing a concurrent member", async () => {
    const root = await workspace();
    await saveSystemsRegistry(root, registry(), { expectedRevision: null });
    const betaBase = await loadSystemsRegistrySnapshot(root);
    const gammaBase = await loadSystemsRegistrySnapshot(root);
    if (!betaBase || !gammaBase) throw new Error("registry snapshots missing");

    const betaCandidate: SystemsRegistry = {
      ...betaBase.registry,
      systems: {
        ...betaBase.registry.systems,
        beta: record("systems/beta"),
      },
    };
    await saveSystemsRegistry(root, betaCandidate, { expectedRevision: betaBase.revision });

    const gammaCandidate: SystemsRegistry = {
      ...gammaBase.registry,
      systems: {
        ...gammaBase.registry.systems,
        gamma: record("systems/gamma"),
      },
    };
    await expect(
      saveSystemsRegistry(root, gammaCandidate, { expectedRevision: gammaBase.revision }),
    ).rejects.toMatchObject({ code: "AUTHORITY_WRITE_CONFLICT" });

    const current = await loadSystemsRegistry(root);
    expect(current?.systems.beta?.path).toBe("systems/beta");
    expect(Object.hasOwn(current?.systems ?? {}, "gamma")).toBe(false);
  });

  it("never treats Object prototype names as System membership", async () => {
    const root = await workspace();
    await writeRawRegistry(
      root,
      registry({
        systems: {
          alpha: { ...record("systems/alpha", "primary"), supersedes: ["toString"] },
        },
      }),
    );
    await expect(loadSystemsRegistry(root)).rejects.toThrow(/unknown selector 'toString'/);

    await writeRawRegistry(root, registry());
    const current = await loadSystemsRegistry(root);
    if (!current) throw new Error("registry missing");
    await expect(findSystemEntry(current, "toString")).rejects.toBeInstanceOf(
      FrameworkNotFoundError,
    );
  });
});

describe("schema 3 complete invariants", () => {
  it.each([
    ["dangling primary", registry({ primary: "missing" }), /exactly one primary/],
    [
      "multiple primary records",
      registry({
        systems: {
          alpha: record("systems/alpha", "primary"),
          beta: record("systems/beta", "primary"),
        },
      }),
      /exactly one primary/,
    ],
    [
      "duplicate live locator",
      registry({
        systems: {
          alpha: record("systems/shared", "primary"),
          beta: record("systems/shared"),
        },
      }),
      /share locator/,
    ],
    [
      "unknown supersedes target",
      registry({
        systems: {
          alpha: { ...record("systems/alpha", "primary"), supersedes: ["missing"] },
        },
      }),
      /unknown selector/,
    ],
    [
      "self supersedes edge",
      registry({
        systems: {
          alpha: { ...record("systems/alpha", "primary"), supersedes: ["alpha"] },
        },
      }),
      /cannot supersede itself/,
    ],
    [
      "duplicate supersedes edge",
      registry({
        systems: {
          alpha: { ...record("systems/alpha", "primary"), supersedes: ["beta", "beta"] },
          beta: record("systems/beta"),
        },
      }),
      /repeats supersedes edge/,
    ],
    [
      "supersedes cycle",
      registry({
        systems: {
          alpha: { ...record("systems/alpha", "primary"), supersedes: ["beta"] },
          beta: { ...record("systems/beta"), supersedes: ["alpha"] },
        },
      }),
      /contains a cycle/,
    ],
  ])("rejects %s", async (_label, value, message) => {
    const root = await workspace();
    await writeRawRegistry(root, value);
    await expect(loadSystemsRegistry(root)).rejects.toThrow(message as RegExp);
  });

  it("enforces lifecycle pairing and omits archive_path for logical archive", async () => {
    const root = await workspace();
    const cases = [
      { ...record("systems/alpha", "primary"), absorbed_on: "2026-08-08" },
      { ...record("systems/alpha"), status: "superseded", archived_on: "2026-08-08" },
      { ...record("systems/alpha"), status: "archived" },
      {
        ...record("systems/alpha"),
        status: "archived",
        archived_on: "2026-08-08",
        archive_path: "x",
      },
    ];
    for (const invalidRecord of cases) {
      await writeRawRegistry(
        root,
        registry({ systems: { alpha: invalidRecord } as SystemsRegistry["systems"] }),
      );
      await expect(loadSystemsRegistry(root)).rejects.toThrow(/validation/);
    }
  });

  it("accepts a valid acyclic graph and paired superseded/archived records", async () => {
    const root = await workspace();
    const valid = registry({
      systems: {
        alpha: { ...record("systems/alpha", "primary"), supersedes: ["beta"] },
        beta: { ...record("systems/beta"), status: "superseded", absorbed_on: "2026-08-07" },
        old: { ...record("systems/old"), status: "archived", archived_on: "2026-08-06" },
      },
    });
    await writeRawRegistry(root, valid);
    await expect(loadSystemsRegistry(root)).resolves.toEqual(valid);
  });
});

describe("locator normalization and topology", () => {
  it("supports workspace-owned and absolute external Systems without rewriting source identity", async () => {
    const root = await workspace();
    const internal = path.join(root, "systems", "embedded");
    const external = path.join(await tempDir(), "independent");
    await mkdir(internal, { recursive: true });
    await mkdir(path.join(external, ".git"), { recursive: true });
    await writeFile(
      path.join(external, "package.json"),
      '{"name":"release-owner","version":"9.9.9"}\n',
    );
    await writeFile(path.join(external, "README.md"), "# Independent identity\n");

    const first = await registerSystem(root, { path: internal, name: "embedded" });
    const second = await registerSystem(root, {
      path: external,
      name: "external",
      vcs: "independent-git",
    });

    expect(first.system.path).toBe("systems/embedded");
    expect(second.system.path).toBe(external.replaceAll("\\", "/"));
    expect(await readFile(path.join(external, "package.json"), "utf8")).toContain("release-owner");
    expect(await readFile(path.join(external, "README.md"), "utf8")).toBe(
      "# Independent identity\n",
    );
  });

  it("rejects traversal, absolute workspace-owned locators, and redirecting locators", async () => {
    const root = await workspace();
    await expect(registerSystem(root, { path: "../escape", name: "escape" })).rejects.toThrow(
      /escapes the workspace/,
    );
    await writeRawRegistry(root, registry({ systems: { alpha: record(root, "primary") } }));
    await expect(loadSystemsRegistry(root)).rejects.toThrow(/not normalized/);

    const target = path.join(await tempDir(), "redirect-target");
    await mkdir(target, { recursive: true });
    await mkdir(path.join(root, "systems"), { recursive: true });
    await symlink(target, path.join(root, "systems", "redirect"), "junction");
    await writeRawRegistry(
      root,
      registry({ systems: { alpha: record("systems/redirect", "primary") } }),
    );
    await expect(loadSystemsRegistry(root)).rejects.toThrow(/redirect/);
  });

  it("update --path only rebinds the registry and never moves source or target bytes", async () => {
    const root = await workspace();
    const source = path.join(root, "systems", "source");
    const target = path.join(root, "systems", "target");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(source, "source.txt"), "source\n");
    await writeFile(path.join(target, "target.txt"), "target\n");
    await registerSystem(root, { path: source, name: "system" });

    const result = await updateSystem(root, "system", { path: target });
    expect(result.system.path).toBe("systems/target");
    expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("source\n");
    expect(await readFile(path.join(target, "target.txt"), "utf8")).toBe("target\n");
  });
});

describe("system.yaml inertness", () => {
  it("never creates a sidecar and ignores absence, large legacy bytes, drift, and a redirect", async () => {
    const root = await workspace("Sidecar inertness");
    const systemRoot = path.join(root, "systems", "alpha");
    await mkdir(systemRoot, { recursive: true });
    await registerSystem(root, { path: systemRoot, name: "alpha" });
    const sidecar = path.join(systemRoot, "system.yaml");
    expect(await exists(sidecar)).toBe(false);

    const baselineList = await listSystems(root);
    const baselineShow = await findSystemEntry(baselineList.registry, "alpha");
    const baselineStatus = await getOwnWorkStatus({ root });
    const baselineCheck = await checkFramework({ root });
    const expectAuthoritySurfacesUnchanged = async () => {
      expect(await listSystems(root)).toEqual(baselineList);
      expect(await findSystemEntry(baselineList.registry, "alpha")).toEqual(baselineShow);
      expect(await getOwnWorkStatus({ root })).toEqual(baselineStatus);
      expect(await checkFramework({ root })).toEqual(baselineCheck);
    };

    const corpus = Object.fromEntries(
      Array.from({ length: 873 }, (_, index) => [`field_${index}`, index]),
    );
    const largeLegacyBytes = `${JSON.stringify(corpus)}\n`;
    await writeFile(sidecar, largeLegacyBytes, "utf8");
    await expectAuthoritySurfacesUnchanged();
    expect(await readFile(sidecar, "utf8")).toBe(largeLegacyBytes);

    const driftBytes = "name: drift\npath: ../../escape\n";
    await writeFile(sidecar, driftBytes, "utf8");
    await expectAuthoritySurfacesUnchanged();
    expect(await readFile(sidecar, "utf8")).toBe(driftBytes);

    await rm(sidecar);
    const outside = path.join(await tempDir(), "malicious.yaml");
    await writeFile(outside, "name: attacker\n");
    try {
      await symlink(outside, sidecar, "file");
      expect(await listSystems(root)).toEqual(baselineList);
      expect(await readFile(outside, "utf8")).toBe("name: attacker\n");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    }
  });
});

describe("System lifecycle operations", () => {
  it("uses exact selectors, validates supersedes, and keeps exactly one primary", async () => {
    const root = await workspace();
    const alpha = await registerSystem(root, { path: "systems/alpha", name: "alpha" });
    expect(alpha.system.status).toBe("primary");
    await registerSystem(root, { path: "systems/beta", name: "beta" });
    await expect(findSystem(alpha.registry, "a")).rejects.toBeInstanceOf(FrameworkNotFoundError);
    await expect(
      registerSystem(root, { path: "systems/other", name: "alpha" }),
    ).rejects.toBeInstanceOf(FrameworkAlreadyExistsError);
    await expect(updateSystem(root, "beta", { supersedes: ["missing"] })).rejects.toThrow(
      /unknown selector/,
    );

    const promoted = await promoteSystem(root, "beta", { now: new Date("2026-08-08") });
    expect(promoted.previousPrimary?.selector).toBe("alpha");
    expect(promoted.registry.systems.alpha).toMatchObject({
      status: "superseded",
      absorbed_on: "2026-08-08",
    });
    expect(promoted.registry.primary).toBe("beta");
  });

  it("logical archive leaves internal and external bytes untouched and records no physical path", async () => {
    const root = await workspace();
    const internal = path.join(root, "systems", "old");
    const external = path.join(await tempDir(), "external-old");
    await mkdir(internal, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(path.join(internal, "marker.txt"), "internal\n");
    await writeFile(path.join(external, "marker.txt"), "external\n");
    await registerSystem(root, { path: "systems/primary", name: "primary" });
    await registerSystem(root, { path: internal, name: "old" });
    await registerSystem(root, { path: external, name: "external" });

    const dryRun = await archiveSystem(root, "old", {
      dryRun: true,
      now: new Date("2026-08-08"),
    });
    expect(dryRun.archiveMode).toBe("logical");
    expect(dryRun.registry.systems.old?.status).toBe("active");
    const archived = await archiveSystem(root, "old", { now: new Date("2026-08-08") });
    const externalArchived = await archiveSystem(root, "external", {
      now: new Date("2026-08-08"),
    });
    expect(archived.system).toEqual({
      ...record("systems/old"),
      version: "0.1.0",
      status: "archived",
      archived_on: "2026-08-08",
    });
    expect(Object.hasOwn(archived.system, "archive_path")).toBe(false);
    expect(Object.hasOwn(externalArchived.system, "archive_path")).toBe(false);
    expect(await readFile(path.join(internal, "marker.txt"), "utf8")).toBe("internal\n");
    expect(await readFile(path.join(external, "marker.txt"), "utf8")).toBe("external\n");
    await expect(archiveSystem(root, "primary")).rejects.toBeInstanceOf(FrameworkError);
  });

  it.each([
    "after-validation",
    "after-stage",
    "after-old-moved",
    "after-new-installed",
    "before-cleanup",
  ] as const)("preserves exact source bytes across authority crash window %s", async (phase) => {
    const root = await workspace();
    const source = path.join(root, "systems", "old");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "marker.txt"), "owned-source\n");
    await registerSystem(root, { path: "systems/primary", name: "primary" });
    await registerSystem(root, { path: source, name: "old" });
    setSystemsRegistrySaveProbeForTests((observed) => {
      if (observed === phase) throw new Error(`crash:${phase}`);
    });
    await expect(archiveSystem(root, "old")).rejects.toThrow(`crash:${phase}`);
    expect(await readFile(path.join(source, "marker.txt"), "utf8")).toBe("owned-source\n");
    setSystemsRegistrySaveProbeForTests(undefined);
    const recovered = await loadSystemsRegistry(root);
    expect(recovered?.systems.old?.status).toBe(
      phase === "after-validation" || phase === "after-stage" ? "active" : "archived",
    );
    await expect(loadSystemsRegistry(root)).resolves.toEqual(recovered);
    expect(await exists(path.join(root, ".absorb", ".authority-systems-registry.json.txn"))).toBe(
      false,
    );
    expect(await readFile(path.join(source, "marker.txt"), "utf8")).toBe("owned-source\n");
  });

  it("lists selector-record pairs in lifecycle order", async () => {
    const root = await workspace();
    await registerSystem(root, { path: "systems/zeta", name: "zeta" });
    await registerSystem(root, { path: "systems/alpha", name: "alpha", primary: true });
    const { systems } = await listSystems(root);
    expect(systems.map((entry) => entry.selector)).toEqual(["alpha", "zeta"]);
    expect(systems[0]?.system.status).toBe("primary");
  });
});
