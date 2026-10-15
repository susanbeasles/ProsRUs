import { z } from "zod";
import type { Google } from "../providers/google";
import { ProviderFailure } from "../providers/http";
import type { Store } from "../storage/store";
import { inspectText } from "../domain/rules";
import { threadSchema } from "../application/contracts";
const partSchema = z.object({
  mimeType: z.string().optional(),
  body: z.object({ data: z.string().optional() }).optional(),
  parts: z.array(z.unknown()).optional(),
});
export function messageText(payload: unknown) {
  const pending = [payload];
  const text: string[] = [];
  let count = 0;
  while (pending.length && count++ < 50) {
    const part = partSchema.parse(pending.pop());
    if (part.mimeType === "text/plain" && part.body?.data) {
      const raw = part.body.data.replaceAll("-", "+").replaceAll("_", "/");
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)),
      );
      text.push(decoded.slice(0, 20000));
    }
    pending.push(...(part.parts ?? []));
  }
  return text.join("\n").slice(0, 20000);
}
const mailSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string().default(""),
  internalDate: z.string(),
  payload: z
    .object({
      headers: z.array(z.object({ name: z.string(), value: z.string() })),
    })
    .passthrough(),
});
const syncSchema = z.object({
  pageToken: z.string().optional(),
  historyId: z.string().optional(),
  watchExpiration: z.number().optional(),
});
export async function syncMail(
  google: Google,
  store: Store,
  owner: string,
  now: number,
) {
  const record = await store.get("connection", "gmail-sync");
  const state = record ? syncSchema.parse(record.body) : {};
  let page = state.pageToken;
  let count = 0;
  let historyExpired = false;
  if (state.historyId) {
    try {
      await google.history(state.historyId);
    } catch (error) {
      if (error instanceof ProviderFailure && error.code === "PROVIDER_404")
        historyExpired = true;
      else throw error;
    }
  }
  for (let batch = 0; batch < 2; batch++) {
    const result = await google.recruitingMessages(page);
    for (const message of result.messages ?? []) {
      const raw = mailSchema.parse(await google.message(message.id));
      const content =
        messageText(raw.payload) || raw.snippet || "(No readable text)";
      const header = (name: string) =>
        raw.payload.headers.find(
          (x) => x.name.toLowerCase() === name.toLowerCase(),
        )?.value ?? "";
      const address = header("from").match(/<([^>]+)>/)?.[1] ?? header("from");
      const recipient = z.email().safeParse(address);
      if (!recipient.success) continue;
      const existing = (await store.list("thread")).find(
        (r) => threadSchema.parse(r.body).providerThreadId === raw.threadId,
      );
      if (existing) {
        const thread = threadSchema.parse(existing.body);
        if (
          !thread.messages.some(
            (m) => m.at === Number(raw.internalDate) && m.text === content,
          )
        )
          await store.update(
            "thread",
            existing.id,
            {
              ...thread,
              messages: [
                ...thread.messages.slice(-49),
                { text: content, at: Number(raw.internalDate) },
              ],
              status: "needs_reply",
              flags: [...new Set([...thread.flags, ...inspectText(content)])],
              nextAction: "Review new recruiter reply",
              replyMessageId: header("message-id") || undefined,
            },
            existing.revision,
            owner,
            now,
          );
      } else {
        const id = `mail-${raw.threadId}`;
        const existingQuestion = await store.get("question", id);
        const body = {
          providerThreadId: raw.threadId,
          recipient: recipient.data,
          subject: header("subject"),
          preview: content,
          replyMessageId: header("message-id") || undefined,
          flags: inspectText(content),
          nextAction: "Associate with an opportunity before replying",
          messageId: raw.id,
          status: "unassociated",
        };
        if (!existingQuestion)
          await store.add("question", id, body, owner, now);
        else if (existingQuestion.updatedAt < Number(raw.internalDate))
          await store.update(
            "question",
            id,
            body,
            existingQuestion.revision,
            owner,
            now,
          );
      }
      count++;
    }
    page = result.nextPageToken;
    if (!page) break;
  }
  const profile = await google.profile();
  const updated = {
    ...state,
    pageToken: page,
    historyId: page ? state.historyId : profile.historyId,
    historyExpired,
    lastSyncAt: now,
    status: page ? "reconciling" : "connected",
  };
  if (record)
    await store.update(
      "connection",
      "gmail-sync",
      updated,
      record.revision,
      owner,
      now,
    );
  else await store.add("connection", "gmail-sync", updated, owner, now);
  return { messagesReviewed: count, moreAvailable: !!page, historyExpired };
}
export async function renewWatch(
  google: Google,
  store: Store,
  owner: string,
  topic: string,
  now: number,
) {
  if (!topic) return;
  const r = await store.get("connection", "gmail-watch");
  const expiration = r
    ? z.object({ expiration: z.number() }).parse(r.body).expiration
    : 0;
  if (expiration > now + 86400000) return;
  const watch = await google.watch(topic);
  const body = {
    expiration: Number(watch.expiration),
    historyId: watch.historyId,
    status: "watching",
  };
  if (r)
    await store.update(
      "connection",
      "gmail-watch",
      body,
      r.revision,
      owner,
      now,
    );
  else await store.add("connection", "gmail-watch", body, owner, now);
}
