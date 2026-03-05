import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import http from "node:http";

import { ServerConfig } from "./config";
import { Open, OpenLive } from "./open";
import * as SqlitePersistence from "./persistence/Layers/Sqlite";
import { ProviderHealthLive } from "./provider/Layers/ProviderHealth";
import { ServerRuntimeStateLive } from "./serverRuntime";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { makeRoutesLayer } from "./wsServer";

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const logServerReady = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const open = yield* Open;
  const server = yield* HttpServer.HttpServer;

  if (server.address._tag !== "TcpAddress") {
    return;
  }

  const { port } = server.address;
  const localUrl = `http://localhost:${port}`;
  const bindUrl =
    config.host && !isWildcardHost(config.host)
      ? `http://${formatHostForUrl(config.host)}:${port}`
      : localUrl;

  yield* Effect.logInfo("T3 Code running", {
    url: bindUrl,
    localUrl,
    bindHost: config.host ?? "default",
    cwd: config.cwd,
    mode: config.mode,
    stateDir: config.stateDir,
    authEnabled: Boolean(config.authToken),
    websocketUrl: `${bindUrl}/ws`,
  });

  if (config.noBrowser) {
    return;
  }

  const target = config.devUrl?.toString() ?? bindUrl;
  yield* open.openBrowser(target).pipe(
    Effect.catch(() =>
      Effect.logInfo("browser auto-open unavailable", {
        hint: `Open ${target} in your browser.`,
      }),
    ),
  );
});

const startupLayer = Layer.effectDiscard(logServerReady);

export const makeNodeHttpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* ServerConfig;
    return NodeHttpServer.layer(http.createServer, host ? { host, port } : { port });
  }),
);

const routesLayer = HttpRouter.serve(makeRoutesLayer, {
  disableLogger: true,
  disableListenLog: true,
});

export const makeServerServicesLayer = () => {
  const nodeServicesLayer = NodeServices.layer;
  const sqliteLayer = SqlitePersistence.layerConfig.pipe(Layer.provideMerge(nodeServicesLayer));
  const providerLayer = makeServerProviderLayer().pipe(
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(nodeServicesLayer),
  );
  const runtimeLayer = makeServerRuntimeServicesLayer().pipe(
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(sqliteLayer),
    Layer.provideMerge(nodeServicesLayer),
  );
  const providerHealthLayer = ProviderHealthLive.pipe(Layer.provideMerge(nodeServicesLayer));
  const openLayer = OpenLive.pipe(Layer.provideMerge(nodeServicesLayer));
  const baseServicesLayer = Layer.mergeAll(
    nodeServicesLayer,
    runtimeLayer,
    providerLayer,
    providerHealthLayer,
    openLayer,
    sqliteLayer,
  );

  return Layer.mergeAll(
    baseServicesLayer,
    ServerRuntimeStateLive.pipe(Layer.provide(baseServicesLayer)),
  );
};

export const makeServerAppLayer = <ServicesSuccess, ServicesError, ServicesRequirements>(
  servicesLayer: Layer.Layer<ServicesSuccess, ServicesError, ServicesRequirements>,
) =>
  routesLayer.pipe(Layer.provideMerge(startupLayer)).pipe(Layer.provide(servicesLayer));

export const makeServerLayer = makeServerAppLayer(makeServerServicesLayer()).pipe(
  Layer.provide(makeNodeHttpServerLayer),
);

export const runServer = Layer.launch(makeServerLayer);
