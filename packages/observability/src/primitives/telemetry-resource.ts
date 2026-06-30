import { Err, Ok, type Result } from './result.ts';

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Record<string, TelemetryAttributeValue>;

export type TelemetryResource = {
  attributes: TelemetryAttributes;
  schemaUrl?: string | undefined;
};

export const TelemetryResourceErrorKind = Object.freeze({
  InvalidAttributeKey: 'invalid_attribute_key',
  InvalidAttributeValue: 'invalid_attribute_value',
  SchemaUrlConflict: 'schema_url_conflict',
} as const);

export type TelemetryResourceErrorKind =
  (typeof TelemetryResourceErrorKind)[keyof typeof TelemetryResourceErrorKind];

export class TelemetryResourceError extends Error {
  override readonly name = 'TelemetryResourceError';
  readonly kind: TelemetryResourceErrorKind;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    kind: TelemetryResourceErrorKind,
    message: string,
    details?: Record<string, unknown> | undefined
  ) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

export function telemetryResource(input: {
  attributes?: TelemetryAttributes | undefined;
  schemaUrl?: string | undefined;
}): TelemetryResource {
  return {
    attributes: validateTelemetryAttributes(input.attributes ?? {}),
    ...(input.schemaUrl != null ? { schemaUrl: input.schemaUrl } : {}),
  };
}

export function emptyTelemetryResource(): TelemetryResource {
  return telemetryResource({});
}

export function serviceTelemetryResource(input: {
  serviceName: string;
  serviceVersion?: string | undefined;
  serviceInstanceId?: string | undefined;
  deploymentEnvironment?: string | undefined;
  attributes?: TelemetryAttributes | undefined;
  schemaUrl?: string | undefined;
}): TelemetryResource {
  return telemetryResource({
    schemaUrl: input.schemaUrl,
    attributes: {
      ...(input.attributes ?? {}),
      'service.name': input.serviceName,
      ...(input.serviceVersion != null ? { 'service.version': input.serviceVersion } : {}),
      ...(input.serviceInstanceId != null
        ? { 'service.instance.id': input.serviceInstanceId }
        : {}),
      ...(input.deploymentEnvironment != null
        ? { 'deployment.environment.name': input.deploymentEnvironment }
        : {}),
    },
  });
}

export function mergeTelemetryResources(
  base: TelemetryResource,
  updating: TelemetryResource
): Result<TelemetryResource, TelemetryResourceError> {
  const schemaUrl = mergeSchemaUrls(base.schemaUrl, updating.schemaUrl);
  if (!schemaUrl.ok) return schemaUrl.asErr<TelemetryResource>();

  return Ok(
    telemetryResource({
      ...(schemaUrl.value != null ? { schemaUrl: schemaUrl.value } : {}),
      attributes: {
        ...base.attributes,
        ...updating.attributes,
      },
    })
  );
}

export function telemetryResourceToAttributes(resource: TelemetryResource): TelemetryAttributes {
  return { ...resource.attributes };
}

function mergeSchemaUrls(
  base: string | undefined,
  updating: string | undefined
): Result<string | undefined, TelemetryResourceError> {
  if (base == null || base.length === 0) return Ok(updating);
  if (updating == null || updating.length === 0) return Ok(base);
  if (base === updating) return Ok(base);

  return Err(
    new TelemetryResourceError(
      TelemetryResourceErrorKind.SchemaUrlConflict,
      'Telemetry resources with different schema URLs cannot be merged',
      { base, updating }
    )
  );
}

function validateTelemetryAttributes(attributes: TelemetryAttributes): TelemetryAttributes {
  const output: TelemetryAttributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (key.trim().length === 0) {
      throw new TelemetryResourceError(
        TelemetryResourceErrorKind.InvalidAttributeKey,
        'Telemetry resource attribute key must not be empty'
      );
    }

    if (!isTelemetryAttributeValue(value)) {
      throw new TelemetryResourceError(
        TelemetryResourceErrorKind.InvalidAttributeValue,
        'Telemetry resource attribute value must be a finite scalar',
        { key }
      );
    }

    output[key] = value;
  }

  return output;
}

export function isTelemetryAttributeValue(value: unknown): value is TelemetryAttributeValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value);
}
