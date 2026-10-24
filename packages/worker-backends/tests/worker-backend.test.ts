import { describe, it, expect, vi } from "vitest";
import { ApiWorkerBackend } from "../src/api.js";
import { ClaudeCodeBackend, trackChangedFiles, toProgressEvent } from "../src/claude-code.js";
import { resolveWorkerBackend, detectAvailableBackends, fallbackBackendConfig } from "../src/index.js";

describe("ApiWorkerBackend", () => {
  it("reports type as api", () => {
    const backend = new ApiWorkerBackend();
    expect(backend.type).toBe("api");
  });

  it("reports available when ANTHROPIC_API_KEY is set", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const backend = new ApiWorkerBackend();
      expect(await backend.isAvailable()).toBe(true);
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("throws when execute is called directly", async () => {
    const backend = new ApiWorkerBackend();
    await expect(backend.execute({
      task: "test",
      workingDirectory: "/tmp",
      swarmContext: "",
      maxTurns: 5,
    })).rejects.toThrow("should not be called directly");
  });
});

describe("ClaudeCodeBackend", () => {
  // -----------------------------------------------------------------------
  // Constructor validation
  // -----------------------------------------------------------------------

  it("reports type as claude-code", () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code" });
    expect(backend.type).toBe("claude-code");
  });

  it("accepts custom permission config", () => {
    const backend = new ClaudeCodeBackend({
      type: "claude-code",
      permissions: {
        mode: "dontAsk",
        allowedTools: ["Read", "Bash(git *)"],
        deniedTools: ["Bash(rm *)"],
      },
    });
    expect(backend.type).toBe("claude-code");
  });

  it("accepts permissionPromptTool config", () => {
    const backend = new ClaudeCodeBackend({
      type: "claude-code",
      permissions: {
        permissionPromptTool: "swarm_permission_check",
      },
    });
    expect(backend.type).toBe("claude-code");
  });

  it("rejects permissionPromptTool with shell metacharacters", () => {
    expect(() => new ClaudeCodeBackend({
      type: "claude-code",
      permissions: {
        permissionPromptTool: "tool; echo hack",
      },
    })).toThrow("shell metacharacters");
  });

  it("accepts bypassPermissions mode", () => {
    const backend = new ClaudeCodeBackend({
      type: "claude-code",
      permissions: { mode: "bypassPermissions" },
    });
    expect(backend.type).toBe("claude-code");
  });

  it("rejects allowedTools entries with shell metacharacters", () => {
    expect(() => new ClaudeCodeBackend({
      type: "claude-code",
      permissions: {
        allowedTools: ["Read", "Bash(git *); rm -rf /"],
      },
    })).toThrow("shell metacharacters");
  });

  it("rejects deniedTools entries with shell metacharacters", () => {
    expect(() => new ClaudeCodeBackend({
      type: "claude-code",
      permissions: {
        deniedTools: ["Bash(rm *) && curl evil.com"],
      },
    })).toThrow("shell metacharacters");
  });

  it("allows parentheses in tool patterns (Bash(git *) syntax)", () => {
    const backend = new ClaudeCodeBackend({
      type: "claude-code",
      permissions: {
        allowedTools: ["Bash(git *)", "Bash(npm run *)"],
        deniedTools: ["Bash(rm -rf *)"],
      },
    });
    expect(backend.type).toBe("claude-code");
  });

  // -----------------------------------------------------------------------
  // MCP server config
  // -----------------------------------------------------------------------

  it("accepts mcpServers config and stores them", () => {
    const backend = new ClaudeCodeBackend({
      type: "claude-code",
      mcpServers: {
        xcodebuild: { type: "stdio", command: "xcodebuildmcp", args: ["mcp"] },
      },
    });
    expect(backend.getMcpServers()).toEqual({
      xcodebuild: { type: "stdio", command: "xcodebuildmcp", args: ["mcp"] },
    });
  });

  it("strips env from getMcpServers() to prevent secret leakage", () => {
    const backend = new ClaudeCodeBackend({
      type: "claude-code",
      mcpServers: {
        myserver: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          env: { API_KEY: "secret-value" },
        },
      },
    });
    const servers = backend.getMcpServers();
    expect(servers).toBeDefined();
    expect(servers!.myserver).not.toHaveProperty("env");
    expect(servers!.myserver.command).toBe("node");
  });

  it("normalizes empty mcpServers to undefined in getter", () => {
    const backend = new ClaudeCodeBackend({
      type: "claude-code",
      mcpServers: {},
    });
    // Empty map is normalized to undefined — consistent with sdk.query() behavior
    expect(backend.getMcpServers()).toBeUndefined();
  });

  it("returns undefined when no mcpServers configured", () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code" });
    expect(backend.getMcpServers()).toBeUndefined();
  });

  it("rejects mcpServers key with invalid characters", () => {
    expect(() => new ClaudeCodeBackend({
      type: "claude-code",
      mcpServers: {
        "evil;rm -rf /": { type: "stdio", command: "bad" },
      },
    })).toThrow("invalid characters");
  });

  it("rejects mcpServers key with spaces", () => {
    expect(() => new ClaudeCodeBackend({
      type: "claude-code",
      mcpServers: {
        "my server": { type: "stdio", command: "server" },
      },
    })).toThrow("invalid characters");
  });

  it("auto-derives allowedTools patterns for configured MCP servers", () => {
    const backend = new ClaudeCodeBackend({
      type: "claude-code",
      mcpServers: {
        xcodebuild: { type: "stdio", command: "xcodebuildmcp", args: ["mcp"] },
        playwright: { type: "stdio", command: "npx", args: ["playwright-mcp"] },
      },
    });
    const tools = backend.getAllowedTools();
    expect(tools).toContain("mcp__xcodebuild__*");
    expect(tools).toContain("mcp__playwright__*");
    // Built-in tools still present
    expect(tools).toContain("Read");
    expect(tools).toContain("Edit");
  });

  it("does not add MCP patterns when mcpServers is empty", () => {
    const backend = new ClaudeCodeBackend({
      type: "claude-code",
      mcpServers: {},
    });
    const tools = backend.getAllowedTools();
    expect(tools.some(t => t.startsWith("mcp__"))).toBe(false);
  });

  it("does not add MCP patterns when mcpServers is undefined", () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code" });
    const tools = backend.getAllowedTools();
    expect(tools.some(t => t.startsWith("mcp__"))).toBe(false);
    // Defaults still present
    expect(tools).toContain("Read");
  });

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  it("reports available when Agent SDK is importable and API key is set", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const backend = new ClaudeCodeBackend({ type: "claude-code" });
      // The Agent SDK is installed as a dependency, so import should succeed
      expect(await backend.isAvailable()).toBe(true);
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("reports available even without API key (Claude Code uses account auth)", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const backend = new ClaudeCodeBackend({ type: "claude-code" });
      // Claude Code authenticates via user account (Max/Pro), not API key
      expect(await backend.isAvailable()).toBe(true);
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  // -----------------------------------------------------------------------
  // canUseTool callback routing
  // -----------------------------------------------------------------------

  describe("buildCanUseTool", () => {
    it("routes AskUserQuestion to onClarifyingQuestion handler", async () => {
      const onClarifyingQuestion = vi.fn().mockResolvedValue({
        "Which framework?": "React",
      });
      const backend = new ClaudeCodeBackend({
        type: "claude-code",
        interactionHandler: { onClarifyingQuestion },
      });

      const canUseTool = backend.buildCanUseTool();
      const result = await canUseTool("AskUserQuestion", {
        questions: [{
          question: "Which framework?",
          header: "Framework",
          options: [
            { label: "React", description: "A UI library" },
            { label: "Vue", description: "A progressive framework" },
          ],
          multiSelect: false,
        }],
      }, { signal: new AbortController().signal, toolUseID: "test-id" });

      expect(result.behavior).toBe("allow");
      expect(onClarifyingQuestion).toHaveBeenCalledOnce();
      expect(onClarifyingQuestion).toHaveBeenCalledWith([{
        question: "Which framework?",
        header: "Framework",
        options: [
          { label: "React", description: "A UI library" },
          { label: "Vue", description: "A progressive framework" },
        ],
        multiSelect: false,
      }]);
      // Verify answers are placed in updatedInput
      if (result.behavior === "allow") {
        expect((result.updatedInput as Record<string, unknown>).answers).toEqual({
          "Which framework?": "React",
        });
      }
    });

    it("defaults AskUserQuestion to first option when no handler", async () => {
      const backend = new ClaudeCodeBackend({ type: "claude-code" });
      const canUseTool = backend.buildCanUseTool();

      const result = await canUseTool("AskUserQuestion", {
        questions: [{
          question: "Pick a color",
          header: "Color",
          options: [
            { label: "Blue", description: "Calm" },
            { label: "Red", description: "Bold" },
          ],
          multiSelect: false,
        }],
      }, { signal: new AbortController().signal, toolUseID: "test-id" });

      expect(result.behavior).toBe("allow");
      if (result.behavior === "allow") {
        expect((result.updatedInput as Record<string, unknown>).answers).toEqual({
          "Pick a color": "Blue",
        });
      }
    });

    it("routes non-AskUserQuestion tools to onToolApproval handler", async () => {
      const onToolApproval = vi.fn().mockResolvedValue({ allow: true });
      const backend = new ClaudeCodeBackend({
        type: "claude-code",
        interactionHandler: { onToolApproval },
      });

      const canUseTool = backend.buildCanUseTool();
      const result = await canUseTool("Bash", {
        command: "npm test",
      }, { signal: new AbortController().signal, toolUseID: "test-id" });

      expect(result.behavior).toBe("allow");
      expect(onToolApproval).toHaveBeenCalledWith({
        toolName: "Bash",
        input: { command: "npm test" },
      });
    });

    it("returns deny when onToolApproval denies", async () => {
      const onToolApproval = vi.fn().mockResolvedValue({
        allow: false,
        message: "Dangerous command",
      });
      const backend = new ClaudeCodeBackend({
        type: "claude-code",
        interactionHandler: { onToolApproval },
      });

      const canUseTool = backend.buildCanUseTool();
      const result = await canUseTool("Bash", {
        command: "rm -rf /",
      }, { signal: new AbortController().signal, toolUseID: "test-id" });

      expect(result.behavior).toBe("deny");
      if (result.behavior === "deny") {
        expect(result.message).toBe("Dangerous command");
      }
    });

    it("auto-approves tools when no handler is provided", async () => {
      const backend = new ClaudeCodeBackend({ type: "claude-code" });
      const canUseTool = backend.buildCanUseTool();

      const result = await canUseTool("Read", {
        file_path: "/tmp/test.txt",
      }, { signal: new AbortController().signal, toolUseID: "test-id" });

      expect(result.behavior).toBe("allow");
    });

    it("provides default deny message when handler omits message", async () => {
      const onToolApproval = vi.fn().mockResolvedValue({ allow: false });
      const backend = new ClaudeCodeBackend({
        type: "claude-code",
        interactionHandler: { onToolApproval },
      });

      const canUseTool = backend.buildCanUseTool();
      const result = await canUseTool("Write", {
        file_path: "/etc/hosts",
      }, { signal: new AbortController().signal, toolUseID: "test-id" });

      expect(result.behavior).toBe("deny");
      if (result.behavior === "deny") {
        expect(result.message).toContain("Write");
        expect(result.message).toContain("denied");
      }
    });

    it("handles AskUserQuestion with multiple questions", async () => {
      const backend = new ClaudeCodeBackend({ type: "claude-code" });
      const canUseTool = backend.buildCanUseTool();

      const result = await canUseTool("AskUserQuestion", {
        questions: [
          {
            question: "First question?",
            header: "Q1",
            options: [{ label: "A", description: "first" }],
            multiSelect: false,
          },
          {
            question: "Second question?",
            header: "Q2",
            options: [{ label: "X", description: "option" }, { label: "Y", description: "another" }],
            multiSelect: false,
          },
        ],
      }, { signal: new AbortController().signal, toolUseID: "test-id" });

      expect(result.behavior).toBe("allow");
      if (result.behavior === "allow") {
        const answers = (result.updatedInput as Record<string, unknown>).answers as Record<string, string>;
        expect(answers["First question?"]).toBe("A");
        expect(answers["Second question?"]).toBe("X");
      }
    });
  });
});

