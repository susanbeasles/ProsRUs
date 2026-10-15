import { z } from "zod";
const amount = z.number().finite().positive().max(1000000000);
const terms = z
  .array(
    z
      .string()
      .min(1)
      .max(100)
      .refine(
        (value) => value === value.trim() && !/[\r\n\x00-\x1f]/.test(value),
      ),
  )
  .max(20)
  .refine(
    (values) =>
      new Set(values.map((value) => value.toLowerCase())).size ===
      values.length,
  );
export const targetingProfileSchema = z
  .object({
    baseFloorUsd: amount,
    targetBaseLowUsd: amount,
    targetBaseHighUsd: amount,
    hourlyFloorUsd: amount,
    requireRemote: z.boolean(),
    require401kMatch: z.boolean(),
    requireZeroPremium: z.boolean(),
    requireAffordableCare: z.boolean(),
    technicalScopeTerms: terms,
    aiAlignmentTerms: terms,
    meetingLoadTerms: terms,
  })
  .strict()
  .refine(
    (profile) =>
      profile.baseFloorUsd <= profile.targetBaseLowUsd &&
      profile.targetBaseLowUsd <= profile.targetBaseHighUsd,
  );
export type TargetingProfile = z.infer<typeof targetingProfileSchema>;
export const discoveryWindowSchema = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(0).max(23),
  })
  .strict()
  .refine((window) => window.startHour <= window.endHour);
export type DiscoveryWindow = z.infer<typeof discoveryWindowSchema>;
