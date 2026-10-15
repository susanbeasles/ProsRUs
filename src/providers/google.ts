import { z } from "zod";
import { demand, type Window } from "../domain/model";
import { boundedJson, type Http } from "./http";
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export function mailMessage(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
}) {
  z.email().parse(input.from);
  z.email().parse(input.to);
  demand(
    !/[\r\n]/.test(input.subject + input.messageId + (input.inReplyTo ?? "")),
    "INVALID_MAIL_HEADER",
  );
  const subject = btoa(
    String.fromCharCode(...new TextEncoder().encode(input.subject)),
  );
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    `Message-ID: <${input.messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
  ];
  if (input.inReplyTo)
    headers.push(
      `In-Reply-To: ${input.inReplyTo}`,
      `References: ${input.inReplyTo}`,
    );
  return btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(
        headers.join("\r\n") + "\r\n\r\n" + input.body,
      ),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
const messagesSchema = z.object({
  messages: z
    .array(z.object({ id: providerId, threadId: providerId }))
    .optional(),
  nextPageToken: z.string().optional(),
});
export function createGoogle(accessToken: string, http: Http = fetch) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const get = (url: string) => boundedJson(http, url, { headers });
  const post = (url: string, body: unknown) =>
    boundedJson(http, url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const gmail = "https://gmail.googleapis.com/gmail/v1/users/me";
  const calendar = "https://www.googleapis.com/calendar/v3";
  return {
    async profile() {
      return z
        .object({ emailAddress: z.email(), historyId: z.string() })
        .parse(await get(`${gmail}/profile`));
    },
    async recruitingMessages(pageToken?: string) {
      const query = new URLSearchParams({
        q: '-in:sent newer_than:90d {subject:interview subject:recruiter subject:recruiting subject:application subject:opportunity subject:"job alert"}',
        maxResults: "50",
      });
      if (pageToken) query.set("pageToken", pageToken);
      return messagesSchema.parse(await get(`${gmail}/messages?${query}`));
    },
    async message(id: string) {
      providerId.parse(id);
      return get(`${gmail}/messages/${id}?format=full`);
    },
    async history(cursor: string) {
      demand(/^\d+$/.test(cursor), "INVALID_CURSOR");
      return get(
        `${gmail}/history?startHistoryId=${cursor}&historyTypes=messageAdded&maxResults=100`,
      );
    },
    async watch(topicName: string) {
      demand(
        /^projects\/[a-z0-9-]+\/topics\/[a-zA-Z0-9_-]+$/.test(topicName),
        "INVALID_TOPIC",
      );
      return z
        .object({ historyId: z.string(), expiration: z.string() })
        .parse(
          await post(`${gmail}/watch`, {
            topicName,
            labelIds: ["INBOX"],
            labelFilterBehavior: "include",
          }),
        );
    },
    async send(
      input: Parameters<typeof mailMessage>[0] & { threadId?: string },
    ) {
      return z
        .object({ id: providerId, threadId: providerId })
        .parse(
          await post(`${gmail}/messages/send`, {
            raw: mailMessage(input),
            ...(input.threadId
              ? { threadId: providerId.parse(input.threadId) }
              : {}),
          }),
        );
    },
    async findSent(messageId: string) {
      demand(/^[a-zA-Z0-9@._-]+$/.test(messageId), "INVALID_MESSAGE_ID");
      return messagesSchema.parse(
        await get(
          `${gmail}/messages?${new URLSearchParams({ q: `in:sent rfc822msgid:${messageId}`, maxResults: "10" })}`,
        ),
      );
    },
    async freeBusy(
      calendarId: string,
      start: number,
      end: number,
    ): Promise<Window[]> {
      const raw = z
        .object({
          calendars: z.record(
            z.string(),
            z.object({
              busy: z.array(
                z.object({
                  start: z.iso.datetime({ offset: true }),
                  end: z.iso.datetime({ offset: true }),
                }),
              ),
              errors: z.array(z.unknown()).optional(),
            }),
          ),
        })
        .parse(
          await post(`${calendar}/freeBusy`, {
            timeMin: new Date(start).toISOString(),
            timeMax: new Date(end).toISOString(),
            items: [{ id: calendarId }],
          }),
        );
      const result = raw.calendars[calendarId];
      demand(result && !result.errors?.length, "CALENDAR_UNAVAILABLE", 503);
      return result.busy.map((x) => ({
        start: Date.parse(x.start),
        end: Date.parse(x.end),
      }));
    },
    async createInterview(input: {
      calendarId: string;
      eventId: string;
      title: string;
      start: number;
      end: number;
      attendee: string;
      owner: string;
      remindersEnabled: boolean;
    }) {
      return z.object({ id: z.string(), htmlLink: z.url().optional() }).parse(
        await post(
          `${calendar}/calendars/${encodeURIComponent(input.calendarId)}/events?sendUpdates=all`,
          {
            id: input.eventId,
            summary: input.title,
            start: { dateTime: new Date(input.start).toISOString() },
            end: { dateTime: new Date(input.end).toISOString() },
            attendees: [{ email: z.email().parse(input.attendee) }],
            extendedProperties: { private: { jobStackOwner: input.owner } },
            reminders: {
              useDefault: false,
              overrides: input.remindersEnabled
                ? [
                    { method: "popup", minutes: 60 },
                    { method: "popup", minutes: 10 },
                  ]
                : [],
            },
          },
        ),
      );
    },
    async event(calendarId: string, eventId: string) {
      providerId.parse(eventId);
      return get(
        `${calendar}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      );
    },
    async changeInterview(input: {
      calendarId: string;
      eventId: string;
      etag: string;
      body: unknown;
    }) {
      providerId.parse(input.eventId);
      return boundedJson(
        http,
        `${calendar}/calendars/${encodeURIComponent(input.calendarId)}/events/${input.eventId}?sendUpdates=all`,
        {
          method: "PATCH",
          headers: { ...headers, "If-Match": input.etag },
          body: JSON.stringify(input.body),
        },
      );
    },
    async selectedDriveFile(fileId: string) {
      providerId.parse(fileId);
      return get(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,modifiedTime`,
      );
    },
    async exportDocument(fileId: string) {
      providerId.parse(fileId);
      const response = await http(
        `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fplain`,
        { headers, redirect: "error", signal: AbortSignal.timeout(15000) },
      );
      demand(response.ok, "DRIVE_EXPORT_FAILED", 502);
      return response;
    },
  };
}
export type Google = ReturnType<typeof createGoogle>;
