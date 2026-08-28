import { z } from "zod";

export const systemVcsSchema = z.enum(["independent-git", "embedded", "none"]);
export const systemStatusSchema = z.enum(["primary", "active", "archived", "superseded"]);
export const systemRecordSchema = z
  .object({
    path: z.string().min(1),
    status: systemStatusSchema,
    vcs: systemVcsSchema,
    vcs_ref: z.string(),
    version: z.string(),
    supersedes: z.array(z.string().min(1)),
    absorbed_on: z.string().min(1).optional(),
    archived_on: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.status === "superseded") {
      if (!record.absorbed_on)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["absorbed_on"],
          message: "superseded system must record absorbed_on",
        });
      if (record.archived_on)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["archived_on"],
          message: "superseded system must not record archived_on",
        });
      return;
    }
    if (record.status === "archived") {
      if (!record.archived_on)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["archived_on"],
          message: "archived system must record archived_on",
        });
      if (record.absorbed_on)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["absorbed_on"],
          message: "archived system must not record absorbed_on",
        });
      return;
    }
    if (record.absorbed_on || record.archived_on)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: record.absorbed_on ? ["absorbed_on"] : ["archived_on"],
        message: "live system must not record lifecycle transition dates",
      });
  });
export const systemsRegistrySchema = z
  .object({
    __schema: z.literal(3),
    primary: z.string().min(1),
    systems: z.record(systemRecordSchema),
    updated_at: z.string().min(1),
  })
  .strict();

export type SystemVcs = z.infer<typeof systemVcsSchema>;
export type SystemStatus = z.infer<typeof systemStatusSchema>;
export type SystemRecord = z.infer<typeof systemRecordSchema>;
export type SystemsRegistry = z.infer<typeof systemsRegistrySchema>;
