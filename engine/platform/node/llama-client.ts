import { z } from "zod";
import type { ModelClient } from "../../prep/model.ts";

const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .min(1),
  usage: z.object({ completion_tokens: z.number() }),
});

// Prompts carry book text, so a typo or a leftover LLAMA_URL mustn't send them off the machine.
export function isLoopbackUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { hostname } = new URL(url);
  return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
}

// Generating over a book page on a laptop can take minutes, so only a server that has stopped answering hits this.
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export function createLlamaClient(
  baseUrl: string,
  { allowRemote = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
): ModelClient {
  if (!allowRemote && !isLoopbackUrl(baseUrl)) {
    throw new Error(
      `${baseUrl} isn't on this machine; pass --allow-remote to send book text there`,
    );
  }
  return {
    async complete(request) {
      const started = performance.now();
      const signal = AbortSignal.timeout(timeoutMs);
      const timedOut = (): Error =>
        new Error(
          `llama-server didn't answer within ${String(Math.round(timeoutMs / 1000))} s`,
        );
      const reply = async (): Promise<Response> => {
        try {
          return await fetch(`${baseUrl}/v1/chat/completions`, {
            signal,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [
                { role: "system", content: request.system },
                { role: "user", content: request.prompt },
              ],
              max_tokens: request.maxTokens,
              temperature: request.temperature,
              seed: request.seed,
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "output",
                  strict: true,
                  schema: request.schema,
                },
              },
            }),
          });
        } catch (error) {
          throw signal.aborted ? timedOut() : error;
        }
      };
      const response = await reply();
      if (!response.ok) {
        throw new Error(
          `llama-server returned ${String(response.status)}: ${await response.text()}`,
        );
      }

      // A reply that isn't a chat completion is the server's fault, not the network's, so it says so.
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw signal.aborted
          ? timedOut()
          : new Error("llama-server's reply isn't JSON");
      }
      const parsed = CompletionSchema.safeParse(body);
      if (!parsed.success)
        throw new Error(
          `llama-server's reply isn't a chat completion: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "reply"} ${issue.message}`).join("; ")}`,
        );
      const completion = parsed.data;
      const choice = completion.choices[0];
      return {
        text: choice?.message.content ?? "",
        finishReason: choice?.finish_reason ?? "unknown",
        completionTokens: completion.usage.completion_tokens,
        durationMs: performance.now() - started,
      };
    },
  };
}
