import type {
  ExecutionInput,
  ExecutionResult,
  ModelProvider,
  ProviderName,
  ToolDefinition,
  ToolUseResult,
} from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Retry wrapper for rate-limit and overloaded errors
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 5000;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const isRetryable = status === 429 || status === 529;

      if (isRetryable && attempt < MAX_RETRIES - 1) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.log(`  [retry] ${label}: ${status === 429 ? "rate limited" : "overloaded"}, waiting ${backoff / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      throw err;
    }
  }
  // This line should be unreachable but satisfies TypeScript
  throw new Error(`${label}: max retries exceeded`);
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements ModelProvider {
  name: ProviderName = "anthropic";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async execute(input: ExecutionInput, model: string): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Dynamic import to avoid requiring the SDK when not using Anthropic
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey });

    const response = await withRetry(
      () => client.messages.create({
        model,
        max_tokens: 4096,
        system: input.systemContext,
        messages: [{ role: "user", content: input.prompt }],
      }),
      "Anthropic API",
    );

    const latencyMs = Date.now() - startTime;
    const outputText = response.content
      .filter((block) => block.type === "text")
      .map((block) => ("text" in block ? block.text : ""))
      .join("\n");

    return {
      output: outputText,
      tokens: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
      latencyMs,
      model: { provider: "anthropic", modelId: model },
    };
  }

  async executeWithTools(
    systemContext: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: ToolDefinition[],
    model: string,
  ): Promise<ToolUseResult> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey });

    const response = await withRetry(
      () => client.messages.create({
        model,
        max_tokens: 16384,
        system: systemContext,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: messages as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: tools as any,
      }),
      "Anthropic API (tools)",
    );

    const outputText = response.content
      .filter((b: { type: string }) => b.type === "text")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((b: any) => b.text as string)
      .join("\n");

    const toolUseBlocks = response.content
      .filter((b: { type: string }) => b.type === "tool_use")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((b: any) => ({
        id: b.id as string,
        name: b.name as string,
        input: b.input as Record<string, unknown>,
      }));

    return {
      response,
      outputText,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason ?? "end_turn",
      toolUseBlocks,
      assistantMessage: { role: "assistant" as const, content: response.content },
    };
  }

}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements ModelProvider {
  name: ProviderName = "openai";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async execute(input: ExecutionInput, model: string): Promise<ExecutionResult> {
    const startTime = Date.now();

    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: this.apiKey });

    const response = await withRetry(
      () => client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: input.systemContext },
          { role: "user", content: input.prompt },
        ],
        max_tokens: 4096,
      }),
      "OpenAI API",
    );

    const latencyMs = Date.now() - startTime;
    const outputText = response.choices[0]?.message?.content ?? "";

    return {
      output: outputText,
      tokens: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
      latencyMs,
      model: { provider: "openai", modelId: model },
    };
  }

  async executeWithTools(
    systemContext: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: ToolDefinition[],
    model: string,
  ): Promise<ToolUseResult> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: this.apiKey });

    // Map Anthropic-style tool definitions to OpenAI's function calling format
    const openaiTools = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    // Convert messages to OpenAI format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openaiMessages: any[] = [
      { role: "system", content: systemContext },
    ];

    for (const msg of messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          openaiMessages.push({ role: "user", content: msg.content });
        } else if (Array.isArray(msg.content)) {
          // Tool results — convert from Anthropic format to OpenAI format
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const item of msg.content as any[]) {
            if (item.type === "tool_result") {
              openaiMessages.push({
                role: "tool",
                tool_call_id: item.tool_use_id,
                content: item.content,
              });
            }
          }
        }
      } else if (msg.role === "assistant") {
        // Convert assistant message with tool_use blocks to OpenAI format
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const content = msg.content as any;
        if (Array.isArray(content)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const textParts = content.filter((b: any) => b.type === "text");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const toolParts = content.filter((b: any) => b.type === "tool_use");

          const assistantMsg: Record<string, unknown> = {
            role: "assistant",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content: textParts.map((b: any) => b.text).join("\n") || null,
          };

          if (toolParts.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            assistantMsg.tool_calls = toolParts.map((b: any) => ({
              id: b.id,
              type: "function",
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input),
              },
            }));
          }

          openaiMessages.push(assistantMsg);
        } else {
          openaiMessages.push({ role: "assistant", content });
        }
      }
    }

    const response = await withRetry(
      () => client.chat.completions.create({
        model,
        messages: openaiMessages,
        tools: openaiTools,
        max_tokens: 8192,
      }),
      "OpenAI API (tools)",
    );

    const choice = response.choices[0];
    const outputText = choice?.message?.content ?? "";

    // Convert OpenAI tool_calls to our unified format
    const toolUseBlocks = (choice?.message?.tool_calls ?? [])
      .filter((tc): tc is Extract<typeof tc, { type: "function" }> => tc.type === "function")
      .map((tc) => {
        let parsedInput: Record<string, unknown>;
        try {
          parsedInput = JSON.parse(tc.function.arguments);
        } catch {
          parsedInput = { raw: tc.function.arguments };
        }
        return {
          id: tc.id,
          name: tc.function.name,
          input: parsedInput,
        };
      });

    // Determine stop reason
    let stopReason = "end_turn";
    if (choice?.finish_reason === "tool_calls") {
      stopReason = "tool_use";
    } else if (choice?.finish_reason === "stop") {
      stopReason = "end_turn";
    } else if (choice?.finish_reason === "length") {
      stopReason = "max_tokens";
    }

    return {
      response,
      outputText,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      stopReason,
      toolUseBlocks,
      assistantMessage: {
        role: "assistant" as const,
        content: choice.message.content,
        tool_calls: choice.message.tool_calls,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createProvider(
  provider: ProviderName,
  apiKey: string,
): ModelProvider {
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(apiKey);
    case "openai":
      return new OpenAIProvider(apiKey);
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}
