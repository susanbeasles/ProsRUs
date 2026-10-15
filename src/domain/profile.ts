import { z } from "zod";
import {
  employmentDateExtractorsSchema,
  profileFactSchema,
  type EmploymentDateExtractor,
  type ProfileFact,
} from "./profile-field";
export type { ProfileFact } from "./profile-field";
function exactEmployer(line: string, employer: string) {
  const text = line.toLowerCase(),
    label = employer.toLowerCase();
  let offset = text.indexOf(label);
  while (offset !== -1) {
    const before = text[offset - 1],
      after = text[offset + label.length];
    if (
      (!before || !/[A-Za-z0-9_]/.test(before)) &&
      (!after || !/[A-Za-z0-9_]/.test(after))
    )
      return true;
    offset = text.indexOf(label, offset + 1);
  }
  return false;
}
export function extractProfileFacts(
  text: string,
  sourceId: string,
  suppliedExtractors: readonly EmploymentDateExtractor[] = [],
): ProfileFact[] {
  const extractors = employmentDateExtractorsSchema.parse(suppliedExtractors);
  const facts: ProfileFact[] = [];
  for (const match of text.matchAll(
    /(?:\+1[ .-]?)?\(?\b(\d{3})\)?[ .-](\d{3})[ .-](\d{4})\b/g,
  ))
    facts.push({
      field: "phone",
      value: `${match[1]}${match[2]}${match[3]}`,
      sourceId,
    });
  for (const line of text.split(/\r?\n/)) {
    for (const extractor of extractors)
      if (
        exactEmployer(line, extractor.employerLabel) &&
        /\b(?:19|20)\d{2}\b/.test(line)
      )
        facts.push({
          field: extractor.category,
          value: line.trim().toLowerCase().replace(/\s+/g, " "),
          sourceId,
        });
    if (
      /education\s*:|\b(?:bachelor|associate|master|coursework|university|college)\b/i.test(
        line,
      )
    )
      facts.push({
        field: "education",
        value: line.trim().toLowerCase().replace(/\s+/g, " "),
        sourceId,
      });
  }
  return facts;
}
export function profileConflicts(facts: readonly ProfileFact[]) {
  const validated = z.array(profileFactSchema).max(16384).parse(facts);
  const categories = [...new Set(validated.map((fact) => fact.field))];
  const fields = [
    "phone",
    ...categories
      .filter((field) => field !== "phone" && field !== "education")
      .sort(),
    "education",
  ];
  return fields.flatMap((field) => {
    const values = validated.filter((fact) => fact.field === field);
    return new Set(values.map((fact) => fact.value)).size > 1
      ? [{ field, values }]
      : [];
  });
}
