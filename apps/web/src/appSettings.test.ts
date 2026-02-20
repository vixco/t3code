import { afterEach, describe, expect, it, vi } from "vitest";

const LOCAL_APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:local:v1";
const LEGACY_APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

type StorageMap = Map<string, string>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

async function flushMicrotasks(times = 3): Promise<void> {
  if (times <= 0) return;
  await Promise.resolve();
  await flushMicrotasks(times - 1);
}

function installWindowMock(initialStorage?: StorageMap): StorageMap {
  const storage = initialStorage ?? new Map<string, string>();

  const localStorageMock = {
    length: 0,
    clear: () => {
      storage.clear();
      localStorageMock.length = 0;
    },
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    removeItem: (key: string) => {
      storage.delete(key);
      localStorageMock.length = storage.size;
    },
    setItem: (key: string, value: string) => {
      storage.set(key, value);
      localStorageMock.length = storage.size;
    },
  };

  localStorageMock.length = storage.size;

  const windowMock = {
    localStorage: localStorageMock as Storage,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });

  return storage;
}

describe("appSettings", () => {
  afterEach(() => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("returns a stable snapshot reference when settings have not changed", async () => {
    installWindowMock();
    const module = await import("./appSettings");

    const first = module.getAppSettingsSnapshot();
    const second = module.getAppSettingsSnapshot();

    expect(second).toBe(first);
  });

  it("returns a new snapshot reference when local settings change", async () => {
    const storage = installWindowMock();
    const module = await import("./appSettings");

    const first = module.getAppSettingsSnapshot();
    storage.set(LOCAL_APP_SETTINGS_STORAGE_KEY, JSON.stringify({ confirmThreadDelete: false }));
    const second = module.getAppSettingsSnapshot();

    expect(second).not.toBe(first);
    expect(second.confirmThreadDelete).toBe(false);
  });

  it("prevents hydration from overwriting optimistic backend writes", async () => {
    installWindowMock();
    const getDeferred = createDeferred<{ codexBinaryPath: string; codexHomePath: string }>();
    const updateDeferred = createDeferred<{ codexBinaryPath: string; codexHomePath: string }>();
    const get = vi.fn(() => getDeferred.promise);
    const update = vi.fn(() => updateDeferred.promise);
    window.nativeApi = {
      appSettings: {
        get,
        update,
      },
    } as unknown as NonNullable<Window["nativeApi"]>;

    const module = await import("./appSettings");
    const hydration = module.ensureAppSettingsHydrated();
    module.updateAppSettings({ codexBinaryPath: "/opt/codex/new" });

    getDeferred.resolve({ codexBinaryPath: "/opt/codex/stale", codexHomePath: "" });
    await hydration;

    expect(module.getAppSettingsSnapshot().codexBinaryPath).toBe("/opt/codex/new");
    expect(update).toHaveBeenCalledTimes(1);

    updateDeferred.resolve({ codexBinaryPath: "/opt/codex/new", codexHomePath: "" });
    await flushMicrotasks();
    expect(module.getAppSettingsSnapshot().codexBinaryPath).toBe("/opt/codex/new");
  });

  it("prevents hydration from overwriting optimistic local writes", async () => {
    const storage = installWindowMock(
      new Map([
        [
          LEGACY_APP_SETTINGS_STORAGE_KEY,
          JSON.stringify({
            confirmThreadDelete: true,
          }),
        ],
      ]),
    );
    const getDeferred = createDeferred<{ codexBinaryPath: string; codexHomePath: string }>();
    const get = vi.fn(() => getDeferred.promise);
    window.nativeApi = {
      appSettings: {
        get,
        update: vi.fn(async () => ({ codexBinaryPath: "", codexHomePath: "" })),
      },
    } as unknown as NonNullable<Window["nativeApi"]>;

    const module = await import("./appSettings");
    const hydration = module.ensureAppSettingsHydrated();
    module.updateAppSettings({ confirmThreadDelete: false });

    getDeferred.resolve({ codexBinaryPath: "", codexHomePath: "" });
    await hydration;

    expect(module.getAppSettingsSnapshot().confirmThreadDelete).toBe(false);
    expect(storage.get(LOCAL_APP_SETTINGS_STORAGE_KEY)).toBe(
      JSON.stringify({ confirmThreadDelete: false }),
    );
  });
});
