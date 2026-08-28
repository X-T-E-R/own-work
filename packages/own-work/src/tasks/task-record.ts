import { z } from "zod";

const nullableText = z.string().nullable();

export const taskEnvelopeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.string(),
    dev_type: nullableText,
    scope: nullableText,
    package: nullableText,
    priority: z.string(),
    creator: z.string(),
    assignee: z.string(),
    createdAt: z.string(),
    completedAt: nullableText,
    branch: nullableText,
    base_branch: nullableText,
    worktree_path: nullableText,
    commit: nullableText,
    pr_url: nullableText,
    subtasks: z.array(z.string()),
    children: z.array(z.string()),
    parent: nullableText,
    relatedFiles: z.array(z.string()),
    notes: z.string(),
    meta: z.record(z.unknown()),
  })
  .passthrough();

export type TaskEnvelope = z.infer<typeof taskEnvelopeSchema>;

export const TASK_ENVELOPE_KEYS = [
  "id",
  "name",
  "title",
  "description",
  "status",
  "dev_type",
  "scope",
  "package",
  "priority",
  "creator",
  "assignee",
  "createdAt",
  "completedAt",
  "branch",
  "base_branch",
  "worktree_path",
  "commit",
  "pr_url",
  "subtasks",
  "children",
  "parent",
  "relatedFiles",
  "notes",
  "meta",
] as const satisfies readonly (keyof TaskEnvelope)[];

export function newTaskEnvelope(
  values: Pick<TaskEnvelope, "id" | "name" | "title" | "createdAt"> & Partial<TaskEnvelope>,
): TaskEnvelope {
  const { id, name, title, createdAt, ...overrides } = values;
  return taskEnvelopeSchema.parse({
    id,
    name,
    title,
    description: "",
    status: "active",
    dev_type: null,
    scope: null,
    package: null,
    priority: "P2",
    creator: "",
    assignee: "",
    createdAt,
    completedAt: null,
    branch: null,
    base_branch: null,
    worktree_path: null,
    commit: null,
    pr_url: null,
    subtasks: [],
    children: [],
    parent: null,
    relatedFiles: [],
    notes: "",
    meta: {},
    ...overrides,
  });
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
