import { z } from "zod";
export const profileFieldSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?:phone|education|[a-z][a-z0-9]*(?:_[a-z0-9]+)*_dates)$(?![\s\S])/);
const employmentCategorySchema = z
  .string()
  .min(7)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_dates$(?![\s\S])/);
export const employmentDateExtractorsSchema = z
  .array(
    z
      .object({
        employerLabel: z
          .string()
          .min(1)
          .max(200)
          .refine(
            (value) => value === value.trim() && !/[\r\n\x00-\x1f]/.test(value),
          ),
        category: employmentCategorySchema,
      })
      .strict(),
  )
  .max(16)
  .refine(
    (values) =>
      new Set(values.map((value) => value.employerLabel.toLowerCase())).size ===
        values.length &&
      new Set(values.map((value) => value.category)).size === values.length,
  );
export type EmploymentDateExtractor = z.infer<
  typeof employmentDateExtractorsSchema
>[number];
export const profileFactSchema = z
  .object({
    field: profileFieldSchema,
    value: z.string().max(20000),
    sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$(?![\s\S])/),
  })
  .strict();
export type ProfileFact = z.infer<typeof profileFactSchema>;
