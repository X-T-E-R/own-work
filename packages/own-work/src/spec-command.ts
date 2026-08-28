import path from "node:path";

import { type Command, Option } from "@commander-js/extra-typings";
import {
  SPEC_STATES,
  SPEC_STRENGTHS,
  SpecError,
  type SpecRecordResult,
  activateSpec,
  archiveSpec,
  createSpec,
  listSpecs,
  promoteSpec,
  replaceSpec,
  retireSpec,
  showSpec,
  updateSpec,
  validateSpecs,
} from "./spec.js";

import { hintedResult, withHintLines } from "./hints.js";

interface Output {
  readonly stdout: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

interface Dependencies {
  readonly output: Output;
  readonly resolveRoot: (root: string) => Promise<string>;
}

function emit(output: Output, value: unknown, json: boolean | undefined, formatted: string): void {
  output.stdout(`${json ? JSON.stringify(value, null, 2) : formatted}\n`);
}

function nonnegative(value: string, option: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new SpecError("SPEC_INVALID", `${option} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new SpecError("SPEC_INVALID", `${option} exceeds the safe integer range`);
  }
  return parsed;
}

function optionalRevision(value: string | undefined): { readonly expectedRevision?: number } {
  return value === undefined ? {} : { expectedRevision: nonnegative(value, "--expected-revision") };
}

function formatRecord(result: SpecRecordResult): string {
  const provenance = result.item.derived_from
    .map((entry) =>
      entry.kind === "assay.analysis"
        ? `${entry.kind}:${entry.path}@${entry.sha256}`
        : `${entry.kind}:${entry.id}/${entry.file}@${entry.sha256}`,
    )
    .join(", ");
  return [
    `Spec: ${result.item.id}`,
    `Path: ${result.path}`,
    `Title: ${result.item.title}`,
    `State: ${result.item.state}`,
    `Scope: ${result.item.scope.kind}:${result.item.scope.id}`,
    `Strength: ${result.item.strength}`,
    `Revision: ${result.item.revision}`,
    `Archived: ${result.archived ? "yes" : "no"}`,
    `Derived from: ${provenance || "(none)"}`,
    `Superseded by: ${result.item.superseded_by.join(", ") || "(none)"}`,
    "",
    result.specification,
  ].join("\n");
}

export function addSpecCommand(program: Command, dependencies: Dependencies): void {
  const { output, resolveRoot } = dependencies;
  const spec = program.command("spec").description("Manage native Project specifications");

  spec
    .command("create")
    .requiredOption("--title <text>", "spec title")
    .requiredOption("--scope <project-or-system>", "project or system:<registered-id>")
    .addOption(
      new Option("--strength <strength>", "normative strength")
        .choices(SPEC_STRENGTHS)
        .makeOptionMandatory(),
    )
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (options) => {
      const result = await createSpec({
        root: await resolveRoot(options.root),
        title: options.title,
        scope: options.scope,
        strength: options.strength as (typeof SPEC_STRENGTHS)[number],
      });
      emit(output, result, options.json, formatRecord(result));
    });

  spec
    .command("promote")
    .requiredOption("--title <text>", "spec title")
    .requiredOption("--scope <project-or-system>", "project or system:<registered-id>")
    .addOption(
      new Option("--strength <strength>", "normative strength")
        .choices(SPEC_STRENGTHS)
        .makeOptionMandatory(),
    )
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .requiredOption("--body <file>", "clean specification body to copy")
    .option("--from-analysis <logical-path>", "logical analyses/... source path")
    .option("--from-task <task-id>", "exact native Task source id")
    .option("--task-file <relative-file>", "allowed Task-relative source file")
    .action(async (options) => {
      const result = await promoteSpec({
        root: await resolveRoot(options.root),
        title: options.title,
        scope: options.scope,
        strength: options.strength as (typeof SPEC_STRENGTHS)[number],
        bodyFile: path.resolve(options.body),
        ...(options.fromAnalysis === undefined ? {} : { fromAnalysis: options.fromAnalysis }),
        ...(options.fromTask === undefined ? {} : { fromTask: options.fromTask }),
        ...(options.taskFile === undefined ? {} : { taskFile: options.taskFile }),
      });
      emit(
        output,
        hintedResult(result, "spec promote"),
        options.json,
        withHintLines(formatRecord(result), "spec promote"),
      );
    });

  spec
    .command("show")
    .argument("<id>", "exact spec id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      const result = await showSpec({ root: await resolveRoot(options.root), id });
      emit(output, result, options.json, formatRecord(result));
    });

  spec
    .command("list")
    .addOption(new Option("--state <state>", "filter by state").choices(SPEC_STATES))
    .option("--scope <scope>", "project or exact kind:id scope")
    .addOption(new Option("--strength <strength>", "filter by strength").choices(SPEC_STRENGTHS))
    .addOption(
      new Option("--archived <scope>", "archive scope")
        .choices(["live", "archived", "all"])
        .default("live"),
    )
    .option("--limit <n>", "page size", "50")
    .option("--cursor <id>", "continue after this exact spec id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (options) => {
      const limit = nonnegative(options.limit, "--limit");
      const result = await listSpecs({
        root: await resolveRoot(options.root),
        ...(options.state === undefined
          ? {}
          : { state: options.state as (typeof SPEC_STATES)[number] }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.strength === undefined
          ? {}
          : { strength: options.strength as (typeof SPEC_STRENGTHS)[number] }),
        archived: options.archived as "live" | "archived" | "all",
        limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      });
      const lines = result.items.map((item) =>
        [
          item.id,
          item.state,
          `${item.scope.kind}:${item.scope.id}`,
          item.strength,
          item.archived ? "archived" : "live",
          item.title,
        ].join("\t"),
      );
      if (lines.length === 0) lines.push("No specs.");
      if (result.next_cursor) lines.push(`Next cursor: ${result.next_cursor}`);
      for (const issue of result.issues) {
        lines.push(`Issue ${issue.code}: ${issue.id ?? "spec"}: ${issue.message}`);
      }
      emit(output, result, options.json, lines.join("\n"));
      if (result.issues.length > 0) output.setExitCode(1);
    });

  spec
    .command("update")
    .argument("<id>", "exact spec id")
    .option("--title <text>", "replace title without changing id")
    .option("--scope <project-or-system>", "project or system:<registered-id>")
    .addOption(new Option("--strength <strength>", "replace strength").choices(SPEC_STRENGTHS))
    .option("--expected-revision <n>", "require the current revision")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      const result = await updateSpec({
        root: await resolveRoot(options.root),
        id,
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.strength === undefined
          ? {}
          : { strength: options.strength as (typeof SPEC_STRENGTHS)[number] }),
        ...optionalRevision(options.expectedRevision),
      });
      emit(output, result, options.json, formatRecord(result));
    });

  for (const [name, operation] of [
    ["activate", activateSpec],
    ["retire", retireSpec],
  ] as const) {
    spec
      .command(name)
      .argument("<id>", "exact spec id")
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

  spec
    .command("replace")
    .argument("<id>", "exact old spec id")
    .requiredOption("--with <active-successor...>", "one or more active successor ids")
    .option("--expected-revision <n>", "require the current revision")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      const result = await replaceSpec({
        root: await resolveRoot(options.root),
        id,
        with: options.with,
        ...optionalRevision(options.expectedRevision),
      });
      emit(output, result, options.json, formatRecord(result));
    });

  spec
    .command("archive")
    .argument("<id>", "exact retired spec id")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      const result = await archiveSpec({ root: await resolveRoot(options.root), id });
      emit(output, result, options.json, formatRecord(result));
    });

  spec
    .command("validate")
    .argument("[id]", "exact spec id; omit for all")
    .option("--root <target-dir>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      const result = await validateSpecs({
        root: await resolveRoot(options.root),
        ...(id === undefined ? {} : { id }),
      });
      const lines = [result.valid ? "Spec validation passed." : "Spec validation failed."];
      for (const item of result.items) {
        lines.push(`${item.id}: ${item.valid ? "valid" : "invalid"} (${item.path})`);
        for (const issue of item.issues) lines.push(`  ${issue.code}: ${issue.message}`);
      }
      emit(output, result, options.json, lines.join("\n"));
      if (!result.valid) output.setExitCode(1);
    });
}
