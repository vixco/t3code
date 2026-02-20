import { makeSchema, State } from "@livestore/livestore";
import { liveStoreShadowEvents, shadowMirrorStatus } from "./schema";

export const liveStoreShadowMaterializers = {};

export const liveStoreShadowState = State.SQLite.makeState({
  tables: {
    shadowMirrorStatus,
  },
  materializers: liveStoreShadowMaterializers,
});

export const liveStoreShadowSchema = makeSchema({
  events: liveStoreShadowEvents,
  state: liveStoreShadowState,
});
