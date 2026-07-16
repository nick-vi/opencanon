import { z } from "zod";
import { CanonEventSchema, ProductModelProjectionSchema } from "./contracts-governance.ts";
import { PersistedProjectProtocolEventDraftSchema, ProjectProtocolEventSchema } from "./protocol.ts";

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const CodeGraphGenerationSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const ProjectPublicationStateSchema = z.object({
  revision: PositiveSafeIntegerSchema,
  activeCodeGraphGeneration: CodeGraphGenerationSchema,
  publishedAt: z.string().datetime(),
}).strict();
export type ProjectPublicationState = z.infer<typeof ProjectPublicationStateSchema>;

export const PublishProjectStateRequestSchema = z.object({
  revision: PositiveSafeIntegerSchema,
  codeGraphGeneration: CodeGraphGenerationSchema.optional(),
  productModel: ProductModelProjectionSchema.optional(),
  canonEvent: CanonEventSchema.optional(),
  protocolEvent: PersistedProjectProtocolEventDraftSchema,
  maxProtocolEventCount: z.number().int().positive(),
  retainProtocolEventsAfter: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.codeGraphGeneration) !== Boolean(value.productModel)) {
    context.addIssue({
      code: "custom",
      message: "A Project State publication must include both the code graph generation and product model, or neither.",
    });
  }
  if (value.protocolEvent.revision !== value.revision) {
    context.addIssue({
      code: "custom",
      path: ["protocolEvent", "revision"],
      message: "A Project State publication revision must match its protocol event revision.",
    });
  }
});
export type PublishProjectStateRequest = z.infer<typeof PublishProjectStateRequestSchema>;

export const PublishProjectStateResultSchema = z.object({
  publication: ProjectPublicationStateSchema,
  event: ProjectProtocolEventSchema,
}).strict();
export type PublishProjectStateResult = z.infer<typeof PublishProjectStateResultSchema>;
