import * as vscode from "vscode";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

export interface LLMProvider {
  chat(messages: Message[], selectedModel?: string, abortSignal?: AbortSignal): Promise<string>;
  chatStream(messages: Message[], onChunk: (chunk: string) => void, selectedModel?: string, abortSignal?: AbortSignal): Promise<string>;
}

/**
 * Estimate token count for a string.
 * Approximation: ~4 characters per token for English/code text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens in a message array.
 */
export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg.content) + 4, 0);
}

/**
 * Talks to Ollama via the OpenAI-compatible /v1/chat/completions endpoint.
 * All settings (endpoint, model, temperature) are read from VS Code configuration
 * so they can be changed without touching source code.
 */
export class OllamaProvider implements LLMProvider {
  /**
   * Fetch available models from Ollama.
   */
  async listModels(): Promise<OllamaModel[]> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const endpoint = config.get<string>("endpoint", "http://localhost:11435/v1/chat/completions");
    
    // Extract base URL from the endpoint (remove /v1/chat/completions part)
    const baseUrl = endpoint.replace(/\/v1\/chat\/completions$/, "");
    const tagsUrl = `${baseUrl}/api/tags`;

    try {
      const response = await fetch(tagsUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as { models: OllamaModel[] };
      return data.models || [];
    } catch (err) {
      throw new Error(
        `Failed to fetch models from Ollama at "${tagsUrl}". Is Ollama running?\n${err}`
      );
    }
  }

  async chat(messages: Message[], selectedModel?: string, abortSignal?: AbortSignal): Promise<string> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const endpoint = config.get<string>("endpoint", "http://localhost:11435/v1/chat/completions");
    const configModel = config.get<string>("model", "qwen2.5-coder:32b");
    const model = selectedModel || configModel;
    const temperature = config.get<number>("temperature", 0.2);

    if (abortSignal?.aborted) {
      throw new Error("Operation cancelled by user.");
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer ollama",
        },
        body: JSON.stringify({ model, messages, temperature }),
        signal: abortSignal,
      });
    } catch (err) {
      if (abortSignal?.aborted) {
        throw new Error("Operation cancelled by user.");
      }
      throw new Error(
        `Failed to reach Ollama at "${endpoint}". Is Ollama running?\n${err}`
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Ollama returned HTTP ${response.status}: ${body}`
      );
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0].message.content;
  }

  /**
   * Streaming chat completion. Calls onChunk for each token received.
   * Returns the full accumulated response.
   */
  async chatStream(messages: Message[], onChunk: (chunk: string) => void, selectedModel?: string, abortSignal?: AbortSignal): Promise<string> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const endpoint = config.get<string>("endpoint", "http://localhost:11435/v1/chat/completions");
    const configModel = config.get<string>("model", "qwen2.5-coder:32b");
    const model = selectedModel || configModel;
    const temperature = config.get<number>("temperature", 0.2);

    if (abortSignal?.aborted) {
      throw new Error("Operation cancelled by user.");
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer ollama",
        },
        body: JSON.stringify({ model, messages, temperature, stream: true }),
        signal: abortSignal,
      });
    } catch (err) {
      if (abortSignal?.aborted) {
        throw new Error("Operation cancelled by user.");
      }
      throw new Error(
        `Failed to reach Ollama at "${endpoint}". Is Ollama running?\n${err}`
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Ollama returned HTTP ${response.status}: ${body}`
      );
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let buffer = "";

    try {
      while (true) {
        if (abortSignal?.aborted) {
          reader.cancel();
          throw new Error("Operation cancelled by user.");
        }
        
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          
          // Handle "data: " prefix from SSE format
          const jsonStr = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
          if (!jsonStr) continue;

          try {
            const parsed = JSON.parse(jsonStr) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            };
            
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullContent += content;
              onChunk(content);
            }
            
            if (parsed.choices?.[0]?.finish_reason === "stop") {
              break;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        throw new Error("Operation cancelled by user.");
      }
      throw err;
    }

    return fullContent;
  }
}
