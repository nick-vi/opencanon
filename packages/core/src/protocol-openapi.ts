import { z } from "zod";
import { OpenCanonFailureSchema } from "./errors.ts";
import {
  DomainProtocolVersion,
  ProtocolAuthorization,
  ProtocolHeader,
  ProtocolIdempotency,
  ProtocolOperationKind,
  operationMetadata,
  type ProtocolOperationDefinition,
} from "./protocol.ts";
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
  const schemas: Record<string, Record<string, unknown>> = {};
  schemas.OpenCanonFailure = schemaWithComponents(OpenCanonFailureSchema, "OpenCanonFailure", schemas);
  for (const operation of operations) {
    const componentPrefix = operationComponentPrefix(operation.id);
    const requestSchema = schemaWithComponents(operation.inputSchema, `${componentPrefix}Input`, schemas);
    const outputName = `${componentPrefix}Output`;
    schemas[outputName] = schemaWithComponents(operation.outputSchema, outputName, schemas);
    const pathItem = paths[operation.path] ?? {};
    pathItem[operation.method.toLowerCase()] = openApiOperation(
      operation,
      requestSchema,
      { $ref: `#/components/schemas/${outputName}` },
    );
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
      schemas: sortRecord(schemas),
    },
  };
}

function openApiOperation(
  operation: ProtocolOperationDefinition,
  requestSchema: Record<string, unknown>,
  dataSchema: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = operationMetadata(operation);
  const parameters = openApiParameters(operation, requestSchema);
  const requestBody = openApiRequestBody(requestSchema);
  return {
    operationId: operation.id,
    tags: [operation.id.split(".")[0]],
    security: operation.authorization === ProtocolAuthorization.Public ? [] : [{ projectToken: [] }],
    "x-opencanon-policy": metadata,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: operation.kind === ProtocolOperationKind.Stream
      ? {
          "200": {
            description: "Replayable OpenCanon event stream.",
            content: {
              "text/event-stream": {
                schema: { type: "string" },
                "x-opencanon-event": dataSchema,
              },
            },
          },
          default: failureResponse(),
        }
      : {
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
          default: failureResponse(),
        },
  };
}

function openApiParameters(operation: ProtocolOperationDefinition, requestSchema: Record<string, unknown>): Array<Record<string, unknown>> {
  const parameters: Array<Record<string, unknown>> = [];
  if (operation.authorization === ProtocolAuthorization.Project) {
    parameters.push({
      name: ProtocolHeader.Version,
      in: "header",
      required: true,
      schema: { type: "integer", const: DomainProtocolVersion },
    });
  }
  if (operation.idempotency === ProtocolIdempotency.Keyed) {
    parameters.push({
      name: ProtocolHeader.IdempotencyKey,
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 256 },
      "x-opencanon-binding": operation.idempotencyKey,
    });
  }
  const rootProperties = objectPropertySchemas(requestSchema);
  const querySchema = rootProperties.query;
  if (!querySchema) return parameters;
  const required = new Set(stringArray(querySchema.required));
  for (const [name, schema] of Object.entries(objectPropertySchemas(querySchema)).sort(([left], [right]) => left.localeCompare(right))) {
    parameters.push({
      name,
      in: "query",
      required: required.has(name),
      schema,
      ...(supportsRepeatedValues(schema) ? { style: "form", explode: true } : {}),
    });
  }
  return parameters;
}

function openApiRequestBody(requestSchema: Record<string, unknown>): Record<string, unknown> | undefined {
  const bodySchema = objectPropertySchemas(requestSchema).body;
  if (!bodySchema) return undefined;
  return {
    required: stringArray(requestSchema.required).includes("body"),
    content: { "application/json": { schema: bodySchema } },
  };
}

function objectPropertySchemas(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return {};
  return schema.properties as Record<string, Record<string, unknown>>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function supportsRepeatedValues(schema: Record<string, unknown>): boolean {
  if (schema.type === "array") return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some((candidate) =>
    Boolean(candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).type === "array"));
}

function failureResponse(): Record<string, unknown> {
  return {
    description: "Structured OpenCanon failure.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/OpenCanonFailure" } } },
  };
}

function schemaWithComponents(
  schema: z.ZodType,
  prefix: string,
  components: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { unrepresentable: "any", reused: "ref" }) as Record<string, unknown>;
  const definitions = isRecord(generated.$defs) ? generated.$defs : {};
  const names = Object.fromEntries(
    Object.keys(definitions).map((name) => [name, `${prefix}_${safeComponentToken(name)}`]),
  );
  for (const [name, definition] of Object.entries(definitions)) {
    if (!isRecord(definition)) continue;
    components[names[name]!] = rewriteDefinitionReferences(definition, names);
  }
  const { $schema: _schema, $defs: _definitions, ...root } = generated;
  return rewriteDefinitionReferences(root, names);
}

function rewriteDefinitionReferences(value: Record<string, unknown>, names: Record<string, string>): Record<string, unknown> {
  return rewriteJsonValue(value, names) as Record<string, unknown>;
}

function rewriteJsonValue(value: unknown, names: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteJsonValue(item, names));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "$ref" && typeof item === "string" && item.startsWith("#/$defs/")) {
      const definitionName = decodeURIComponent(item.slice("#/$defs/".length));
      const componentName = names[definitionName];
      if (!componentName) throw new Error(`OpenAPI schema references an unknown local definition: ${definitionName}.`);
      return [key, `#/components/schemas/${componentName}`];
    }
    return [key, rewriteJsonValue(item, names)];
  }));
}

function operationComponentPrefix(operationId: string): string {
  return operationId.split(".").map(capitalizeComponentToken).join("");
}

function capitalizeComponentToken(value: string): string {
  const token = safeComponentToken(value);
  return `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`;
}

function safeComponentToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_]/g, "_");
  if (!token) throw new Error("OpenAPI component names require at least one alphanumeric character.");
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}
