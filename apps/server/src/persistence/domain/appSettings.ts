import {
  type AppSettings,
  type AppSettingsUpdateInput,
  appSettingsSchema,
  appSettingsUpdateInputSchema,
} from "@t3tools/contracts";

export function resolveAppSettings(metadataValue: unknown): AppSettings {
  const parsed = appSettingsSchema.safeParse(metadataValue);
  if (parsed.success) {
    return parsed.data;
  }
  return appSettingsSchema.parse({});
}

export function buildUpdatedAppSettings(
  current: AppSettings,
  rawPatch: AppSettingsUpdateInput,
): AppSettings {
  const patch = appSettingsUpdateInputSchema.parse(rawPatch);
  return appSettingsSchema.parse({
    ...current,
    ...patch,
  });
}
