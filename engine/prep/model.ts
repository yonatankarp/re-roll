export interface ModelRequest {
  readonly system: string;
  readonly prompt: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly seed: number;
}

export interface ModelResponse {
  readonly text: string;
  readonly finishReason: string;
  readonly completionTokens: number;
  readonly durationMs: number;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
