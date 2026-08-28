import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type CheckRow,
  type FrameworkStatusResult,
  PRODUCT_VERSION,
  checkFramework,
  getFrameworkStatus,
  initFramework,
  loadManifest,
  loadNativeProject,
  resolveEnvelopeContext,
  workspaceRelativePath,
  workspaceWorkRelativePath,
} from "absorb-anything-core";
import { listRoadmaps, validateRoadmaps } from "./roadmap.js";
import { SEMANTIC_DETAIL_COMMAND, SEMANTIC_TOPICS, semanticDigest } from "./semantics.js";
import { listSpecs, projectSpecsReadme, validateSpecs } from "./spec.js";
import { listSystems, loadSystemsRegistry, registerSystem } from "./systems-registry.js";
import { listTasks, validateTasks } from "./task.js";

export interface InitOwnWorkOptions {
  readonly target: string;
  readonly name?: string;
  readonly standalone?: boolean;
  readonly git?: boolean;
  readonly force?: boolean;
  readonly createNew?: boolean;
  readonly agents?: boolean;
  /** Test and embedding hook; the CLI intentionally exposes no template choice. */
  readonly template?: string;
}

export interface InitOwnWorkResult {
  readonly root: string;
  readonly mode: "overlay" | "standalone";
  readonly createdEnvelope: boolean;
  readonly createdRegistry: boolean;
  readonly system?: string;
}

export async function initOwnWork(options: InitOwnWorkOptions): Promise<InitOwnWorkResult> {
  const root = path.resolve(options.target);
  let manifest = await loadManifest(root);
  const createdEnvelope = manifest === null;
  if (!manifest) {
    await initFramework({
      target: root,
      ...(options.name ? { name: options.name } : {}),
      standalone: options.standalone ?? false,
      git: options.git ?? false,
      force: options.force ?? false,
      createNew: options.createNew ?? false,
      ...(options.agents === undefined ? {} : { agents: options.agents }),
      ...(options.template === undefined ? {} : { template: options.template }),
    });
    manifest = await loadManifest(root);
  }
  if (!manifest) throw new Error(`Workspace initialization produced no manifest at ${root}.`);

  await Promise.all([
    mkdir(path.join(root, workspaceWorkRelativePath(manifest.layout, "tasks")), {
      recursive: true,
    }),
    mkdir(path.join(root, workspaceWorkRelativePath(manifest.layout, "project/roadmap")), {
      recursive: true,
    }),
    mkdir(path.join(root, workspaceWorkRelativePath(manifest.layout, "project/specs")), {
      recursive: true,
    }),
  ]);
  const specsReadme = path.join(
    root,
    workspaceWorkRelativePath(manifest.layout, "project/specs/README.md"),
  );
  await writeFile(specsReadme, projectSpecsReadme(), { encoding: "utf8", flag: "wx" }).catch(
    (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    },
  );
  const roadmapReadme = path.join(
    root,
    workspaceWorkRelativePath(manifest.layout, "project/roadmap/README.md"),
  );
  await writeFile(
    roadmapReadme,
    "# Roadmap\n\nEach directory is one outcome record. Use `ownwork roadmap` to change machine fields; outcome.md remains reader-owned.\n",
    { encoding: "utf8", flag: "wx" },
  ).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });

  let createdRegistry = false;
  let system: string | undefined;
  if (manifest.layout.mode === "overlay" && !(await loadSystemsRegistry(root))) {
    const project = await loadNativeProject(root, manifest.layout);
    const result = await registerSystem(root, {
      name: project?.name ?? options.name ?? path.basename(root),
      path: ".",
      vcs: "embedded",
      primary: true,
    });
    createdRegistry = true;
    system = result.selector;
  }
  return {
    root,
    mode: manifest.layout.mode,
    createdEnvelope,
    createdRegistry,
    ...(system ? { system } : {}),
  };
}

