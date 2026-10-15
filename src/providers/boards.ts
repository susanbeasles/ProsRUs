import { z } from "zod";
import { boundedJson, type Http } from "./http";
const companySchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export async function readBoard(
  provider: "greenhouse" | "lever",
  company: string,
  http: Http = fetch,
) {
  companySchema.parse(company);
  if (provider === "greenhouse") {
    const raw = z
      .object({
        jobs: z
          .array(
            z.object({
              id: z.number(),
              title: z.string(),
              absolute_url: z.url(),
              content: z.string().optional(),
              location: z.object({ name: z.string() }),
            }),
          )
          .max(5000),
      })
      .parse(
        await boundedJson(
          http,
          `https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`,
          {},
        ),
      );
    return raw.jobs
      .slice(0, 100)
      .map((x) => ({
        company,
        role: x.title,
        sourceUrl: x.absolute_url,
        description: (x.content ?? x.title)
          .replace(/<[^>]+>/g, " ")
          .slice(0, 20000),
        remote: /remote/i.test(x.location.name),
      }));
  }
  const raw = z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        hostedUrl: z.url(),
        descriptionPlain: z.string(),
        workplaceType: z.string().optional(),
      }),
    )
    .max(5000)
    .parse(
      await boundedJson(
        http,
        `https://api.lever.co/v0/postings/${company}?mode=json`,
        {},
      ),
    );
  return raw
    .slice(0, 100)
    .map((x) => ({
      company,
      role: x.text,
      sourceUrl: x.hostedUrl,
      description: x.descriptionPlain.slice(0, 20000),
      remote: x.workplaceType === "remote",
    }));
}
