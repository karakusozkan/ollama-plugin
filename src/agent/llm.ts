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

class StreamingStalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamingStalledError";
  }
}

type ChatApiKind = "ollama" | "openai";
type OllamaChatFormat = "auto" | "peg-native";

interface OpenAiModelsResponse {
  data?: Array<{
    id: string;
    created?: number;
  }>;
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
 * Talks to either Ollama's native /api/chat endpoint or an OpenAI-compatible
 * /v1/chat/completions endpoint, depending on configuration.
 */
export class OllamaProvider implements LLMProvider {
  outputChannel?: vscode.OutputChannel;
  private readonly _nonStreamingEndpoints = new Set<string>();
  private _activeEndpoint: string | null = null;
  // Hold discovered/configured native API endpoints (Ollama `/api/chat` style)
  private readonly _apiEndpoints = new Set<string>();
  // Hold discovered/configured OpenAI-style v1 endpoints (/v1 or /v1/chat/completions)
  private readonly _v1Endpoints = new Set<string>();

  private _log(msg: string): void {
    this.outputChannel?.appendLine(msg);
  }

  private _normalizeEndpointKey(endpoint: string): string {
    return endpoint.trim().replace(/\/+$/, "").toLowerCase();
  }

  private _hasStreamingOverride(endpoint: string): boolean {
    return this._nonStreamingEndpoints.has(this._normalizeEndpointKey(endpoint));
  }

  private _markEndpointAsNonStreaming(endpoint: string, reason: string): void {
    const key = this._normalizeEndpointKey(endpoint);
    if (this._nonStreamingEndpoints.has(key)) {
      return;
    }

    this._nonStreamingEndpoints.add(key);
    this._log(`[llm/stream] caching non-streaming mode for ${endpoint}: ${reason}`);
  }

