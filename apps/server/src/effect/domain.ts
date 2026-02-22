import * as Schema from "effect/Schema";

export const aggregateTypeSchema = Schema.Literal("project", "thread", "git");
export type AggregateType = typeof aggregateTypeSchema.Type;

export class DomainEventEnvelope extends Schema.Class<DomainEventEnvelope>("DomainEventEnvelope")({
  eventId: Schema.String,
  streamId: Schema.String,
  aggregateType: aggregateTypeSchema,
  version: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  occurredAt: Schema.String,
  causationId: Schema.String,
  correlationId: Schema.String,
  actor: Schema.String,
  eventType: Schema.String,
  payloadJson: Schema.String,
}) {}

export const domainEventPayloadSchema = Schema.Struct({
  kind: Schema.String,
  payload: Schema.Unknown,
});
export type DomainEventPayload = typeof domainEventPayloadSchema.Type;
