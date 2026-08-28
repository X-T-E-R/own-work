import { type Command, Option } from "@commander-js/extra-typings";
import {
  ROADMAP_HORIZONS,
  ROADMAP_STATES,
  RoadmapError,
  type RoadmapRecordResult,
  archiveRoadmap,
  createRoadmap,
  linkRoadmapTask,
  listRoadmaps,
  realizeRoadmap,
  retireRoadmap,
  showRoadmap,
  unlinkRoadmapTask,
  updateRoadmap,
  validateRoadmaps,
} from "./roadmap.js";

interface Output {
  readonly stdout: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

interface Dependencies {
  readonly output: Output;
  readonly resolveRoot: (root: string) => Promise<string>;
}

function write(output: Output, value: string): void {
  output.stdout(`${value}\n`);
}

function emit(output: Output, value: unknown, json: boolean | undefined, formatted: string): void {
  write(output, json ? JSON.stringify(value, null, 2) : formatted);
}

function nonnegative(value: string, option: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new RoadmapError("ROADMAP_INVALID", `${option} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new RoadmapError("ROADMAP_INVALID", `${option} exceeds the safe integer range`);
  return parsed;
}

function optionalRevision(value: string | undefined): { readonly expectedRevision?: number } {
  return value === undefined ? {} : { expectedRevision: nonnegative(value, "--expected-revision") };
}

function formatRecord(result: RoadmapRecordResult): string {
  const tasks =
    result.tasks.length === 0
      ? "(none)"
      : result.tasks
          .map(
            (task) =>
              `${task.id} (${task.unresolved ? "unresolved" : `${task.status}${task.archived ? ", archived" : ""}`})`,
          )
          .join(", ");
  return [
    `Roadmap: ${result.item.id}`,
    `Path: ${result.path}`,
    `Title: ${result.item.title}`,
    `State: ${result.item.state}`,
    `Horizon: ${result.item.horizon}`,
    `Order: ${result.item.order ?? "(none)"}`,
    `Revision: ${result.item.revision}`,
    `Archived: ${result.archived ? "yes" : "no"}`,
    `Tasks: ${tasks}`,
    "",
    result.outcome,
  ].join("\n");
}

export function addRoadmapCommand(program: Command, dependencies: Dependencies): void {
  const { output, resolveRoot } = dependencies;
  const roadmap = program.command("roadmap").description("Manage native Project roadmap items");

  roadmap
    .command("create")
    .requiredOption("--title <text>", "roadmap item title")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (options) => {
      const result = await createRoadmap({
        root: await resolveRoot(options.root),
        title: options.title,
      });
      emit(output, result, options.json, formatRecord(result));
    });

  roadmap
    .command("show")
    .argument("<id>", "exact roadmap item id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      const result = await showRoadmap({ root: await resolveRoot(options.root), id });
      emit(output, result, options.json, formatRecord(result));
    });

  roadmap
    .command("list")
    .addOption(new Option("--state <state>", "filter by state").choices(ROADMAP_STATES))
    .addOption(new Option("--horizon <horizon>", "filter by horizon").choices(ROADMAP_HORIZONS))
    .option("--task <task-id>", "filter by exact linked task id")
    .addOption(
      new Option("--archived <scope>", "archive scope")
        .choices(["live", "archived", "all"])
        .default("live"),
    )
    .option("--limit <n>", "page size", "50")
    .option("--cursor <id>", "continue after this exact roadmap id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (options) => {
      const result = await listRoadmaps({
        root: await resolveRoot(options.root),
        ...(options.state === undefined
          ? {}
          : { state: options.state as (typeof ROADMAP_STATES)[number] }),
        ...(options.horizon === undefined
          ? {}
          : { horizon: options.horizon as (typeof ROADMAP_HORIZONS)[number] }),
        ...(options.task === undefined ? {} : { task: options.task }),
        archived: options.archived as "live" | "archived" | "all",
        limit: nonnegative(options.limit, "--limit"),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      });
      const lines = result.items.map((item) =>
        [item.id, item.state, item.horizon, item.archived ? "archived" : "live", item.title].join(
          "\t",
        ),
      );
      if (lines.length === 0) lines.push("No roadmap items.");
      if (result.next_cursor) lines.push(`Next cursor: ${result.next_cursor}`);
      for (const issue of result.issues)
        lines.push(`Issue ${issue.code}: ${issue.id ?? "roadmap"}: ${issue.message}`);
      emit(output, result, options.json, lines.join("\n"));
      if (result.issues.length > 0) output.setExitCode(1);
    });

  roadmap
    .command("update")
    .argument("<id>", "exact roadmap item id")
    .option("--title <text>", "replace title without changing id")
    .addOption(new Option("--state <state>", "set state").choices(ROADMAP_STATES))
    .addOption(new Option("--horizon <horizon>", "set horizon").choices(ROADMAP_HORIZONS))
    .option("--order <n-or-null>", "set non-negative order or null")
    .addOption(
      new Option("--depends-on <id...>", "replace dependency ids").conflicts("clearDependsOn"),
    )
    .addOption(new Option("--clear-depends-on", "clear dependency ids").conflicts("dependsOn"))
    .addOption(
      new Option("--superseded-by <id...>", "replace successor ids").conflicts("clearSupersededBy"),
    )
    .addOption(new Option("--clear-superseded-by", "clear successor ids").conflicts("supersededBy"))
    .option("--expected-revision <n>", "require the current revision")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      if (
        options.title === undefined &&
        options.state === undefined &&
        options.horizon === undefined &&
        options.order === undefined &&
        options.dependsOn === undefined &&
        options.clearDependsOn !== true &&
        options.supersededBy === undefined &&
        options.clearSupersededBy !== true
      ) {
        throw new RoadmapError("ROADMAP_INVALID", "roadmap update requires at least one field");
      }
      const result = await updateRoadmap({
        root: await resolveRoot(options.root),
        id,
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.state === undefined
          ? {}
          : { state: options.state as (typeof ROADMAP_STATES)[number] }),
        ...(options.horizon === undefined
          ? {}
          : { horizon: options.horizon as (typeof ROADMAP_HORIZONS)[number] }),
        ...(options.order === undefined
          ? {}
          : { order: options.order === "null" ? null : nonnegative(options.order, "--order") }),
        ...(options.clearDependsOn
          ? { dependsOn: [] }
          : options.dependsOn === undefined
            ? {}
            : { dependsOn: options.dependsOn }),
        ...(options.clearSupersededBy
          ? { supersededBy: [] }
          : options.supersededBy === undefined
            ? {}
            : { supersededBy: options.supersededBy }),
        ...optionalRevision(options.expectedRevision),
      });
      emit(output, result, options.json, formatRecord(result));
    });

  for (const [name, operation] of [
    ["realize", realizeRoadmap],
    ["retire", retireRoadmap],
  ] as const) {
    roadmap
      .command(name)
      .argument("<id>", "exact roadmap item id")
      .option("--expected-revision <n>", "require the current revision")
      .option("--root <target-dir>", "target workspace directory", process.cwd())
      .option("--json", "emit JSON")
      .action(async (id, options) => {
        const result = await operation({
          root: await resolveRoot(options.root),
          id,
          ...optionalRevision(options.expectedRevision),
        });
        emit(output, result, options.json, formatRecord(result));
      });
  }

  roadmap
    .command("archive")
    .argument("<id>", "exact roadmap item id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      const result = await archiveRoadmap({ root: await resolveRoot(options.root), id });
      emit(output, result, options.json, formatRecord(result));
    });

  for (const [name, operation] of [
    ["link-task", linkRoadmapTask],
    ["unlink-task", unlinkRoadmapTask],
  ] as const) {
    roadmap
      .command(name)
      .argument("<id>", "exact roadmap item id")
      .requiredOption("--task <task-id>", "exact native Task id")
      .option("--expected-revision <n>", "require the current revision")
      .option("--root <target-dir>", "target workspace directory", process.cwd())
      .option("--json", "emit JSON")
      .action(async (id, options) => {
        const result = await operation({
          root: await resolveRoot(options.root),
          id,
          task: options.task,
          ...optionalRevision(options.expectedRevision),
        });
        emit(output, result, options.json, formatRecord(result));
      });
  }

  roadmap
    .command("validate")
    .argument("[id]", "exact roadmap item id; omit for all")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      const result = await validateRoadmaps({
        root: await resolveRoot(options.root),
        ...(id === undefined ? {} : { id }),
      });
      const lines = [result.valid ? "Roadmap validation passed." : "Roadmap validation failed."];
      for (const item of result.items) {
        lines.push(`${item.id}: ${item.valid ? "valid" : "invalid"} (${item.path})`);
        for (const issue of item.issues) lines.push(`  ${issue.code}: ${issue.message}`);
      }
      emit(output, result, options.json, lines.join("\n"));
      if (!result.valid) output.setExitCode(1);
    });
}
