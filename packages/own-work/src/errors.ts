import { FrameworkError, type FrameworkErrorCode } from "absorb-anything-core";
import { RoadmapError } from "./roadmap.js";
import { SpecError } from "./spec.js";
import { TaskError } from "./task.js";

const INTERNAL_ERROR_CODES = new Set<FrameworkErrorCode>([
  "INVALID_MANIFEST",
  "INVALID_EVENT",
  "INVALID_OPERATION_REPORT",
  "INVALID_UPDATE_PLAN",
]);
export interface CliFailure {
  readonly exitCode: number;
  readonly message: string;
}
export function mapCliError(error: unknown): CliFailure {
  if (error instanceof SpecError || error instanceof RoadmapError || error instanceof TaskError)
    return { exitCode: 1, message: `Error [${error.code}]: ${error.message}` };
  if (error instanceof FrameworkError)
    return {
      exitCode: 1,
      message: `${INTERNAL_ERROR_CODES.has(error.code) ? "Runtime error" : "Error"}: ${error.message}`,
    };
  if (error instanceof Error) return { exitCode: 1, message: `Runtime error: ${error.message}` };
  return { exitCode: 1, message: `Runtime error: ${String(error)}` };
}
