type PerfToggleEnv = {
  T3CODE_DESKTOP_PERF_RUN_TERMINAL?: string | undefined;
  CI?: string | undefined;
};

/**
 * Controls whether desktop perf automation should include terminal shortcuts.
 *
 * Defaults to "on" for local/dev runs, but "off" in CI unless explicitly enabled.
 * This keeps CI perf checks focused on renderer responsiveness while avoiding
 * flaky PTY-dependent interactions in ephemeral Linux runners.
 */
export function shouldRunTerminalPerfInteractions(env: PerfToggleEnv): boolean {
  const raw = env.T3CODE_DESKTOP_PERF_RUN_TERMINAL?.trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return env.CI !== "true";
}
