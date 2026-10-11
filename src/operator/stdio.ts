import type { Readable, Writable } from "node:stream";
import { once } from "node:events";
import {
  OPERATOR_LIMITS as L,
  createFrameReader,
  demandOperator as demand,
  utf8,
} from "./protocol";
/** One newline-terminated canonical frame at a time. Streams are caller-owned private local pipes. */
export function createPipeExchange(
  input: Readable,
  output: Writable,
  deadline: number,
) {
  let outstanding = false,
    stopped = false;
  const stop = () => {
    stopped = true;
    input.destroy(Error("operator-pipe-stopped"));
    output.destroy(Error("operator-pipe-stopped"));
  };
  // Own stream failures without printing payloads; awaited callbacks/close events still settle the I/O.
  input.on("error", () => {
    stopped = true;
  });
  output.on("error", () => {
    stopped = true;
  });
  async function exchange(text: string) {
    demand(
      !outstanding && !stopped && utf8(text) <= L.request,
      "operator-pipe-bound",
    );
    outstanding = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      demand(Date.now() < deadline, "operator-expired");
      const bytes = Buffer.from(text + "\n");
      // Await actual write callbacks, including backpressure; stop never means a submitted write was recalled.
      for (let offset = 0; offset < bytes.length; offset += L.fragment) {
        const part = bytes.subarray(offset, offset + L.fragment);
        timer = setTimeout(
          () => output.destroy(Error("operator-pipe-stalled")),
          Math.max(1, Math.min(L.stallMs, deadline - Date.now())),
        );
        await new Promise<void>((resolve, reject) => {
          const closed = () => reject(Error("operator-pipe-closed"));
          output.once("close", closed);
          output.write(part, (error) => {
            output.removeListener("close", closed);
            if (error) reject(error);
            else resolve();
          });
        });
        clearTimeout(timer);
        timer = undefined;
        demand(!stopped && Date.now() < deadline, "operator-expired");
      }
      const frame = createFrameReader({
        deadline,
        reserve: (n) =>
          demand(
            n + bytes.length + L.response <= L.aggregate,
            "operator-aggregate-bound",
          ),
      });
      while (true) {
        timer = setTimeout(
          () => input.destroy(Error("operator-pipe-stalled")),
          Math.max(1, Math.min(L.stallMs, deadline - Date.now())),
        );
        while (input.readableLength === 0) {
          demand(
            !input.readableEnded && !input.destroyed,
            "operator-missing-response",
          );
          await once(input, "readable");
        }
        demand(!stopped && Date.now() < deadline, "operator-expired");
        const chunk = Buffer.from(
          input.read(Math.min(input.readableLength, L.fragment)) as Uint8Array,
        );
        clearTimeout(timer);
        timer = undefined;
        demand(chunk.length <= L.fragment, "operator-fragment-bound");
        const newline = chunk.indexOf(10);
        if (newline < 0) {
          frame.push(chunk);
          continue;
        }
        demand(newline === chunk.length - 1, "operator-trailing-response");
        frame.push(chunk.subarray(0, newline));
        const result = frame.finish();
        demand(utf8(result) <= L.response, "operator-response-bound");
        return result;
      }
    } catch (error) {
      stopped = true;
      input.destroy();
      output.destroy();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      outstanding = false;
    }
  }
  return Object.freeze({ exchange, stop });
}
