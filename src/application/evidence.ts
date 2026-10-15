import {
  profileFactSchema,
  type EmploymentDateExtractor,
} from "../domain/profile-field";
import { z } from "zod";
import type { Store } from "../storage/store";
import { inspectText } from "../domain/rules";
import { extractProfileFacts, profileConflicts } from "../domain/profile";
export async function saveEvidence(
  input: {
    name: string;
    text: string;
    owner: string;
    actor: string;
    now: number;
  },
  dependencies: {
    store: Store;
    artifacts: R2Bucket;
    profileExtraction?: readonly EmploymentDateExtractor[];
  },
) {
  const { store, artifacts } = dependencies;
  const id = crypto.randomUUID();
  const key = `${input.owner}/sources/${id}.txt`;
  const flags = inspectText(input.text);
  const facts = extractProfileFacts(
    input.text,
    id,
    dependencies.profileExtraction,
  );
  await artifacts.put(key, input.text, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  const result = await store.add(
    "artifact",
    id,
    {
      id,
      name: input.name,
      key,
      flags,
      facts,
      status: flags.length ? "review_required" : "available",
      createdAt: input.now,
    },
    input.actor,
    input.now,
  );
  const all = (await store.list("artifact")).flatMap(
    (r) =>
      z.object({ facts: z.array(profileFactSchema).optional() }).parse(r.body)
        .facts ?? [],
  );
  for (const conflict of profileConflicts(all)) {
    const conflictId = `conflict-${conflict.field}`;
    const existing = await store.get("question", conflictId);
    const body = {
      type: "profile_conflict",
      ...conflict,
      status: "unresolved",
      nextAction: "Confirm the authoritative value before submission",
    };
    if (existing)
      await store.update(
        "question",
        conflictId,
        body,
        existing.revision,
        input.actor,
        input.now,
      );
    else await store.add("question", conflictId, body, input.actor, input.now);
  }
  return result;
}