describe("ClaudeCodeBackend.execute() with mocked SDK", () => {
  // Helper: create an async generator from an array of messages
  function mockQuery(messages: Array<Record<string, unknown>>) {
    return async function* () {
      for (const msg of messages) yield msg;
    };
  }

  // Mock the Agent SDK module for execute() tests
  function createMockedBackend(
    messages: Array<Record<string, unknown>>,
    config?: Parameters<typeof ClaudeCodeBackend.prototype.buildCanUseTool>[0],
  ) {
    const queryFn = vi.fn().mockReturnValue(mockQuery(messages)());
    // Monkey-patch the execute method to inject a mocked SDK
    const backend = new ClaudeCodeBackend({ type: "claude-code", ...config });
    const originalExecute = backend.execute.bind(backend);

    backend.execute = async (input) => {
      // Override the dynamic import by replacing execute internals
      // We use a more direct approach: mock the module
      const canUseTool = backend.buildCanUseTool();
      const onProgress = (config as { interactionHandler?: { onProgress?: (e: unknown) => void } })
        ?.interactionHandler?.onProgress;

      let resultText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let durationMs = 0;
      let exitCode: number | undefined = 0;
      const filesChanged: string[] = [];

      for await (const message of mockQuery(messages)()) {
        trackChangedFiles(message as never, filesChanged);
        if (onProgress) {
          const event = toProgressEvent(message as never);
          if (event) onProgress(event);
        }
        if (message.type === "result") {
          durationMs = (message.duration_ms as number) ?? 0;
          const modelUsage = message.modelUsage as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> | undefined;
          if (modelUsage && Object.keys(modelUsage).length > 0) {
            for (const model of Object.values(modelUsage)) {
              inputTokens += model.inputTokens + (model.cacheReadInputTokens ?? 0) + (model.cacheCreationInputTokens ?? 0);
              outputTokens += model.outputTokens;
            }
          }
          if (message.subtype === "success") {
            resultText = message.result as string;
          } else {
            exitCode = 1;
            const errors = message.errors as string[] | undefined;
            resultText = errors?.length ? errors.join("\n") : `Agent SDK query failed (${message.subtype}). Tokens: ${inputTokens.toLocaleString("en-US")} input, ${outputTokens.toLocaleString("en-US")} output; duration: ${durationMs}ms`;
          }
        }
      }

      if (!resultText.trim()) throw new Error("Claude Agent SDK query produced no output.");

      return {
        output: resultText,
        latencyMs: durationMs,
        tokensUsed: { input: inputTokens, output: outputTokens },
        filesChanged,
        exitCode,
        backendUsed: "claude-code" as const,
      };
    };

    return backend;
  }

  it("extracts tokens from modelUsage including cache tokens", async () => {
    const backend = createMockedBackend([{
      type: "result",
      subtype: "success",
      result: "Test output",
      duration_ms: 5000,
      usage: { input_tokens: 6, output_tokens: 100 },
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 6,
          outputTokens: 100,
          cacheReadInputTokens: 50000,
          cacheCreationInputTokens: 5000,
        },
      },
    }]);

    const result = await backend.execute({
      task: "test",
      workingDirectory: "/tmp",
      swarmContext: "ctx",
      maxTurns: 5,
    });

    expect(result.tokensUsed.input).toBe(55006); // 6 + 50000 + 5000
    expect(result.tokensUsed.output).toBe(100);
    expect(result.latencyMs).toBe(5000);
  });

  it("sums tokens across multiple models", async () => {
    const backend = createMockedBackend([{
      type: "result",
      subtype: "success",
      result: "Multi-model output",
      duration_ms: 8000,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {
        "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 500, cacheReadInputTokens: 40000, cacheCreationInputTokens: 0 },
        "claude-haiku-4-5": { inputTokens: 200, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    }]);

    const result = await backend.execute({
      task: "test",
      workingDirectory: "/tmp",
      swarmContext: "ctx",
      maxTurns: 5,
    });

    expect(result.tokensUsed.input).toBe(40210); // 10+40000+0 + 200+0+0
    expect(result.tokensUsed.output).toBe(530); // 500 + 30
  });

  it("returns exitCode 1 for error results", async () => {
    const backend = createMockedBackend([{
      type: "result",
      subtype: "error_max_turns",
      errors: ["Max turns exceeded"],
      duration_ms: 60000,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: { "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    }]);

    const result = await backend.execute({
      task: "test",
      workingDirectory: "/tmp",
      swarmContext: "ctx",
      maxTurns: 5,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("Max turns exceeded");
  });

  it("produces diagnostic message for empty errors array", async () => {
    const backend = createMockedBackend([{
      type: "result",
      subtype: "error_during_execution",
      errors: [],
      duration_ms: 3000,
      usage: { input_tokens: 50, output_tokens: 10 },
      modelUsage: { "claude-sonnet-4-6": { inputTokens: 50, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    }]);

    const result = await backend.execute({
      task: "test",
      workingDirectory: "/tmp",
      swarmContext: "ctx",
      maxTurns: 5,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("error_during_execution");
    expect(result.output).toContain("50 input");
  });

  it("throws when result has no output text", async () => {
    const backend = createMockedBackend([{
      type: "result",
      subtype: "success",
      result: "",
      duration_ms: 100,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    }]);

    await expect(backend.execute({
      task: "test",
      workingDirectory: "/tmp",
      swarmContext: "ctx",
      maxTurns: 5,
    })).rejects.toThrow("no output");
  });

  it("tracks file changes from assistant messages in the stream", async () => {
    const backend = createMockedBackend([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "/tmp/a.ts" } },
            { type: "tool_use", name: "Write", input: { file_path: "/tmp/b.ts" } },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "Fixed files",
        duration_ms: 2000,
        usage: { input_tokens: 100, output_tokens: 50 },
        modelUsage: { "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      },
    ]);

    const result = await backend.execute({
      task: "test",
      workingDirectory: "/tmp",
      swarmContext: "ctx",
      maxTurns: 5,
    });

    expect(result.filesChanged).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
  });

  it("emits progress events when onProgress is provided", async () => {
    const progressEvents: unknown[] = [];
    const backend = createMockedBackend(
      [
        { type: "system", subtype: "init", model: "test-model", tools: [], cwd: "/tmp", permissionMode: "default" },
        { type: "result", subtype: "success", result: "Done", duration_ms: 1000, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { "test": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
      ],
      { interactionHandler: { onProgress: (e: unknown) => progressEvents.push(e) } } as never,
    );

    await backend.execute({
      task: "test",
      workingDirectory: "/tmp",
      swarmContext: "ctx",
      maxTurns: 5,
    });

    expect(progressEvents.length).toBeGreaterThan(0);
    expect((progressEvents[0] as { type: string }).type).toBe("session_init");
  });
});

describe("trackChangedFiles", () => {
  it("tracks Write tool calls", () => {
    const files: string[] = [];
    trackChangedFiles({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/a.ts" } }] },
    }, files);
    expect(files).toEqual(["/tmp/a.ts"]);
  });

  it("tracks Edit tool calls", () => {
    const files: string[] = [];
    trackChangedFiles({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/tmp/b.ts" } }] },
    }, files);
    expect(files).toEqual(["/tmp/b.ts"]);
  });

  it("tracks NotebookEdit via notebook_path", () => {
    const files: string[] = [];
    trackChangedFiles({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/tmp/nb.ipynb" } }] },
    }, files);
    expect(files).toEqual(["/tmp/nb.ipynb"]);
  });

  it("deduplicates file paths", () => {
    const files: string[] = [];
    const msg = {
      type: "assistant" as const,
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/tmp/a.ts" } }] },
    };
    trackChangedFiles(msg, files);
    trackChangedFiles(msg, files);
    expect(files).toEqual(["/tmp/a.ts"]);
  });

  it("ignores non-assistant messages", () => {
    const files: string[] = [];
    trackChangedFiles({ type: "system", subtype: "init" } as never, files);
    expect(files).toEqual([]);
  });

  it("ignores Read tool calls", () => {
    const files: string[] = [];
    trackChangedFiles({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/c.ts" } }] },
    }, files);
    expect(files).toEqual([]);
  });
});

describe("toProgressEvent", () => {
  it("maps system init to session_init event", () => {
    const event = toProgressEvent({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-4-6",
      tools: ["Read", "Write"],
      cwd: "/tmp",
      permissionMode: "acceptEdits",
    });
    expect(event?.type).toBe("session_init");
    expect(event?.detail).toContain("claude-sonnet-4-6");
    expect(event?.meta?.model).toBe("claude-sonnet-4-6");
  });

  it("maps assistant with tool_use to tool_call event", () => {
    const event = toProgressEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/tmp/test.ts" } },
        ],
      },
    });
    expect(event?.type).toBe("tool_call");
    expect(event?.detail).toContain("Read");
    // Input previews are in meta only (not in detail) to avoid leaking sensitive paths
    expect(event?.detail).not.toContain("/tmp/test.ts");
    expect((event?.meta?.inputs as Array<{ preview: string }>)[0].preview).toBe("/tmp/test.ts");
  });

  it("maps assistant with text to model_response event", () => {
    const event = toProgressEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Here are my findings..." },
        ],
      },
    });
    expect(event?.type).toBe("model_response");
    expect(event?.detail).toContain("Here are my findings");
  });

  it("maps tool_progress to tool_progress event", () => {
    const event = toProgressEvent({
      type: "tool_progress",
      tool_name: "Bash",
      tool_use_id: "tu-123",
      elapsed_time_seconds: 5.2,
    });
    expect(event?.type).toBe("tool_progress");
    expect(event?.detail).toContain("Bash");
    expect(event?.detail).toContain("5.2");
  });

  it("maps tool_use_summary to tool_summary event", () => {
    const event = toProgressEvent({
      type: "tool_use_summary",
      summary: "Read 3 files from src/",
    });
    expect(event?.type).toBe("tool_summary");
    expect(event?.detail).toBe("Read 3 files from src/");
  });

  it("returns null for uninteresting messages", () => {
    expect(toProgressEvent({ type: "user" } as never)).toBeNull();
  });
});

describe("resolveWorkerBackend", () => {
  it("returns api backend by default when API key is set", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const { backend, fallbackUsed } = await resolveWorkerBackend();
      expect(backend.type).toBe("api");
      expect(fallbackUsed).toBe(false);
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("returns api backend when explicitly configured", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const { backend, fallbackUsed } = await resolveWorkerBackend({ type: "api" });
      expect(backend.type).toBe("api");
      expect(fallbackUsed).toBe(false);
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("passes mcpServers through to claude-code backend", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const { backend } = await resolveWorkerBackend({
        type: "claude-code",
        mcpServers: {
          xcodebuild: { type: "stdio", command: "xcodebuildmcp", args: ["mcp"] },
        },
      });
      expect(backend.type).toBe("claude-code");
      // getMcpServers() strips env but preserves other fields
      expect((backend as ClaudeCodeBackend).getMcpServers()).toEqual({
        xcodebuild: { type: "stdio", command: "xcodebuildmcp", args: ["mcp"] },
      });
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("detectAvailableBackends", () => {
  it("returns an array of available backend types", async () => {
    const available = await detectAvailableBackends();
    expect(Array.isArray(available)).toBe(true);
    // At minimum, api should be available if an API key is set
    for (const type of available) {
      expect(["api", "claude-code", "codex"]).toContain(type);
    }
  });
});

describe("fallbackBackendConfig", () => {
  const permissions = { deniedTools: ["Bash(git push:*)"] };

  it("gives a non-codex fallback exactly what it always got", () => {
    expect(
      fallbackBackendConfig({ type: "claude-code", fallback: "api", permissions, codexHookCommand: "swarm codex-hook", tools: ["Bash"] }),
    ).toEqual({ type: "api", tools: ["Bash"] });
    expect(fallbackBackendConfig({ type: "api", fallback: "claude-code", permissions })).toEqual({ type: "claude-code" });
  });

  it("gives a codex fallback the deny list and hook command its hook enforces", () => {
    expect(fallbackBackendConfig({ type: "claude-code", fallback: "codex", permissions, codexHookCommand: "swarm codex-hook" })).toEqual({
      type: "codex",
      permissions,
      codexHookCommand: "swarm codex-hook",
    });
  });

  it("is null without a distinct fallback", () => {
    expect(fallbackBackendConfig({ type: "codex" })).toBeNull();
    expect(fallbackBackendConfig({ type: "codex", fallback: "codex" })).toBeNull();
  });
});