function isForeignCoreRow(row: CheckRow, prefixes: readonly string[]): boolean {
  const normalized = row.path.replaceAll("\\", "/");
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function issueRows(
  fallback: string,
  issues: readonly { readonly path?: string; readonly code?: string; readonly message: string }[],
): CheckRow[] {
  return issues.map((issue) => ({
    path: issue.path ?? fallback,
    status: "error" as const,
    message: issue.code ? `[${issue.code}] ${issue.message}` : issue.message,
  }));
}

export async function checkOwnWork(options: { readonly root: string }): Promise<{
  readonly root: string;
  readonly ok: boolean;
  readonly rows: readonly CheckRow[];
}> {
  const root = path.resolve(options.root);
  const manifest = await loadManifest(root);
  const common = await checkFramework({ root });
  if (!manifest) return common;
  const foreign = (["sources", "analyses", "knowledge"] as const).map((area) =>
    workspaceRelativePath(manifest.layout, area).replaceAll("\\", "/"),
  );
  const rows: CheckRow[] = common.rows.filter((row) => !isForeignCoreRow(row, foreign));
  try {
    const tasks = await validateTasks({ root, includeArchived: true });
    rows.push(
      ...tasks.tasks.flatMap((task) =>
        task.valid
          ? [{ path: task.path, status: "ok" as const, message: "Task" }]
          : issueRows(task.path, task.issues),
      ),
      ...issueRows(tasks.context_path, tasks.context_issues),
    );
  } catch (error) {
    rows.push({
      path: workspaceWorkRelativePath(manifest.layout, "tasks"),
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const roadmaps = await validateRoadmaps({ root });
    rows.push(
      ...roadmaps.items.flatMap((item) =>
        item.valid
          ? [{ path: item.path, status: "ok" as const, message: "Roadmap item" }]
          : issueRows(item.path, item.issues),
      ),
      ...issueRows(
        workspaceWorkRelativePath(manifest.layout, "project/roadmap"),
        roadmaps.issues.filter((issue) => !issue.id),
      ),
    );
  } catch (error) {
    rows.push({
      path: workspaceWorkRelativePath(manifest.layout, "project/roadmap"),
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const specs = await validateSpecs({ root });
    rows.push(
      ...specs.items.flatMap((item) =>
        item.valid
          ? [{ path: item.path, status: "ok" as const, message: "Spec" }]
          : issueRows(item.path, item.issues),
      ),
      ...issueRows(
        workspaceWorkRelativePath(manifest.layout, "project/specs"),
        specs.issues.filter((issue) => !issue.id),
      ),
    );
  } catch (error) {
    rows.push({
      path: workspaceWorkRelativePath(manifest.layout, "project/specs"),
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const registry = await loadSystemsRegistry(root);
    const envelope = await resolveEnvelopeContext(root);
    rows.push({
      path: `${envelope.directory}/systems-registry.json`,
      status: registry ? "ok" : "warning",
      message: registry ? "System registry" : "System registry is not initialized.",
    });
  } catch (error) {
    const envelope = await resolveEnvelopeContext(root);
    rows.push({
      path: `${envelope.directory}/systems-registry.json`,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    root,
    ok: !rows.some((row) => row.status === "missing" || row.status === "error"),
    rows,
  };
}

export interface OwnWorkStatus {
  readonly common: FrameworkStatusResult;
  readonly tasks: number;
  readonly roadmaps: number;
  readonly specs: number;
  readonly systems: number;
  readonly primarySystem: string | null;
}

export async function getOwnWorkStatus(options: { readonly root: string }): Promise<OwnWorkStatus> {
  const root = path.resolve(options.root);
  const common = await getFrameworkStatus({ root });
  if (!common.hasManifest)
    return { common, tasks: 0, roadmaps: 0, specs: 0, systems: 0, primarySystem: null };
  const [tasks, roadmaps, specs, registry] = await Promise.all([
    listTasks({ root, archived: false, limit: 100 })
      .then((result) => result.tasks.length)
      .catch(() => 0),
    listRoadmaps({ root, archived: "live", limit: 100 })
      .then((result) => result.items.length)
      .catch(() => 0),
    listSpecs({ root, archived: "live", limit: 100 })
      .then((result) => result.items.length)
      .catch(() => 0),
    listSystems(root).catch(() => null),
  ]);
  return {
    common,
    tasks,
    roadmaps,
    specs,
    systems: registry?.systems.length ?? 0,
    primarySystem: registry?.registry.primary ?? null,
  };
}

export async function primeOwnWork(options: { readonly root: string }) {
  const status = await getOwnWorkStatus(options);
  return {
    root: path.resolve(options.root),
    productVersion: PRODUCT_VERSION,
    semantics: semanticDigest(),
    topics: SEMANTIC_TOPICS,
    detailsCommand: SEMANTIC_DETAIL_COMMAND,
    workspace: status.common.hasManifest
      ? {
          envelope: status.common.envelope,
          project: status.common.project,
          tasks: status.tasks,
          roadmaps: status.roadmaps,
          specs: status.specs,
          systems: status.systems,
          primarySystem: status.primarySystem,
        }
      : null,
  };
}
