import { Schema, State } from "@livestore/livestore";

export const shadowMirrorStatus = State.SQLite.clientDocument({
  name: "shadowMirrorStatus",
  schema: Schema.Struct({
    seq: Schema.Number,
    eventType: Schema.String,
    entityId: Schema.String,
    payloadJson: Schema.String,
    createdAt: Schema.String,
  }),
  default: {
    value: {
      seq: 0,
      eventType: "",
      entityId: "",
      payloadJson: "{}",
      createdAt: new Date(0).toISOString(),
    },
  },
});

export const liveStoreShadowEvents = {
  stateEventMirrored: shadowMirrorStatus.set,
} as const;
