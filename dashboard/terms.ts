import type { Field } from "./Form";
export const termFields: Field[] = [
  {
    name: "employment",
    label: "Employment",
    kind: "select",
    options: ["full_time", "contract"],
  },
  {
    name: "baseUsd",
    label: "Base salary (USD, blank if unknown)",
    kind: "number",
    required: false,
  },
  {
    name: "hourlyUsd",
    label: "Hourly rate (USD, blank if unknown)",
    kind: "number",
    required: false,
  },
  ...["remote", "match401k", "zeroPremium", "affordableCare"].map((name) => ({
    name,
    label:
      {
        remote: "Remote eligibility",
        match401k: "Employer 401(k) match",
        zeroPremium: "Zero employee health premium",
        affordableCare: "Affordable visits and prescriptions",
      }[name] ?? name,
    kind: "select" as const,
    options: ["unknown", "yes", "no"],
  })),
];
export function terms(v: Record<string, string>) {
  return {
    employment: v.employment,
    baseUsd: v.baseUsd ? Number(v.baseUsd) : null,
    hourlyUsd: v.hourlyUsd ? Number(v.hourlyUsd) : null,
    ...Object.fromEntries(
      ["remote", "match401k", "zeroPremium", "affordableCare"].map((k) => [
        k,
        v[k] === "unknown" ? null : v[k] === "yes",
      ]),
    ),
  };
}
