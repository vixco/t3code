import * as Schema from "effect/Schema";

export const DocumentRowSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  project_id: Schema.NullOr(Schema.String),
  thread_id: Schema.NullOr(Schema.String),
  sort_key: Schema.NullOr(Schema.Number),
  created_at: Schema.String,
  updated_at: Schema.String,
  data_json: Schema.String,
});

export const DataJsonRowSchema = Schema.Struct({
  data_json: Schema.String,
});

const NumberOrBigIntSchema = Schema.Union([Schema.Number, Schema.BigInt]);

export const ProviderEventInsertStatsSchema = Schema.Struct({
  changes: Schema.optional(Schema.NullOr(NumberOrBigIntSchema)),
});

export const CompletedProviderItemRowSchema = Schema.Struct({
  item_id: Schema.NullOr(Schema.String),
  payload_json: Schema.NullOr(Schema.String),
});

export const StateEventInsertStatsSchema = Schema.Struct({
  changes: Schema.optional(Schema.NullOr(NumberOrBigIntSchema)),
  lastInsertRowid: Schema.optional(Schema.NullOr(NumberOrBigIntSchema)),
});

export const StateEventRowSchema = Schema.Struct({
  seq: Schema.Number,
  event_type: Schema.String,
  entity_id: Schema.String,
  payload_json: Schema.String,
  created_at: Schema.String,
});

export const StateSeqRowSchema = Schema.Struct({
  seq: Schema.optional(Schema.NullOr(NumberOrBigIntSchema)),
});

export const TotalCountRowSchema = Schema.Struct({
  total: Schema.optional(Schema.NullOr(NumberOrBigIntSchema)),
});

export const MetadataRowSchema = Schema.Struct({
  value_json: Schema.String,
});
