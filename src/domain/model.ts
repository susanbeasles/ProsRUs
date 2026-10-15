import {
  targetingProfileSchema,
  discoveryWindowSchema,
} from "./targeting-profile";
import { employmentDateExtractorsSchema } from "./profile-field";
import { z } from "zod";
export const text = z.string().trim().min(1).max(20000);
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const claimSchema = z
  .object({
    id,
    field: text.max(80),
    text,
    status: z.enum([
      "user_confirmed",
      "source_supported",
      "disputed",
      "unverified",
    ]),
    permitted: z.boolean(),
    sourceIds: z.array(id).max(30),
    flags: z.array(z.string()).optional(),
  })
  .strict();
export type Claim = Readonly<
  Omit<z.infer<typeof claimSchema>, "sourceIds"> & {
    sourceIds: readonly string[];
  }
>;
export const termsSchema = z
  .object({
    employment: z.enum(["full_time", "contract"]),
    baseUsd: z.number().nonnegative().nullable(),
    hourlyUsd: z.number().nonnegative().nullable(),
    remote: z.boolean().nullable(),
    match401k: z.boolean().nullable(),
    zeroPremium: z.boolean().nullable(),
    affordableCare: z.boolean().nullable(),
  })
  .strict();
export type Terms = Readonly<z.infer<typeof termsSchema>>;
export const states = [
  "discovered",
  "researching",
  "qualified",
  "packet_ready",
  "submitted",
  "recruiter_screen",
  "interviewing",
  "offer",
  "declined",
  "rejected",
  "withdrawn",
  "blocked",
] as const;
export type OpportunityState = (typeof states)[number];
export type Scope = "read" | "write" | "send" | "schedule";
export type Principal = Readonly<{
  id: string;
  kind: "user" | "service";
  scopes: readonly string[];
  expiresAt: number;
}>;
export type Window = Readonly<{ start: number; end: number }>;
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
  }
}
export function demand(
  condition: unknown,
  code: string,
  status = 400,
): asserts condition {
  if (!condition) throw new DomainError(code, status);
}
export const opportunitySchema = z.object({
  id,
  company: text.max(200),
  role: text.max(200),
  sourceUrl: z.url().max(2000),
  description: text,
  terms: termsSchema,
  state: z.enum(states),
  flags: z.array(z.string()),
  fit: z.object({
    status: z.enum(["qualified", "researching", "ineligible"]),
    rationale: z.array(z.string()),
  }),
  nextAction: text.max(500),
  dueAt: z.number().nullable(),
  createdAt: z.number(),
  lastSeenAt: z.number().optional(),
  ranking: z.record(z.string(), z.string()).optional(),
});
export type Opportunity = z.infer<typeof opportunitySchema>;
export const settingsSchema = z
  .object({
    targetingProfile: targetingProfileSchema.optional(),
    discoveryWindow: discoveryWindowSchema.optional(),
    profileExtraction: employmentDateExtractorsSchema.optional(),
    discoveryEnabled: z.boolean(),
    correspondenceEnabled: z.boolean(),
    remindersEnabled: z.boolean(),
    sendingEnabled: z.boolean(),
    profileResolved: z.boolean(),
    integrationVerified: z.boolean(),
    sender: z.email().nullable(),
    notificationEmail: z.email().nullable(),
    calendarId: z.string().max(200).nullable(),
    interviewWindows: z
      .array(
        z
          .object({ start: z.number(), end: z.number() })
          .refine((x) => x.end > x.start),
      )
      .max(100),
    approvedRecipients: z.array(z.email()).max(200),
    boards: z
      .array(
        z.object({
          provider: z.enum(["greenhouse", "lever"]),
          company: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
        }),
      )
      .max(20),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const initialSettings: Settings = {
  discoveryEnabled: false,
  correspondenceEnabled: false,
  remindersEnabled: true,
  sendingEnabled: false,
  profileResolved: false,
  integrationVerified: false,
  sender: null,
  notificationEmail: null,
  calendarId: null,
  interviewWindows: [],
  approvedRecipients: [],
  boards: [],
};
