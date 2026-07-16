import { z } from "zod";
import { OpenCanonFailureSchema } from "./errors.ts";
import { ProtocolAuthorization, operationMetadata, type ProtocolOperationDefinition } from "./protocol.ts";
import { ProtocolOperations } from "./protocol-operations.ts";

export type OpenCanonOpenApiDocument = {
  openapi: "3.1.1";
  info: { title: string; version: string };
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    securitySchemes: Record<string, Record<string, string>>;
    schemas: Record<string, Record<string, unknown>>;
  };
};

export function createOpenCanonOpenApiDocument(
  operations: readonly ProtocolOperationDefinition[] = ProtocolOperations,
): OpenCanonOpenApiDocument {
  const paths: OpenCanonOpenApiDocument["paths"] = {};
  for (const operation of operations) {
    const pathItem = paths[operation.path] ?? {};
    pathItem[operation.method.toLowerCase()] = openApiOperation(operation);
    paths[operation.path] = pathItem;
  }
  return {
    openapi: "3.1.1",
    info: { title: "OpenCanon Domain Protocol", version: "1" },
    paths: sortRecord(paths),
    components: {
      securitySchemes: {
        projectToken: { type: "apiKey", in: "header", name: "authorization" },
      },
      schemas: {
        OpenCanonFailure: jsonSchemaFor(OpenCanonFailureSchema),
      },
    },
  };
}

function openApiOperation(operation: ProtocolOperationDefinition): Record<string, unknown> {
  const metadata = operationMetadata(operation);
  const requestSchema = jsonSchemaFor(operation.inputSchema);
  const dataSchema = jsonSchemaFor(operation.outputSchema);
  return {
    operationId: operation.id,
    tags: [operation.id.split(".")[0]],
    security: operation.authorization === ProtocolAuthorization.Public ? [] : [{ projectToken: [] }],
    "x-opencanon-policy": metadata,
    "x-opencanon-input": requestSchema,
    responses: {
      "200": {
        description: "Successful OpenCanon response.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["ok", "data"],
              properties: { ok: { const: true }, data: dataSchema },
            },
          },
        },
      },
      default: {
        description: "Structured OpenCanon failure.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/OpenCanonFailure" } } },
      },
    },
  };
}

function cleanJsonSchema(schema: unknown): Record<string, unknown> {
  const { $schema: _schema, ...rest } = schema as Record<string, unknown>;
  return rest;
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return cleanJsonSchema(z.toJSONSchema(schema, { unrepresentable: "any", reused: "inline" }));
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}
