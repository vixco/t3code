type PerfToggleEnv = {
  T3CODE_DESKTOP_PERF_RUN_TERMINAL?: string | undefined;
  CI?: string | undefined;
};

export function shouldRunTerminalPerfInteractions(env: PerfToggleEnv): boolean {
  const raw = env.T3CODE_DESKTOP_PERF_RUN_TERMINAL?.trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return env.CI !== "true";
}
