import { z } from "zod";
import { ChangeCheckKind } from "./change.ts";

export const ChangeCheckRunStatus = {
  Queued: "queued",
  Running: "running",
  Passed: "passed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type ChangeCheckRunStatus = (typeof ChangeCheckRunStatus)[keyof typeof ChangeCheckRunStatus];

export const ChangeCheckRunEventType = {
  Queued: "queued",
  Started: "started",
  Stdout: "stdout",
  Stderr: "stderr",
  Passed: "passed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type ChangeCheckRunEventType = (typeof ChangeCheckRunEventType)[keyof typeof ChangeCheckRunEventType];

const ChangeCheckKindSchema = z.enum([
  ChangeCheckKind.Command,
  ChangeCheckKind.Doctor,
  ChangeCheckKind.Validator,
  ChangeCheckKind.Test,
]);

const ChangeCheckRunBaseSchema = z.object({
  id: z.string().min(1),
  batchId: z.string().min(1),
  kind: z.literal("change-check"),
  changeId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  checkId: z.string().min(1),
  checkKind: ChangeCheckKindSchema,
  actor: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  outputTail: z.string(),
  outputBytes: z.number().int().min(0),
  outputTruncated: z.boolean(),
});

export const ChangeCheckRunSchema = z.discriminatedUnion("status", [
  ChangeCheckRunBaseSchema.extend({ status: z.literal(ChangeCheckRunStatus.Queued) }),
  ChangeCheckRunBaseSchema.extend({
    status: z.literal(ChangeCheckRunStatus.Running),
    startedAt: z.string().datetime(),
  }),
  ChangeCheckRunBaseSchema.extend({
    status: z.literal(ChangeCheckRunStatus.Passed),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    summary: z.string().min(1),
    exitCode: z.union([z.number().int(), z.string().min(1)]).optional(),
    signal: z.string().min(1).optional(),
  }),
  ChangeCheckRunBaseSchema.extend({
    status: z.literal(ChangeCheckRunStatus.Failed),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    summary: z.string().min(1),
    exitCode: z.union([z.number().int(), z.string().min(1)]).optional(),
    signal: z.string().min(1).optional(),
    interrupted: z.boolean().optional(),
  }),
  ChangeCheckRunBaseSchema.extend({
    status: z.literal(ChangeCheckRunStatus.Cancelled),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime(),
    summary: z.string().min(1),
    signal: z.string().min(1).optional(),
  }),
]);
export type ChangeCheckRun = z.infer<typeof ChangeCheckRunSchema>;

const ChangeCheckRunEventBaseSchema = z.object({
  runId: z.string().min(1),
  batchId: z.string().min(1),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
});

const ChangeCheckRunEventUnionSchema = z.discriminatedUnion("type", [
  ChangeCheckRunEventBaseSchema.extend({ type: z.literal(ChangeCheckRunEventType.Queued) }),
  ChangeCheckRunEventBaseSchema.extend({ type: z.literal(ChangeCheckRunEventType.Started) }),
  ChangeCheckRunEventBaseSchema.extend({ type: z.literal(ChangeCheckRunEventType.Stdout), text: z.string().min(1) }),
  ChangeCheckRunEventBaseSchema.extend({ type: z.literal(ChangeCheckRunEventType.Stderr), text: z.string().min(1) }),
  ChangeCheckRunEventBaseSchema.extend({ type: z.literal(ChangeCheckRunEventType.Passed), run: ChangeCheckRunSchema }),
  ChangeCheckRunEventBaseSchema.extend({ type: z.literal(ChangeCheckRunEventType.Failed), run: ChangeCheckRunSchema }),
  ChangeCheckRunEventBaseSchema.extend({ type: z.literal(ChangeCheckRunEventType.Cancelled), run: ChangeCheckRunSchema }),
]);
export const ChangeCheckRunEventSchema = ChangeCheckRunEventUnionSchema.superRefine((event, context) => {
  const expected = event.type === ChangeCheckRunEventType.Passed
    ? ChangeCheckRunStatus.Passed
    : event.type === ChangeCheckRunEventType.Failed
      ? ChangeCheckRunStatus.Failed
      : event.type === ChangeCheckRunEventType.Cancelled
        ? ChangeCheckRunStatus.Cancelled
        : undefined;
  if (expected && "run" in event && event.run.status !== expected) {
    context.addIssue({ code: "custom", path: ["run", "status"], message: `${event.type} events require a ${expected} run.` });
  }
});
export type ChangeCheckRunEvent = z.infer<typeof ChangeCheckRunEventSchema>;

export const StartChangeCheckRunsResponseSchema = z.object({
  batchId: z.string().min(1),
  runs: z.array(ChangeCheckRunSchema).min(1),
});
export type StartChangeCheckRunsResponse = z.infer<typeof StartChangeCheckRunsResponseSchema>;
