import type { AppViewState } from "./models";

export type DomainQuery = { readonly type: "app.getState" };

export interface QueryResultMap {
  "app.getState": AppViewState;
}
