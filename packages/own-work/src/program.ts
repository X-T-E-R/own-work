import path from "node:path";

import { Command, Option } from "@commander-js/extra-typings";
import {
  PRODUCT_VERSION,
  discoverFrameworkRoot,
  resolveEnvelopeContext,
} from "absorb-anything-core";
import { migrateOwnWorkEnvelope } from "./coordination.js";
import { mapCliError } from "./errors.js";
import { checkOwnWork, getOwnWorkStatus, initOwnWork, primeOwnWork } from "./lifecycle.js";
import { addRoadmapCommand } from "./roadmap-command.js";
import type { SystemVcs } from "./schemas.js";
import { SEMANTIC_TOPICS, requireObjectSemantics, semanticDigestSentence } from "./semantics.js";
import { addSpecCommand } from "./spec-command.js";
import {
  type SystemEntry,
  archiveSystem,
  findSystemEntry,
  listSystems,
  promoteSystem,
  registerSystem,
  requireSystemsRegistry,
  updateSystem,
} from "./systems-registry.js";
import { addTaskCommand } from "./task-command.js";

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}
export interface CreateProgramOptions {
  readonly output?: Partial<CliOutput>;
}

function defaultOutput(): CliOutput {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}
function createOutput(options?: CreateProgramOptions): CliOutput {
  const fallback = defaultOutput();
  return {
    stdout: options?.output?.stdout ?? fallback.stdout,
    stderr: options?.output?.stderr ?? fallback.stderr,
    setExitCode: options?.output?.setExitCode ?? fallback.setExitCode,
  };
}
function emit(output: Pick<CliOutput, "stdout">, value: unknown, json = false): void {
  output.stdout(`${json || typeof value !== "string" ? JSON.stringify(value, null, 2) : value}\n`);
}
async function rootFor(input: string): Promise<string> {
  return discoverFrameworkRoot(input);
}
function splitList(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
function formatSystem(entry: SystemEntry): string {
  return [
    `${entry.selector} (${entry.system.status})`,
    `  path: ${entry.system.path}`,
    `  vcs: ${entry.system.vcs}${entry.system.vcs_ref ? `@${entry.system.vcs_ref}` : ""}`,
    `  version: ${entry.system.version}`,
    `  supersedes: ${entry.system.supersedes.join(", ") || "-"}`,
  ].join("\n");
}
function formatSystemList(primary: string, entries: readonly SystemEntry[]): string {
  if (entries.length === 0) return "Registered Systems\n(none)";
  return [
    "Registered Systems",
    ...entries.map(({ selector, system }) => {
      const marker = selector === primary ? "*" : " ";
      const supersedes =
        system.supersedes.length > 0 ? ` supersedes ${system.supersedes.join(",")}` : "";
      return `${marker} ${system.status.padEnd(11)} ${selector.padEnd(28)} ${system.vcs} v${system.version}${supersedes}`;
    }),
    "",
    `${entries.length} system(s), primary: ${primary}`,
  ].join("\n");
}

function addSystemCommand(program: Command, output: CliOutput): void {
  const system = program.command("system").description("System registry operations");
  system
    .command("register")
    .description("Register a System directory")
    .argument("<path>")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--name <name>")
    .addOption(new Option("--vcs <vcs>").choices(["independent-git", "embedded", "none"]))
    .option("--vcs-ref <ref>")
    .option("--system-version <version>")
    .option("--primary")
    .option("--supersedes <names>")
    .option("--json")
    .action(async (systemPath, options) => {
      const root = await rootFor(options.root);
      const result = await registerSystem(root, {
        path: systemPath,
        ...(options.name ? { name: options.name } : {}),
        ...(options.vcs ? { vcs: options.vcs as SystemVcs } : {}),
        ...(options.vcsRef ? { vcsRef: options.vcsRef } : {}),
        ...(options.systemVersion ? { version: options.systemVersion } : {}),
        primary: options.primary ?? false,
        supersedes: splitList(options.supersedes) ?? [],
      });
      const envelope = await resolveEnvelopeContext(root);
      const registryPath = path
        .relative(root, path.join(envelope.path, "systems-registry.json"))
        .replaceAll("\\", "/");
      emit(
        output,
        options.json
          ? result
          : `Registered system: ${result.selector}\nStatus: ${result.system.status}\nRegistry: ${registryPath}\nEvent: ${result.eventFile}`,
        options.json,
      );
    });
  system
    .command("update")
    .description("Update System metadata")
    .argument("<selector>")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--path <path>")
    .addOption(new Option("--vcs <vcs>").choices(["independent-git", "embedded", "none"]))
    .option("--vcs-ref <ref>")
    .option("--system-version <version>")
    .option("--primary")
    .option("--supersedes <names>")
    .option("--json")
    .action(async (selector, options) => {
      const supersedes = splitList(options.supersedes);
      const root = await rootFor(options.root);
      const result = await updateSystem(root, selector, {
        ...(options.path ? { path: options.path } : {}),
        ...(options.vcs ? { vcs: options.vcs as SystemVcs } : {}),
        ...(options.vcsRef ? { vcsRef: options.vcsRef } : {}),
        ...(options.systemVersion ? { version: options.systemVersion } : {}),
        ...(options.primary ? { primary: true } : {}),
        ...(supersedes === undefined ? {} : { supersedes }),
      });
      const envelope = await resolveEnvelopeContext(root);
      emit(
        output,
        options.json
          ? result
          : `Updated system: ${result.selector}\nStatus: ${result.system.status}\nRegistry: ${envelope.directory}/systems-registry.json\nChanged fields: ${result.changes.map((change) => change.field).join(", ") || "(none)"}\nEvent: ${result.eventFile}`,
        options.json,
      );
    });
  system
    .command("promote")
    .description("Promote a System to primary")
    .argument("<selector>")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--json")
    .action(async (selector, options) => {
      const result = await promoteSystem(await rootFor(options.root), selector);
      emit(
        output,
        options.json
          ? result
          : `Promoted: ${result.selector}${result.previousPrimary ? `\nPrevious primary: ${result.previousPrimary.selector} (now superseded)` : ""}\nEvent: ${result.eventFile}`,
        options.json,
      );
    });
  system
    .command("archive")
    .description("Logically archive a non-primary System")
    .argument("<selector>")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .addOption(new Option("--dry-run").conflicts("apply"))
    .addOption(new Option("--apply").conflicts("dryRun"))
    .option("--json")
    .action(async (selector, options) => {
      const result = await archiveSystem(await rootFor(options.root), selector, {
        dryRun: options.dryRun ?? !options.apply,
      });
      emit(
        output,
        options.json
          ? result
          : `System archive: ${result.dryRun ? "dry-run" : "applied"}\nSystem: ${result.selector}\nArchive mode: logical (locator unchanged; no files moved)${result.eventFile ? `\nEvent: ${result.eventFile}` : ""}`,
        options.json,
      );
    });
  system
    .command("list")
    .description("List registered Systems")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .addOption(
      new Option("--status <status>").choices(["primary", "active", "superseded", "archived"]),
    )
    .option("--json")
    .action(async (options) => {
      const result = await listSystems(await rootFor(options.root));
      const items = options.status
        ? result.systems.filter((entry) => entry.system.status === options.status)
        : result.systems;
      emit(
        output,
        options.json
          ? {
              primary: result.registry.primary,
              systems: items.map(({ selector, system }) => ({ selector, ...system })),
            }
          : formatSystemList(result.registry.primary, items),
        options.json,
      );
    });
  system
    .command("show")
    .description("Show one registered System")
    .argument("<selector>")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--json")
    .action(async (selector, options) => {
      const root = await rootFor(options.root);
      const entry = await findSystemEntry(await requireSystemsRegistry(root), selector);
      emit(
        output,
        options.json ? { selector: entry.selector, ...entry.system } : formatSystem(entry),
        options.json,
      );
    });
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const output = createOutput(options);
  const program = new Command()
    .name("ownwork")
    .description("Build your own work with Tasks, Roadmaps, Specs, and Systems.")
    .version(PRODUCT_VERSION)
    .configureOutput({ writeOut: output.stdout, writeErr: output.stderr });

  program
    .command("init")
    .description("Initialize an overlay workspace; use --standalone for a dedicated workbench")
    .argument("[target]", "target workspace directory", process.cwd())
    .option("--name <project-name>")
    .option("--standalone")
    .option("--git")
    .option("--force")
    .option("--create-new")
    .option("--no-agents")
    .option("--json")
    .action(async (target, commandOptions) => {
      const result = await initOwnWork({
        target,
        ...(commandOptions.name ? { name: commandOptions.name } : {}),
        standalone: commandOptions.standalone ?? false,
        git: commandOptions.git ?? false,
        force: commandOptions.force ?? false,
        createNew: commandOptions.createNew ?? false,
        agents: commandOptions.agents,
      });
      emit(
        output,
        commandOptions.json
          ? result
          : `Initialized ${result.mode} workspace: ${result.root}\nEnvelope: ${result.createdEnvelope ? "created" : "reused"}\nSystem registry: ${result.createdRegistry ? `created (${result.system})` : "reused or deferred"}`,
        commandOptions.json,
      );
    });
  program
    .command("check")
    .description("Check common envelope and own-work records")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--json")
    .action(async (commandOptions) => {
      const result = await checkOwnWork({ root: await rootFor(commandOptions.root) });
      emit(
        output,
        commandOptions.json
          ? result
          : result.rows
              .map(
                (row) =>
                  `${row.status.toUpperCase()} ${row.path}${row.message ? ` — ${row.message}` : ""}`,
              )
              .join("\n"),
        commandOptions.json,
      );
      if (!result.ok) output.setExitCode(1);
    });
  program
    .command("status")
    .description("Show common envelope and own-work state")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--json")
    .action(async (commandOptions) => {
      const result = await getOwnWorkStatus({ root: await rootFor(commandOptions.root) });
      const human = result.common.hasManifest
        ? [
            "Own Work status",
            `Root: ${result.common.root}`,
            `Envelope: ${result.common.envelope}`,
            `Project: ${result.common.project ?? "unknown"}`,
            `Tasks: ${result.tasks}`,
            `Roadmaps: ${result.roadmaps}`,
            `Specs: ${result.specs}`,
            `Systems: ${result.systems}`,
            `Primary System: ${result.primarySystem ?? "none"}`,
          ].join("\n")
        : `Own Work status\nRoot: ${result.common.root}\nWorkspace: not initialized`;
      emit(output, commandOptions.json ? result : human, commandOptions.json);
    });
  program
    .command("migrate-envelope")
    .description("Rename a legacy envelope to .absorb")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--json")
    .action(async (commandOptions) => {
      const result = await migrateOwnWorkEnvelope(commandOptions.root);
      emit(
        output,
        commandOptions.json
          ? result
          : result.changed
            ? `Migrated envelope: ${result.from} -> ${result.to}`
            : `Envelope already current: ${result.to}`,
        commandOptions.json,
      );
    });
  program
    .command("prime")
    .description("Orient a session to own-work objects and current state")
    .option("--root <target-dir>", "workspace root", process.cwd())
    .option("--json")
    .action(async (commandOptions) => {
      const result = await primeOwnWork({ root: await rootFor(commandOptions.root) });
      const human = [
        "Own Work prime",
        `Root: ${result.root}`,
        ...result.semantics.map(semanticDigestSentence),
        result.workspace
          ? `Workspace: ${result.workspace.envelope}; Tasks ${result.workspace.tasks}; Roadmaps ${result.workspace.roadmaps}; Specs ${result.workspace.specs}; Systems ${result.workspace.systems}`
          : "Workspace: not initialized",
        `Details: ${result.detailsCommand}`,
      ].join("\n");
      emit(output, commandOptions.json ? result : human, commandOptions.json);
    });
  program
    .command("explain")
    .description(`Explain an object (${SEMANTIC_TOPICS.join(", ")})`)
    .argument("<topic>")
    .option("--json")
    .action(async (topic, commandOptions) => {
      const entry = requireObjectSemantics(topic);
      const human = [
        `${entry.label} — ${entry.purpose}`,
        `Most-broken rule: ${entry.antiRule}`,
        "Why it exists:",
        ...entry.whyItExists.map((line) => `- ${line}`),
        "When not to use it:",
        ...entry.whenNotToUse.map((line) => `- ${line}`),
        "Common misuses:",
        ...entry.commonMisuses.map((line) => `- ${line}`),
        "Commands:",
        ...entry.commands.map((line) => `- ${line}`),
      ].join("\n");
      emit(output, commandOptions.json ? entry : human, commandOptions.json);
    });

  addTaskCommand(program, { output, resolveRoot: rootFor });
  addRoadmapCommand(program, { output, resolveRoot: rootFor });
  addSpecCommand(program, { output, resolveRoot: rootFor });
  addSystemCommand(program, output);
  return program;
}

export async function runCli(
  argv: readonly string[],
  options: CreateProgramOptions = {},
): Promise<number> {
  let exitCode = 0;
  const runtimeOutput = createOutput(options);
  const output = {
    ...runtimeOutput,
    setExitCode: (code: number) => {
      exitCode = code;
      runtimeOutput.setExitCode(code);
    },
  };
  const program = createProgram({ ...options, output }).exitOverride();
  try {
    await program.parseAsync([...argv], { from: "node" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "commander.helpDisplayed")
      return 0;
    if (error instanceof Error && "exitCode" in error && typeof error.exitCode === "number")
      return error.exitCode;
    const failure = mapCliError(error);
    runtimeOutput.stderr(`${failure.message}\n`);
    return failure.exitCode;
  }
  return exitCode;
}
