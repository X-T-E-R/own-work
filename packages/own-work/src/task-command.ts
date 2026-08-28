import { readFile } from "node:fs/promises";
import path from "node:path";

import { type Command, Option } from "@commander-js/extra-typings";
import {
  type ListTasksResult,
  TASK_RELATION_TYPES,
  TASK_WRITE_STATUSES,
  TaskError,
  type TaskListEntry,
  type TaskRecordResult,
  type TaskRelation,
  type TaskRelationType,
  archiveTask,
  bindTask,
  checkpointTask,
  clearTaskContext,
  contextTask,
  createTask,
  currentTask,
  finishTask,
  listTasks,
  setTaskRelations,
  showTask,
  updateTaskStatus,
  validateTasks,
} from "./task.js";

import { hintedResult, withHintLines } from "./hints.js";

interface TaskCommandOutput {
  readonly stdout: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

interface TaskCommandDependencies {
  readonly output: TaskCommandOutput;
  readonly resolveRoot: (root: string) => Promise<string>;
}

type ArchiveFilter = "live" | "archived" | "all";

function writeLine(output: TaskCommandOutput, text: string): void {
  output.stdout(`${text}\n`);
}

function writeJson(output: TaskCommandOutput, value: unknown): void {
  output.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function emit(
  output: TaskCommandOutput,
  value: unknown,
  json: boolean | undefined,
  formatter: (value: never) => string,
): void {
  if (json) writeJson(output, value);
  else writeLine(output, formatter(value as never));
}

function parseNonnegativeInteger(value: string, option: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TaskError("TASK_INVALID", `${option} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TaskError("TASK_INVALID", `${option} exceeds the safe integer range`);
  }
  return parsed;
}

function parseLimit(value: string): number {
  const parsed = parseNonnegativeInteger(value, "--limit");
  if (parsed < 1 || parsed > 100) {
    throw new TaskError("TASK_INVALID", "--limit must be between 1 and 100");
  }
  return parsed;
}

function parseRelations(values: readonly string[] | undefined): readonly TaskRelation[] {
  return (values ?? []).map((value) => {
    const separator = value.indexOf(":");
    const type = separator < 0 ? "" : value.slice(0, separator);
    const taskId = separator < 0 ? "" : value.slice(separator + 1);
    if (!TASK_RELATION_TYPES.includes(type as TaskRelationType) || taskId.length === 0) {
      throw new TaskError(
        "TASK_RELATION_INVALID",
        `--relation must be <type:id>, where type is one of: ${TASK_RELATION_TYPES.join(", ")}`,
      );
    }
    return { type: type as TaskRelationType, task_id: taskId };
  });
}

async function readUtf8Markdown(file: string): Promise<string> {
  const resolved = path.resolve(file);
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch (error) {
    throw new TaskError("TASK_IO_ERROR", `cannot read Markdown file: ${resolved}`, {
      cause: error,
      details: { path: resolved },
    });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TaskError("TASK_INVALID", `Markdown file is not valid UTF-8: ${resolved}`, {
      cause: error,
      details: { path: resolved },
    });
  }
}

function formatTask(result: TaskRecordResult): string {
  const lines = [
    `Task: ${result.task.id}`,
    `Path: ${result.path}`,
    `Title: ${result.task.title}`,
    `Status: ${result.task.status}`,
    `Revision: ${result.revision}`,
    `Archived: ${result.archived ? "yes" : "no"}`,
    "",
    "PRD:",
    result.prd,
  ];
  if (result.handoff === undefined) {
    lines.push("Handoff: (none)");
  } else {
    lines.push("Handoff:", result.handoff);
  }
  return lines.join("\n");
}

function formatList(result: ListTasksResult): string {
  const lines = result.tasks.map((task) => {
    if (!task.valid) {
      const issues = task.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
      return `${task.id}\tinvalid\t${task.archived ? "archived" : "live"}\t${issues}`;
    }
    return [
      task.id,
      task.status ?? "unknown",
      String(task.revision ?? ""),
      task.archived ? "archived" : "live",
      task.title ?? "",
    ].join("\t");
  });
  if (lines.length === 0) lines.push("No tasks.");
  if (result.next_cursor !== undefined) lines.push(`Next cursor: ${result.next_cursor}`);
  if (result.issues.length > 0) {
    lines.push("", "Task storage issues:");
    for (const task of result.issues) {
      lines.push(`${task.id}\t${task.archived ? "archived" : "live"}\t${task.path}`);
      for (const issue of task.issues) lines.push(`  ${issue.code}: ${issue.message}`);
    }
  }
  return lines.join("\n");
}

function formatCurrent(
  result:
    | { readonly root: string; readonly status: "none" }
    | ({ readonly status: "current"; readonly context_key?: string } & TaskRecordResult),
): string {
  if (result.status === "none") return "No current task.";
  const context = result.context_key === undefined ? "" : `Context: ${result.context_key}\n`;
  return `${context}${formatTask(result)}`;
}

function formatContext(result: {
  readonly root: string;
  readonly context_key: string;
  readonly task_id?: string;
  readonly record?: TaskRecordResult;
}): string {
  if (result.task_id === undefined) {
    return result.context_key === ""
      ? "No task context selected."
      : `No task is bound to context: ${result.context_key}`;
  }
  const prefix = result.context_key === "" ? "" : `Context: ${result.context_key}\n`;
  return result.record === undefined
    ? `${prefix}Task: ${result.task_id}`
    : `${prefix}${formatTask(result.record)}`;
}

function formatBinding(result: {
  readonly context_key: string;
  readonly task_id?: string;
}): string {
  return result.task_id === undefined
    ? `Cleared task context: ${result.context_key}`
    : `Bound context ${result.context_key} to task ${result.task_id}.`;
}

function formatValidation(result: Awaited<ReturnType<typeof validateTasks>>): string {
  const lines = [result.valid ? "Task validation passed." : "Task validation failed."];
  for (const task of result.tasks) {
    lines.push(`${task.id}: ${task.valid ? "valid" : "invalid"} (${task.path})`);
    for (const issue of task.issues) lines.push(`  ${issue.code}: ${issue.message}`);
  }
  for (const issue of result.context_issues) {
    lines.push(`Context ${issue.code}: ${issue.message}`);
  }
  return lines.join("\n");
}

async function listWithArchiveFilter(options: {
  readonly root: string;
  readonly status?: (typeof TASK_WRITE_STATUSES)[number];
  readonly archived: ArchiveFilter;
  readonly limit: number;
  readonly cursor?: string;
}): Promise<ListTasksResult> {
  if (options.archived !== "archived") {
    return listTasks({
      root: options.root,
      ...(options.status === undefined ? {} : { status: options.status }),
      archived: options.archived === "all",
      limit: options.limit,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
  }

  // Core's archived=true mode means live + archived. Walk its bounded pages so
  // the CLI's archived-only filter preserves limit/cursor semantics.
  const matches: TaskListEntry[] = [];
  let issues: ListTasksResult["issues"] = [];
  let capturedIssues = false;
  let scanCursor = options.cursor;
  while (matches.length <= options.limit) {
    const page = await listTasks({
      root: options.root,
      ...(options.status === undefined ? {} : { status: options.status }),
      archived: true,
      limit: 100,
      ...(scanCursor === undefined ? {} : { cursor: scanCursor }),
    });
    if (!capturedIssues) {
      issues = page.issues;
      capturedIssues = true;
    }
    matches.push(...page.tasks.filter((task) => task.archived));
    if (page.next_cursor === undefined || page.next_cursor === scanCursor) break;
    scanCursor = page.next_cursor;
  }
  const tasks = matches.slice(0, options.limit);
  const last = tasks.at(-1);
  return {
    root: options.root,
    tasks,
    issues,
    ...(matches.length > tasks.length && last !== undefined ? { next_cursor: last.id } : {}),
  };
}

export function addTaskCommand(program: Command, dependencies: TaskCommandDependencies): void {
  const { output, resolveRoot } = dependencies;
  const task = program.command("task").description("Manage durable Tasks");

  task
    .command("create")
    .description("Create a directory-backed Markdown task")
    .requiredOption("--title <text>", "task title")
    .option("--description <text>", "task description")
    .option("--name <display-slug>", "display slug")
    .option("--creator <name>", "task creator")
    .option("--assignee <name>", "task assignee")
    .option("--priority <priority>", "task priority")
    .option("--relation <type:id...>", "typed task relation")
    .option("--context <key>", "bind the new task to this context")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const root = await resolveRoot(commandOptions.root);
      const created = await createTask({
        root,
        title: commandOptions.title,
        ...(commandOptions.description === undefined
          ? {}
          : { description: commandOptions.description }),
        ...(commandOptions.name === undefined ? {} : { name: commandOptions.name }),
        ...(commandOptions.creator === undefined ? {} : { creator: commandOptions.creator }),
        ...(commandOptions.assignee === undefined ? {} : { assignee: commandOptions.assignee }),
        ...(commandOptions.priority === undefined ? {} : { priority: commandOptions.priority }),
        relations: parseRelations(commandOptions.relation),
      });
      if (commandOptions.context === undefined) {
        if (commandOptions.json) writeJson(output, hintedResult(created, "task create"));
        else writeLine(output, withHintLines(formatTask(created), "task create"));
        return;
      }
      try {
        const binding = await bindTask({
          root,
          contextKey: commandOptions.context,
          id: created.task.id,
        });
        const result = { ...created, binding };
        if (commandOptions.json) writeJson(output, hintedResult(result, "task create"));
        else
          writeLine(
            output,
            withHintLines(`${formatTask(created)}\n${formatBinding(binding)}`, "task create"),
          );
      } catch (error) {
        if (error instanceof TaskError) {
          throw new TaskError(
            error.code,
            `${error.message}; task ${created.task.id} was created but not bound`,
            { cause: error, details: { task_id: created.task.id, partial: created } },
          );
        }
        throw error;
      }
    });

  task
    .command("show")
    .description("Show one task")
    .argument("<id>", "task id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, commandOptions) => {
      const result = await showTask({ root: await resolveRoot(commandOptions.root), id });
      emit(output, result, commandOptions.json, formatTask);
    });

  task
    .command("list")
    .description("List tasks")
    .addOption(
      new Option("--status <status>", "filter by task status").choices(TASK_WRITE_STATUSES),
    )
    .addOption(
      new Option("--archived <scope>", "archive scope")
        .choices(["live", "archived", "all"])
        .default("live"),
    )
    .option("--limit <n>", "page size", "50")
    .option("--cursor <cursor>", "continue after this task id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const result = await listWithArchiveFilter({
        root: await resolveRoot(commandOptions.root),
        ...(commandOptions.status === undefined
          ? {}
          : { status: commandOptions.status as (typeof TASK_WRITE_STATUSES)[number] }),
        archived: commandOptions.archived as ArchiveFilter,
        limit: parseLimit(commandOptions.limit),
        ...(commandOptions.cursor === undefined ? {} : { cursor: commandOptions.cursor }),
      });
      emit(output, result, commandOptions.json, formatList);
      if (result.issues.length > 0) output.setExitCode(1);
    });

  task
    .command("status")
    .description("Set task status")
    .argument("<id>", "task id")
    .argument("<status>", "active, paused, done, cancelled, or superseded")
    .option("--expected-revision <n>", "require the current revision")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, status, commandOptions) => {
      if (!TASK_WRITE_STATUSES.includes(status as (typeof TASK_WRITE_STATUSES)[number])) {
        throw new TaskError(
          "TASK_INVALID",
          `status must be one of: ${TASK_WRITE_STATUSES.join(", ")}`,
        );
      }
      const result = await updateTaskStatus({
        root: await resolveRoot(commandOptions.root),
        id,
        status,
        ...(commandOptions.expectedRevision === undefined
          ? {}
          : {
              expectedRevision: parseNonnegativeInteger(
                commandOptions.expectedRevision,
                "--expected-revision",
              ),
            }),
      });
      emit(output, result, commandOptions.json, formatTask);
    });

  task
    .command("checkpoint")
    .description("Write an exact UTF-8 Markdown handoff checkpoint")
    .argument("<id>", "task id")
    .requiredOption("--from <handoff.md>", "UTF-8 Markdown handoff file")
    .option("--expected-revision <n>", "require the current revision")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, commandOptions) => {
      const result = await checkpointTask({
        root: await resolveRoot(commandOptions.root),
        id,
        handoff: await readUtf8Markdown(commandOptions.from),
        ...(commandOptions.expectedRevision === undefined
          ? {}
          : {
              expectedRevision: parseNonnegativeInteger(
                commandOptions.expectedRevision,
                "--expected-revision",
              ),
            }),
      });
      emit(output, result, commandOptions.json, formatTask);
    });

  task
    .command("finish")
    .description("Finish a task")
    .argument("<id>", "task id")
    .option("--expected-revision <n>", "require the current revision")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, commandOptions) => {
      const result = await finishTask({
        root: await resolveRoot(commandOptions.root),
        id,
        ...(commandOptions.expectedRevision === undefined
          ? {}
          : {
              expectedRevision: parseNonnegativeInteger(
                commandOptions.expectedRevision,
                "--expected-revision",
              ),
            }),
      });
      if (commandOptions.json) writeJson(output, hintedResult(result, "task finish"));
      else writeLine(output, withHintLines(formatTask(result), "task finish"));
    });

  task
    .command("archive")
    .description("Archive a terminal task")
    .argument("<id>", "task id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, commandOptions) => {
      const result = await archiveTask({ root: await resolveRoot(commandOptions.root), id });
      emit(output, result, commandOptions.json, formatTask);
    });

  task
    .command("bind")
    .description("Bind a context to a task")
    .argument("<id>", "task id")
    .requiredOption("--context <key>", "context key")
    .option("--rebind", "replace a different existing binding")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, commandOptions) => {
      const result = await bindTask({
        root: await resolveRoot(commandOptions.root),
        id,
        contextKey: commandOptions.context,
        rebind: commandOptions.rebind ?? false,
      });
      emit(output, result, commandOptions.json, formatBinding);
    });

  task
    .command("clear")
    .description("Clear one task context binding")
    .requiredOption("--context <key>", "context key")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const result = await clearTaskContext({
        root: await resolveRoot(commandOptions.root),
        contextKey: commandOptions.context,
      });
      emit(output, result, commandOptions.json, formatBinding);
    });

  task
    .command("current")
    .description("Show the task selected by explicit id or exact context")
    .option("--id <id>", "explicit task id (takes precedence over context)")
    .option("--context <key>", "context key")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (commandOptions) => {
      const result = await currentTask({
        root: await resolveRoot(commandOptions.root),
        ...(commandOptions.id === undefined ? {} : { id: commandOptions.id }),
        ...(commandOptions.context === undefined ? {} : { contextKey: commandOptions.context }),
      });
      emit(output, result, commandOptions.json, formatCurrent);
    });

  task
    .command("context")
    .description("Read a task selected by explicit id or exact context")
    .argument("[id]", "explicit task id (takes precedence over context)")
    .option("--context <key>", "context key")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, commandOptions) => {
      const root = await resolveRoot(commandOptions.root);
      const selected = await contextTask({
        root,
        ...(id === undefined ? {} : { id }),
        ...(commandOptions.context === undefined ? {} : { contextKey: commandOptions.context }),
      });
      const result =
        selected.task_id === undefined
          ? selected
          : { ...selected, record: await showTask({ root, id: selected.task_id }) };
      emit(output, result, commandOptions.json, formatContext);
    });

  task
    .command("relations")
    .description("Replace all relations for a task")
    .argument("<id>", "task id")
    .option("--relation <type:id...>", "typed task relation")
    .addOption(new Option("--clear", "clear all relations").conflicts("relation"))
    .option("--expected-revision <n>", "require the current revision")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, commandOptions) => {
      if (!commandOptions.clear && commandOptions.relation === undefined) {
        throw new TaskError(
          "TASK_RELATION_INVALID",
          "relations requires --relation <type:id...> or explicit --clear",
        );
      }
      const result = await setTaskRelations({
        root: await resolveRoot(commandOptions.root),
        id,
        relations: commandOptions.clear ? [] : parseRelations(commandOptions.relation),
        ...(commandOptions.expectedRevision === undefined
          ? {}
          : {
              expectedRevision: parseNonnegativeInteger(
                commandOptions.expectedRevision,
                "--expected-revision",
              ),
            }),
      });
      emit(output, result, commandOptions.json, formatTask);
    });

  task
    .command("validate")
    .description("Validate one or all tasks without writing")
    .argument("[id]", "task id; omit to validate all tasks")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, commandOptions) => {
      const result = await validateTasks({
        root: await resolveRoot(commandOptions.root),
        ...(id === undefined ? {} : { id }),
      });
      emit(output, result, commandOptions.json, formatValidation);
      if (!result.valid) output.setExitCode(1);
    });
}
