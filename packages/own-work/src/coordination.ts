import path from "node:path";

import {
  FrameworkError,
  migrateEnvelopeUncoordinated,
  resolveEnvelopeContext,
  withWorkspaceMutationCoordination as withCoreWorkspaceMutationCoordination,
  withEnvelopeMigrationCoordination,
} from "absorb-anything-core";

export type WorkspaceMutationProbeStage = "before-acquire" | "after-acquire";
type WorkspaceMutationProbe = (
  stage: WorkspaceMutationProbeStage,
  root: string,
  lockPath: string,
) => void | Promise<void>;
type EnvelopeMigrationProbe = (root: string) => void | Promise<void>;

let workspaceMutationProbe: WorkspaceMutationProbe | undefined;
let envelopeMigrationProbe: EnvelopeMigrationProbe | undefined;

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** Test-only observation hook for the shared cross-product mutation gate. */
export function setWorkspaceMutationProbeForTests(probe: WorkspaceMutationProbe | undefined): void {
  workspaceMutationProbe = probe;
}

/** Test-only hold point after own-work acquires the core migration authority. */
export function setEnvelopeMigrationProbeForTests(probe: EnvelopeMigrationProbe | undefined): void {
  envelopeMigrationProbe = probe;
}

/**
 * Delegate writer serialization and reentrancy to the shared core authority.
 * Envelope selection remains inside the acquired callback.
 */
export async function withWorkspaceMutationCoordination<T>(
  rootInput: string,
  callback: () => Promise<T>,
): Promise<T> {
  const root = path.resolve(rootInput);
  await workspaceMutationProbe?.(
    "before-acquire",
    root,
    path.join(root, ".absorb-envelope-migration.lock"),
  );
  return withCoreWorkspaceMutationCoordination(root, async () => {
    const active = await resolveEnvelopeContext(root);
    await workspaceMutationProbe?.(
      "after-acquire",
      root,
      path.join(active.path, "coordination", "workspace-mutation"),
    );
    return callback();
  });
}

/** Retained compatibility name; conversion now uses the shared authorities. */
export async function withWorkspaceConversionCoordination<T>(
  root: string,
  callback: () => Promise<T>,
  _options: { readonly removeStateDirectoryWhenEmpty?: boolean } = {},
): Promise<T> {
  return withWorkspaceMutationCoordination(root, callback);
}

/** Fail before a pre-lock path resolved from an envelope that has since moved. */
export async function assertActiveEnvelopePath(root: string, candidate: string): Promise<void> {
  const context = await resolveEnvelopeContext(root);
  if (!isContained(context.path, candidate)) {
    throw new FrameworkError(
      `workspace envelope changed before mutation; retry against ${context.directory}: ${candidate}`,
    );
  }
}

/** ownwork's migration surface, with a deterministic test hold inside core authority. */
export async function migrateOwnWorkEnvelope(rootInput: string) {
  const root = path.resolve(rootInput);
  return withEnvelopeMigrationCoordination(root, async () => {
    await envelopeMigrationProbe?.(root);
    return migrateEnvelopeUncoordinated(root);
  });
}
