import { LLMProvider, Message } from "../agent/llm";

/**
 * A fake LLM that cycles through pre-scripted responses.
 * Use this in tests or during development to avoid needing Ollama.
 *
 * Usage in extension.ts (dev mode only):
 *   import { MockProvider } from "./test/mockProvider";
 *   const provider = new MockProvider([...]);
 */
export class MockProvider implements LLMProvider {
  private callCount = 0;

  constructor(private readonly responses: string[]) {}

  async chat(_messages: Message[]): Promise<string> {
    const response = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
    this.callCount++;
    return response;
  }

  async chatStream(_messages: Message[], onChunk: (chunk: string) => void): Promise<string> {
    const response = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
    this.callCount++;
    // Simulate streaming by sending the response in chunks
    const chunkSize = 10;
    for (let i = 0; i < response.length; i += chunkSize) {
      const chunk = response.slice(i, i + chunkSize);
      onChunk(chunk);
      // Small delay to simulate streaming
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return response;
  }
}

// ── Ready-made scenarios ──────────────────────────────────────────────────────

/** Agent creates one file then signals it's done. */
export const SCENARIO_CREATE_FILE = [
  JSON.stringify({
    thought: "I will create hello.ts with a greet function.",
    actions: [
      {
        tool: "create_file",
        path: "hello.ts",
        content: `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
      },
    ],
  }),
  // Second iteration: no more actions → agent stops
  JSON.stringify({
    thought: "File created successfully. Nothing more to do.",
    actions: [],
  }),
];

/** Agent reads a file first, then edits it. */
export const SCENARIO_READ_THEN_EDIT = [
  JSON.stringify({
    thought: "Let me read the existing file first.",
    actions: [{ tool: "read_file", path: "hello.ts" }],
  }),
  JSON.stringify({
    thought: "I have the file contents. Now I will add a farewell function.",
    actions: [
      {
        tool: "edit_file",
        path: "hello.ts",
        content: `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n\nexport function farewell(name: string): string {\n  return \`Goodbye, \${name}!\`;\n}\n`,
      },
    ],
  }),
  JSON.stringify({
    thought: "Done.",
    actions: [],
  }),
];
