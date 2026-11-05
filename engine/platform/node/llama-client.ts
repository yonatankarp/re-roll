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

export function createLlamaClient(baseUrl: string): ModelClient {
  return {
    async complete(request) {
      const started = performance.now();
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
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
      if (!response.ok) {
        throw new Error(
          `llama-server returned ${String(response.status)}: ${await response.text()}`,
        );
      }

      const completion = CompletionSchema.parse(await response.json());
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