  /**
   * Reload internal provider state (clear caches) so endpoints/plugins
   * are re-evaluated on the next request.
   */
  public async reload(): Promise<void> {
    this._nonStreamingEndpoints.clear();
    this._activeEndpoint = null;
    this._apiEndpoints.clear();
    this._v1Endpoints.clear();
    this._log(`[llm] reload: cleared non-streaming endpoint cache and reset active endpoint/endpoints lists`);

    try {
      await this.autoWireEndpoint();
      this._log(`[llm] reload: autoWireEndpoint completed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`[llm] reload: autoWireEndpoint failed: ${msg}`);
    }
  }

  /** Return discovered/configured native API endpoints (Ollama `/api/chat` style). */
  public get apiEndpoints(): string[] {
    return Array.from(this._apiEndpoints.values());
  }

  /** Return discovered/configured OpenAI-style v1 endpoints. */
  public get v1Endpoints(): string[] {
    return Array.from(this._v1Endpoints.values());
  }

  private _getEndpoint(): string {
    if (this._activeEndpoint) return this._activeEndpoint;
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const configured = config.get<string>("endpoint");
    const env = process.env.OLLAMA_ENDPOINT || process.env.OLLAMA_URL;
    return (configured && configured.trim()) || (env && env.trim()) || "";
  }

  /** Probe a list of candidate endpoints and set an active endpoint that responds to discovery. */
  public async autoWireEndpoint(): Promise<void> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const configured = config.get<string>("endpoint", "");
    const normalized = (configured || "").trim().replace(/\/+$/, "");

    // If the user explicitly configured a native Ollama chat endpoint, prefer it immediately
    // to avoid probing OpenAI-style discovery paths that can produce double-path requests.
    if (normalized && /\/api\/chat(?:\/|$)/i.test(normalized)) {
      this._activeEndpoint = normalized;
      this._apiEndpoints.add(normalized.replace(/\/+$/, ""));
      this._log(`[llm/autowire] configured endpoint is explicit Ollama-native: ${this._activeEndpoint}`);
      return;
    }

    // If the user explicitly configured an OpenAI-style v1 chat endpoint, prefer it immediately
    if (normalized && /\/v1(?:\/|$)/i.test(normalized)) {
      // normalize to either the provided path (if it contains /v1/chat or completions) or to /v1 base
      const asBase = normalized.replace(/\/v1\/chat(?:\/completions)?(?:\/?$)/i, '/v1').replace(/\/+$/, '');
      this._activeEndpoint = normalized;
      this._v1Endpoints.add(asBase);
      this._log(`[llm/autowire] configured endpoint is explicit OpenAI-style v1: ${this._activeEndpoint}`);
      return;
    }
    // Build two separate candidate lists: one for OpenAI-style (/v1) and one for Ollama-native (/api).
    const v1Candidates: string[] = [];
    const nativeCandidates: string[] = [];

    if (normalized) {
      // If the configured endpoint already looks v1-ish, put it into v1Candidates.
      if (/\/v1(\/|$)/i.test(normalized) || /models(\/|$)/i.test(normalized) || /chat(\/|$)/i.test(normalized)) {
        v1Candidates.push(normalized);
      }

      // If the configured endpoint already looks native (/api), put it into nativeCandidates.
      if (/\/api(\/|$)/i.test(normalized) || /tags(\/|$)/i.test(normalized)) {
        nativeCandidates.push(normalized);
      }

      try {
        const url = new URL(normalized || "http://localhost");
        const hostBase = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ``}`;
        // Only add host-level candidates if the configured endpoint didn't already include the path.
        if (!/\/(?:v1|api)\b/i.test(normalized)) {
          v1Candidates.push(`${hostBase}/v1`);
          nativeCandidates.push(`${hostBase}/api`);
        } else {
          // If configured included a deeper path, also include the host base as a fallback.
          v1Candidates.push(`${hostBase}/v1`);
          nativeCandidates.push(`${hostBase}/api`);
        }
      } catch {
        // ignore
      }
    } else {
      // No configured endpoint — probe common env/host fallbacks if available.
      try {
        const url = new URL("http://localhost");
        const hostBase = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ``}`;
        v1Candidates.push(`${hostBase}/v1`);
        nativeCandidates.push(`${hostBase}/api`);
      } catch {
        // ignore
      }
    }

    // Add endpoints from environment variables if provided (avoid hardcoding other defaults).
    const envEndpoint = (process.env.OLLAMA_ENDPOINT || process.env.OLLAMA_URL || "").trim().replace(/\/+$/, "");
    if (envEndpoint) {
      if (/\/(?:v1)\b/i.test(envEndpoint) || /models(\/|$)/i.test(envEndpoint) || /chat(\/|$)/i.test(envEndpoint)) {
        v1Candidates.unshift(envEndpoint);
      }
      if (/\/(?:api)\b/i.test(envEndpoint) || /tags(\/|$)/i.test(envEndpoint)) {
        nativeCandidates.unshift(envEndpoint);
      }
      // Also include as generic fallback in both lists so we try both discovery flows.
      v1Candidates.push(envEndpoint);
      nativeCandidates.push(envEndpoint);
    } else if (process.env.OLLAMA_HOST) {
      const host = process.env.OLLAMA_HOST.trim();
      const port = process.env.OLLAMA_PORT ? `:${process.env.OLLAMA_PORT.trim()}` : "";
      const hostUrl = `${host.startsWith('http') ? host : `http://${host}`}${port}`;
      v1Candidates.push(hostUrl);
      nativeCandidates.push(hostUrl);
    }

    // Helper to try OpenAI-style discovery on a candidate
    const tryV1 = async (c: string) => {
      try {
        const base = c.replace(/\/+$/, "");
        const modelsUrl = `${base}/models`;
        const res = await fetch(modelsUrl, { method: "GET", headers: { "Content-Type": "application/json" } });
        if (res.ok) {
          // Prefer using an explicit chat endpoint if candidate already included chat path
          if (/\/v1\/chat(?:\/|$)/i.test(base) || /chat\/completions(?:\/|$)/i.test(base)) {
            this._activeEndpoint = base;
          } else if (/\/v1(?:\/|$)/i.test(base)) {
            // Candidate points at /v1 base — use that base so downstream logic can build paths.
            this._activeEndpoint = base;
          } else {
            // Candidate is likely a host (no /v1) — set to host/v1 as active endpoint.
            this._activeEndpoint = `${base}/v1`;
          }
          this._log(`[llm/autowire] selected OpenAI-style endpoint: ${this._activeEndpoint}`);
          // Record v1 base in the v1 list (normalize to base /v1 if needed)
          const v1Base = (this._activeEndpoint || base).replace(/\/v1\/chat(?:\/completions)?(?:\/?$)/i, '/v1').replace(/\/+$/, '');
          this._v1Endpoints.add(v1Base);
          return true;
        }
      } catch {
        // ignore
      }
      return false;
    };

    // Helper to try Ollama-native discovery on a candidate
    const tryNative = async (c: string) => {
      try {
        const base = c.replace(/\/+$/, "");
        // Try tags discovery
        const tagsUrl = `${base}/api/tags`;
        const res2 = await fetch(tagsUrl, { method: "GET", headers: { "Content-Type": "application/json" } });
        if (res2.ok) {
          // If candidate already includes /api/chat, use it directly; otherwise normalize to host base + /api/chat
          if (/\/api\/chat(?:\/|$)/i.test(base)) {
            this._activeEndpoint = base;
          } else {
            // Strip any trailing /api or /api/xxx and append /api/chat
            const stripped = base.replace(/\/api(\/.*)?$/i, "").replace(/\/+$/, "");
            this._activeEndpoint = `${stripped}/api/chat`;
          }
          // Record the native API endpoint in the api list
          this._apiEndpoints.add(this._activeEndpoint.replace(/\/+$/, ""));
          this._log(`[llm/autowire] selected Ollama-native endpoint: ${this._activeEndpoint}`);
          return true;
        }
      } catch {
        // ignore
      }
      return false;
    };

    // Probe v1 candidates first (prefer OpenAI-style when configured as such)
    for (const c of v1Candidates) {
      if (!c) continue;
      const ok = await tryV1(c);
      if (ok) return;
    }

    // Then probe native candidates
    for (const c of nativeCandidates) {
      if (!c) continue;
      const ok = await tryNative(c);
      if (ok) return;
    }

    this._log(`[llm/autowire] no candidate endpoints responded; keeping configured endpoint`);
  }

  private _getConfiguredModel(): string | undefined {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const model = config.get<string>("model");
    return model?.trim() || undefined;
  }

  private _getOllamaChatFormat(): OllamaChatFormat {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const format = config.get<string>("chatFormat", "auto");
    return format === "peg-native" ? "peg-native" : "auto";
  }

  private _shouldUseStreaming(): boolean {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    return config.get<boolean>("useStreaming", true);
  }

  private _getStreamingStallTimeoutMs(): number {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    return Math.max(0, config.get<number>("streamingStallTimeoutMs", 60000));
  }

  private _getRequestTimeoutMs(): number {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    return Math.max(0, config.get<number>("requestTimeoutMs", 120000));
  }

  private _createRequestSignal(timeoutMs: number, abortSignal?: AbortSignal): {
    signal: AbortSignal;
    didTimeout: () => boolean;
    dispose: () => void;
  } {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;

    if (abortSignal) {
      abortHandler = () => controller.abort();
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    return {
      signal: controller.signal,
      didTimeout: () => timedOut,
      dispose: () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (abortHandler) {
          abortSignal?.removeEventListener("abort", abortHandler);
        }
      },
    };
  }

  private _getOllamaBaseUrl(): string {
    const endpoint = this._getEndpoint();

    try {
      const url = new URL(endpoint);
      let pathname = url.pathname.replace(/\/+$/, "");

      if (pathname.endsWith("/api/chat")) {
        pathname = pathname.slice(0, -"/api/chat".length);
      } else if (pathname.endsWith("/v1/chat/completions")) {
        pathname = pathname.slice(0, -"/v1/chat/completions".length);
      } else if (pathname.endsWith("/v1/chat")) {
        // Support endpoints that point at /v1/chat (OpenAI-style chat path)
        pathname = pathname.slice(0, -"/v1/chat".length);
      } else if (pathname.endsWith("/chat/completions")) {
        pathname = pathname.slice(0, -"/chat/completions".length);
      }

      url.pathname = pathname || "/";
      url.search = "";
      url.hash = "";

      return url.toString().replace(/\/$/, "");
    } catch {
      return endpoint
        .replace(/\/api\/chat\/?$/, "")
        .replace(/\/v1\/chat\/completions\/?$/, "")
        .replace(/\/v1\/chat\/?$/, "")
        .replace(/\/chat\/completions\/?$/, "")
        .replace(/\/$/, "");
    }
  }

  private _getChatApiKind(endpoint = this._getEndpoint()): ChatApiKind {
    try {
      const url = new URL(endpoint);
      const pathname = url.pathname.replace(/\/+$/, "");
      if (pathname.endsWith("/api/chat")) {
        return "ollama";
      }
      // Treat explicit /v1/chat endpoints as OpenAI-compatible chat API
      if (pathname.endsWith("/v1/chat") || pathname.endsWith("/v1/chat/completions") || pathname.endsWith("/chat/completions")) {
        return "openai";
      }
    } catch {
      if (endpoint.replace(/\/+$/, "").endsWith("/api/chat")) {
        return "ollama";
      }
    }

    return "openai";
  }

  private _getRequestHeaders(apiKind: ChatApiKind): Record<string, string> {
    if (apiKind === "ollama") {
      return {
        "Content-Type": "application/json",
      };
    }

    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer ollama",
    };
  }

  private _buildChatPayload(apiKind: ChatApiKind, model: string, messages: Message[], temperature: number, stream: boolean): Record<string, unknown> {
    if (apiKind === "ollama") {
      const chatFormat = this._getOllamaChatFormat();
      return {
        model,
        messages,
        stream,
        ...(chatFormat === "peg-native" ? { format: "peg-native" } : {}),
        options: {
          temperature,
        },
      };
    }

    return {
      model,
      messages,
      temperature,
      stream,
    };
  }

  private _normalizeContent(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    if (Array.isArray(value)) {
      return value
        .map((item) => this._normalizeContent(item))
        .filter(Boolean)
        .join("");
    }

    if (!value || typeof value !== "object") {
      return "";
    }

    const record = value as Record<string, unknown>;

    if (typeof record.text === "string") {
      return record.text;
    }

    if (typeof record.content === "string") {
      return record.content;
    }

    if (Array.isArray(record.content)) {
      return this._normalizeContent(record.content);
    }

    if (typeof record.response === "string") {
      return record.response;
    }

    if (typeof record.output_text === "string") {
      return record.output_text;
    }

    return "";
  }

  private _extractChatContent(apiKind: ChatApiKind, data: unknown): string {
    const payload = (data && typeof data === "object") ? data as Record<string, unknown> : {};

    const apiSpecificCandidates = apiKind === "ollama"
      ? [
          (payload.message as Record<string, unknown> | undefined)?.content,
          payload.response,
        ]
      : [
          ((payload.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content,
          ((payload.choices as Array<Record<string, unknown>> | undefined)?.[0]?.delta as Record<string, unknown> | undefined)?.content,
          (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]?.text,
        ];

    const genericCandidates = [
      payload.content,
      payload.text,
      payload.response,
      payload.output_text,
      ((payload.message as Record<string, unknown> | undefined)?.delta as Record<string, unknown> | undefined)?.content,
      ((payload.delta as Record<string, unknown> | undefined)?.content),
      ((payload.output as Array<Record<string, unknown>> | undefined)?.[0]?.content),
      (((payload.output as Array<Record<string, unknown>> | undefined)?.[0]?.content as Array<Record<string, unknown>> | undefined)?.map((item) => item.text).join("")),
      (((payload.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content),
    ];

    for (const candidate of [...apiSpecificCandidates, ...genericCandidates]) {
      const content = this._normalizeContent(candidate).trim();
      if (content) {
        return content;
      }
    }

    return "";
  }

  private _extractStreamContentFromRawBody(apiKind: ChatApiKind, rawBody: string): string {
    const trimmed = rawBody.trim();
    if (!trimmed) {
      return "";
    }

    const candidateLines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line !== "data: [DONE]")
      .map((line) => line.startsWith("data: ") ? line.slice(6) : line);

    for (const candidate of [trimmed, ...candidateLines]) {
      try {
        const parsed = JSON.parse(candidate);
        const content = this._extractChatContent(apiKind, parsed);
        if (content) {
          return content;
        }
      } catch {
        // Keep trying other candidate payload shapes.
      }
    }

    return "";
  }

  private _isStreamingResponseContentType(contentType: string | null): boolean {
    const normalized = (contentType || "").toLowerCase();
    return normalized.includes("text/event-stream")
      || normalized.includes("application/x-ndjson")
      || normalized.includes("application/ndjson")
      || normalized.includes("application/jsonl")
      || normalized.includes("application/x-jsonlines")
      || normalized.includes("application/stream+json");
  }

  private _parseChatResponseBody(apiKind: ChatApiKind, endpoint: string, rawBody: string, logPrefix: string): string {
    let data: unknown;

    try {
      data = JSON.parse(rawBody);
    } catch {
      const plainTextReply = rawBody.trim();
      if (plainTextReply) {
        this._log(`${logPrefix} server returned non-JSON body; treating it as plain text response`);
        this._log(`${logPrefix} ← response (${plainTextReply.length} chars): ${plainTextReply.slice(0, 200)}${plainTextReply.length > 200 ? '…' : ''}`);
        return plainTextReply;
      }

      throw new Error(`The server at "${endpoint}" returned an empty response body.`);
    }

    const reply = this._extractChatContent(apiKind, data) || this._extractStreamContentFromRawBody(apiKind, rawBody);
    if (!reply) {
      this._log(`${logPrefix} raw response body with no extracted content:\n${rawBody}`);
      throw new Error(`The server at "${endpoint}" returned a chat response without content.`);
    }

    this._log(`${logPrefix} ← response (${reply.length} chars): ${reply.slice(0, 200)}${reply.length > 200 ? '…' : ''}`);
    try {
      this._log(`${logPrefix} ← full response:\n${reply}`);
    } catch {
      this._log(`${logPrefix} ← full response: (unserializable)`);
    }

    return reply;
  }

  private _getOpenAiBaseUrl(): string {
    const endpoint = this._getEndpoint();

    try {
      const url = new URL(endpoint);
      let pathname = url.pathname.replace(/\/+$/, "");

      if (pathname.endsWith("/chat/completions")) {
        pathname = pathname.slice(0, -"/chat/completions".length);
      } else if (pathname.endsWith("/v1/chat")) {
        // /v1/chat should map back to the /v1 base so /models resolves correctly
        pathname = pathname.slice(0, -"/v1/chat".length);
      } else if (pathname.endsWith("/completions")) {
        pathname = pathname.slice(0, -"/completions".length);
      }

      url.pathname = pathname || "/";
      url.search = "";
      url.hash = "";

      return url.toString().replace(/\/$/, "");
    } catch {
      return endpoint
        .replace(/\/chat\/completions\/?$/, "")
        .replace(/\/v1\/chat\/?$/, "")
        .replace(/\/completions\/?$/, "")
        .replace(/\/$/, "");
    }
  }

  private _toFallbackModel(name: string): OllamaModel {
    return {
      name,
      modified_at: new Date(0).toISOString(),
      size: 0,
    };
  }

  private async _fetchOllamaModels(tagsUrl: string): Promise<OllamaModel[] | null> {
    const response = await fetch(tagsUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as { models?: OllamaModel[] };
    return data.models || [];
  }

  private async _fetchOpenAiModels(modelsUrl: string): Promise<OllamaModel[] | null> {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer ollama",
      },
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible server returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as OpenAiModelsResponse;
    return (data.data || []).map((model) => ({
      name: model.id,
      modified_at: model.created ? new Date(model.created * 1000).toISOString() : new Date(0).toISOString(),
      size: 0,
    }));
  }

  private async _resolveModelName(selectedModel?: string): Promise<string> {
    if (selectedModel) {
      return selectedModel;
    }

    const configuredModel = this._getConfiguredModel();
    if (configuredModel) {
      this._log(`[models] using configured model fallback: ${configuredModel}`);
      return configuredModel;
    }

    const models = await this.listModels();
    const resolvedModel = models[0]?.name;
    if (!resolvedModel) {
      throw new Error("No Ollama models found. Pull a model in Ollama and refresh the extension.");
    }

    this._log(`[models] resolved default model from Ollama: ${resolvedModel}`);
    return resolvedModel;
  }

  /**
   * Fetch available models from Ollama.
   */
  async listModels(): Promise<OllamaModel[]> {
    const ollamaBaseUrl = this._getOllamaBaseUrl();
    const openAiBaseUrl = this._getOpenAiBaseUrl();
    const tagsUrl = `${ollamaBaseUrl}/api/tags`;
    const modelsUrl = `${openAiBaseUrl}/models`;
    const errors: string[] = [];

    const apiKind = this._getChatApiKind();

    // If the configured endpoint looks like an OpenAI-style API (starts with /v1),
    // prefer the OpenAI-compatible discovery flow first to avoid 404 noise from
    // Ollama-native endpoints.
    if (apiKind === "openai") {
      try {
        const models = await this._fetchOpenAiModels(modelsUrl);
        this._log(`[models] discovered ${(models || []).length} model(s) via ${modelsUrl}`);
        if (models && models.length > 0) {
          return models;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`GET ${modelsUrl} failed: ${message}`);
        this._log(`[models] ${errors[errors.length - 1]}`);
      }

      try {
        const models = await this._fetchOllamaModels(tagsUrl);
        this._log(`[models] discovered ${(models || []).length} model(s) via ${tagsUrl}`);
        if (models && models.length > 0) {
          return models;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`GET ${tagsUrl} failed: ${message}`);
        this._log(`[models] ${errors[errors.length - 1]}`);
      }
    } else {
      try {
        const models = await this._fetchOllamaModels(tagsUrl);
        this._log(`[models] discovered ${(models || []).length} model(s) via ${tagsUrl}`);
        if (models && models.length > 0) {
          return models;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`GET ${tagsUrl} failed: ${message}`);
        this._log(`[models] ${errors[errors.length - 1]}`);
      }

      try {
        const models = await this._fetchOpenAiModels(modelsUrl);
        this._log(`[models] discovered ${(models || []).length} model(s) via ${modelsUrl}`);
        if (models && models.length > 0) {
          return models;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`GET ${modelsUrl} failed: ${message}`);
        this._log(`[models] ${errors[errors.length - 1]}`);
      }
    }

    const configuredModel = this._getConfiguredModel();
    if (configuredModel) {
      this._log(`[models] falling back to configured model because discovery failed: ${configuredModel}`);
      return [this._toFallbackModel(configuredModel)];
    }

    throw new Error(
      `Failed to discover models for endpoint "${this._getEndpoint()}". Tried Ollama tags at "${tagsUrl}" and OpenAI models at "${modelsUrl}". Configure ollamaAgent.model to bypass discovery if your server does not expose a model list.\n${errors.join("\n")}`
    );
  }

  /**
   * Fetch detailed metadata for a single model via Ollama's /api/show endpoint.
   * The caller can use returned fields like `context_window` to determine token limits.
   */
  async getModelInfo(name: string): Promise<any> {
    const baseUrl = this._getOllamaBaseUrl();
    const showUrl = `${baseUrl}/api/show`;

    this._log(`[api/show] → POST ${showUrl} name=${name}`);
    try {
      const response = await fetch(showUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        const body = await response.text();
        this._log(`[api/show] ← HTTP ${response.status}: ${body}`);
        throw new Error(`Ollama returned HTTP ${response.status}: ${body}`);
      }

      const data: any = await response.json();
      // Log just the model_info portion if present, otherwise the full response
      const summary = data.model_info ? JSON.stringify(data.model_info) : JSON.stringify(data).slice(0, 500);
      this._log(`[api/show] ← OK  model_info: ${summary}`);
      return data;
    } catch (err) {
      this._log(`[api/show] ← ERROR: ${err}`);
      throw new Error(`Failed to fetch model info from "${showUrl}": ${err}`);
    }
  }

  async chat(messages: Message[], selectedModel?: string, abortSignal?: AbortSignal): Promise<string> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const endpoint = this._getEndpoint();
    const apiKind = this._getChatApiKind(endpoint);
    const model = await this._resolveModelName(selectedModel);
    const temperature = config.get<number>("temperature", 0.2);
    const requestTimeoutMs = this._getRequestTimeoutMs();
    const payload = this._buildChatPayload(apiKind, model, messages, temperature, false);

    this._log(`[llm/chat] → POST ${endpoint}  api=${apiKind}  model=${model}  messages=${messages.length}  temp=${temperature}`);

    // Always log the full payload being sent to the LLM for auditing/debugging
    try {
      this._log(`[llm/chat] payload: ${JSON.stringify(payload, null, 2)}`);
    } catch {
      this._log(`[llm/chat] payload: (unserializable payload)`);
    }

    if (abortSignal?.aborted) {
      throw new Error("Operation cancelled by user.");
    }

    const requestController = this._createRequestSignal(requestTimeoutMs, abortSignal);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: this._getRequestHeaders(apiKind),
        body: JSON.stringify(payload),
        signal: requestController.signal,
      });
    } catch (err) {
      requestController.dispose();
      if (abortSignal?.aborted) {
        throw new Error("Operation cancelled by user.");
      }
      if (requestController.didTimeout()) {
        throw new Error(
          `The request to "${endpoint}" did not finish within ${requestTimeoutMs} ms.`
        );
      }
      throw new Error(
        `Failed to reach Ollama at "${endpoint}". Is Ollama running?\n${err}`
      );
    }

    if (!response.ok) {
      requestController.dispose();
      const body = await response.text();
      throw new Error(
        `Ollama returned HTTP ${response.status}: ${body}`
      );
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (err) {
      if (abortSignal?.aborted) {
        throw new Error("Operation cancelled by user.");
      }
      if (requestController.didTimeout()) {
        throw new Error(
          `The response from "${endpoint}" did not complete within ${requestTimeoutMs} ms.`
        );
      }
      throw err;
    } finally {
      requestController.dispose();
    }

    return this._parseChatResponseBody(apiKind, endpoint, rawBody, "[llm/chat]");
  }

  /**
   * Streaming chat completion. Calls onChunk for each token received.
   * Returns the full accumulated response.
   */
  async chatStream(messages: Message[], onChunk: (chunk: string) => void, selectedModel?: string, abortSignal?: AbortSignal): Promise<string> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const endpoint = this._getEndpoint();
    const apiKind = this._getChatApiKind(endpoint);
    const model = await this._resolveModelName(selectedModel);
    const temperature = config.get<number>("temperature", 0.2);
    const useStreaming = this._shouldUseStreaming();
    const requestTimeoutMs = this._getRequestTimeoutMs();
    const payload = this._buildChatPayload(apiKind, model, messages, temperature, true);

    if (!useStreaming) {
      this._log("[llm/stream] streaming disabled by configuration; using non-streaming chat request");
      return this.chat(messages, selectedModel, abortSignal);
    }

    if (this._hasStreamingOverride(endpoint)) {
      this._log(`[llm/stream] streaming disabled for ${endpoint}; using cached non-streaming compatibility mode`);
      return this.chat(messages, selectedModel, abortSignal);
    }

    this._log(`[llm/stream] → POST ${endpoint}  api=${apiKind}  model=${model}  messages=${messages.length}  temp=${temperature}`);

    // Always log the full payload being sent to the LLM for auditing/debugging
    try {
      this._log(`[llm/stream] payload: ${JSON.stringify(payload, null, 2)}`);
    } catch {
      this._log(`[llm/stream] payload: (unserializable payload)`);
    }

    if (abortSignal?.aborted) {
      throw new Error("Operation cancelled by user.");
    }

    const requestController = this._createRequestSignal(requestTimeoutMs, abortSignal);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: this._getRequestHeaders(apiKind),
        body: JSON.stringify(payload),
        signal: requestController.signal,
      });
    } catch (err) {
      requestController.dispose();
      if (abortSignal?.aborted) {
        throw new Error("Operation cancelled by user.");
      }
      if (requestController.didTimeout()) {
        throw new Error(
          `The request to "${endpoint}" did not start streaming within ${requestTimeoutMs} ms.`
        );
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

    const contentType = response.headers.get("content-type");
    const transferEncoding = response.headers.get("transfer-encoding");
    const contentLength = response.headers.get("content-length");
    this._log(
      `[llm/stream] ← HTTP ${response.status} content-type=${contentType ?? "(none)"} transfer-encoding=${transferEncoding ?? "(none)"} content-length=${contentLength ?? "(none)"}`
    );

    if (!this._isStreamingResponseContentType(contentType)) {
      this._markEndpointAsNonStreaming(endpoint, `server replied with content-type ${contentType ?? "(none)"}`);
      this._log("[llm/stream] response is not a streaming media type; reading full body as buffered JSON/text");
      try {
        const rawBody = await response.text();
        const reply = this._parseChatResponseBody(apiKind, endpoint, rawBody, "[llm/stream]");
        if (reply) {
          onChunk(reply);
        }
        return reply;
      } finally {
        requestController.dispose();
      }
    }

    if (!response.body) {
      requestController.dispose();
      throw new Error("Response body is null");
    }

    requestController.dispose();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let buffer = "";
    let rawBody = "";
    let streamComplete = false;
    let stalled = false;
    const stallTimeoutMs = this._getStreamingStallTimeoutMs();

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") {
        return;
      }

      const jsonStr = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
      if (!jsonStr) {
        return;
      }

      const parsed = JSON.parse(jsonStr) as {
        message?: { content?: string };
        done?: boolean;
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      };

      const content = apiKind === "ollama"
        ? parsed.message?.content
        : parsed.choices?.[0]?.delta?.content;

      if (content) {
        fullContent += content;
        onChunk(content);
      }

      if ((apiKind === "ollama" && parsed.done) || parsed.choices?.[0]?.finish_reason === "stop") {
        streamComplete = true;
      }
    };

    try {
      while (!streamComplete) {
        if (abortSignal?.aborted) {
          void reader.cancel();
          throw new Error("Operation cancelled by user.");
        }

        const readResult = await new Promise<
          | { kind: "read"; done: boolean; value?: Uint8Array }
          | { kind: "abort" }
          | { kind: "timeout" }
        >((resolve, reject) => {
          let settled = false;
          let timeoutHandle: NodeJS.Timeout | undefined;
          let abortHandler: (() => void) | undefined;

          const finish = (
            result:
              | { kind: "read"; done: boolean; value?: Uint8Array }
              | { kind: "abort" }
              | { kind: "timeout" }
          ) => {
            if (settled) {
              return;
            }
            settled = true;
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
            if (abortHandler) {
              abortSignal?.removeEventListener("abort", abortHandler);
            }
            resolve(result);
          };

          if (abortSignal) {
            abortHandler = () => finish({ kind: "abort" });
            abortSignal.addEventListener("abort", abortHandler, { once: true });
          }

          if (stallTimeoutMs > 0) {
            timeoutHandle = setTimeout(() => finish({ kind: "timeout" }), stallTimeoutMs);
          }

          reader.read().then(
            ({ done, value }) => finish({ kind: "read", done, value }),
            (err) => {
              if (timeoutHandle) {
                clearTimeout(timeoutHandle);
              }
              if (abortHandler) {
                abortSignal?.removeEventListener("abort", abortHandler);
              }
              reject(err);
            }
          );
        });

        if (readResult.kind === "abort") {
          void reader.cancel();
          throw new Error("Operation cancelled by user.");
        }

        if (readResult.kind === "timeout") {
          stalled = true;
          this._log(`[llm/stream] no stream activity for ${stallTimeoutMs} ms; cancelling streaming response`);
          try {
            await reader.cancel();
          } catch {
            // The stream may already be closed by the server.
          }
          break;
        }

        const { done, value } = readResult;
        if (done) {
          break;
        }

        const decodedChunk = decoder.decode(value, { stream: true });
        rawBody += decodedChunk;
        buffer += decodedChunk;

        const trimmedBuffer = buffer.trim();
        if (!fullContent && trimmedBuffer.startsWith("{") && trimmedBuffer.endsWith("}")) {
          const recoveredContent = this._extractStreamContentFromRawBody(apiKind, trimmedBuffer);
          if (recoveredContent) {
            fullContent = recoveredContent;
            onChunk(recoveredContent);
            streamComplete = true;
            buffer = "";
            break;
          }
        }

        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          try {
            processLine(line);
            if (streamComplete) {
              break;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      const trailing = buffer + decoder.decode();
      rawBody += trailing;
      if (trailing.trim()) {
        try {
          processLine(trailing);
        } catch {
          this._log(`[llm/stream] trailing buffer was not parseable JSON: ${trailing.slice(0, 200)}${trailing.length > 200 ? '…' : ''}`);
        }
      }

      if (!fullContent) {
        const recoveredContent = this._extractStreamContentFromRawBody(apiKind, rawBody);
        if (recoveredContent) {
          fullContent = recoveredContent;
          this._log(`[llm/stream] recovered ${recoveredContent.length} chars from raw response body`);
        }
      }

      if (stalled && !streamComplete) {
        const trimmedBody = rawBody.trim();
        const looksLikeCompleteJson = trimmedBody.startsWith("{") && trimmedBody.endsWith("}");
        this._markEndpointAsNonStreaming(endpoint, `stream stalled after ${stallTimeoutMs} ms`);
        if (!(looksLikeCompleteJson && fullContent)) {
          throw new StreamingStalledError(
            `Streaming response from "${endpoint}" produced no terminating chunk within ${stallTimeoutMs} ms.`
          );
        }
      }

      if (streamComplete) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be closed by the server.
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        throw new Error("Operation cancelled by user.");
      }
      throw err;
    }

    this._log(`[llm/stream] ← done (${fullContent.length} chars): ${fullContent.slice(0, 200)}${fullContent.length > 200 ? '…' : ''}`);
    // Also log the full streamed response content
    try {
      this._log(`[llm/stream] ← full response (${fullContent.length} chars):\n${fullContent}`);
    } catch {
      this._log(`[llm/stream] ← full response: (unserializable)`);
    }
    return fullContent;
  }
}
