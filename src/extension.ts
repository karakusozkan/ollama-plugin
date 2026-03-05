import * as vscode from "vscode";
import { Agent } from "./agent/agent";
import { OllamaProvider, estimateMessagesTokens, OllamaModel } from "./agent/llm";
import { McpManager } from "./agent/mcp";
import { listWorkspaceFiles } from "./utils/workspace";

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem | undefined;
let mcpManager: McpManager;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Ollama Agent");
  context.subscriptions.push(outputChannel);

  const provider = new OllamaProvider();
  const agent = new Agent(provider);

  // ── Initialize MCP Manager ──────────────────────────────────────────────────
  mcpManager = new McpManager();
  mcpManager.outputChannel = outputChannel;
  agent.mcpManager = mcpManager;

  // Connect to configured MCP servers on activation
  mcpManager.loadFromSettings().then(() => {
    if (mcpManager.connectedCount > 0) {
      outputChannel.appendLine(`✅ ${mcpManager.connectedCount} MCP server(s) connected.`);
    }
  }).catch(err => {
    outputChannel.appendLine(`❌ MCP initialization error: ${err}`);
  });

  // Re-connect MCP servers when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("ollamaAgent.mcpServers")) {
        outputChannel.appendLine("MCP server configuration changed — reconnecting…");
        mcpManager.loadFromSettings().then(() => {
          outputChannel.appendLine(`✅ ${mcpManager.connectedCount} MCP server(s) connected after config change.`);
        }).catch(err => {
          outputChannel.appendLine(`❌ MCP reconnection error: ${err}`);
        });
      }
    })
  );

  // Clean up MCP connections on deactivation
  context.subscriptions.push({
    dispose: () => {
      mcpManager.disconnectAll();
    }
  });

  // ── ollamaAgent.run ───────────────────────────────────────────────────────
  const runCommand = vscode.commands.registerCommand(
    "ollamaAgent.run",
    async () => {
      const goal = await vscode.window.showInputBox({
        prompt: "What should the agent do?",
        placeHolder: "e.g. Add a utility function that formats dates in ISO-8601",
        ignoreFocusOut: true,
      });

      if (!goal) {
        return;
      }

      outputChannel.show(true);
      outputChannel.appendLine("═".repeat(60));
      outputChannel.appendLine(`🚀  Goal: ${goal}`);
      outputChannel.appendLine("═".repeat(60));

      // Optionally inject workspace file list into the goal for context
      const files = await listWorkspaceFiles(150);
      const contextNote =
        files.length > 0
          ? `\n\nExisting workspace files:\n${files.map((f) => `  ${f}`).join("\n")}`
          : "";

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Ollama Agent is working…",
          cancellable: false,
        },
        async () => {
          try {
            await agent.run(goal + contextNote, outputChannel);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            outputChannel.appendLine(`\n💥 Fatal error: ${msg}`);
            vscode.window.showErrorMessage(`Ollama Agent error: ${msg}`);
          }
        }
      );
    }
  );

  context.subscriptions.push(runCommand);

  // ── Register the sidebar webview view provider ─────────────────────────────
  const chatViewProvider = new OllamaChatViewProvider(context.extensionUri, provider, mcpManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "ollamaAgent.chatView",
      chatViewProvider,
      {
        webviewOptions: { retainContextWhenHidden: true }
      }
    )
  );

  // ── ollamaAgent.openChat ─────────────────────────────────────────────────
  const openChatCommand = vscode.commands.registerCommand(
    "ollamaAgent.openChat",
    async () => {
      await vscode.commands.executeCommand("workbench.view.extension.ollama-agent-sidebar");
    }
  );
  context.subscriptions.push(openChatCommand);

  // Status bar item to toggle the chat
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "ollamaAgent.openChat";
  statusBarItem.text = "$(comment-discussion) Ollama Chat";
  statusBarItem.tooltip = "Open Ollama chat";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

export function deactivate(): void {
  // Nothing to clean up; subscriptions handle it
}

// ── WebviewViewProvider for sidebar chat ─────────────────────────────────────
class OllamaChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _extensionUri: vscode.Uri;
  private _provider: OllamaProvider;
  private _mcpManager: McpManager;
  private _history: import("./agent/llm").Message[] = [];
  private _initialized = false;
  private _abortController: AbortController | null = null;
  private _selectedModel: string | null = null;
  private _availableModels: OllamaModel[] = [];

  constructor(extensionUri: vscode.Uri, provider: OllamaProvider, mcpManager: McpManager) {
    this._extensionUri = extensionUri;
    this._provider = provider;
    this._mcpManager = mcpManager;
  }

  private _getContextWindowSize(): number {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    return config.get<number>("contextWindowSize", 32768);
  }

  private _updateContextDisplay(): void {
    const usedTokens = estimateMessagesTokens(this._history);
    const maxTokens = this._getContextWindowSize();
    const remaining = Math.max(0, maxTokens - usedTokens);
    this._view?.webview.postMessage({ 
      type: "updateContext", 
      used: usedTokens, 
      max: maxTokens,
      remaining 
    });
  }

  private async _fetchAndSendModels(): Promise<void> {
    try {
      this._availableModels = await this._provider.listModels();
      const modelNames = this._availableModels.map(m => m.name);
      this._view?.webview.postMessage({ 
        type: "updateModels", 
        models: modelNames,
        selectedModel: this._selectedModel
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outputChannel.appendLine(`Failed to fetch models: ${message}`);
      this._view?.webview.postMessage({ 
        type: "updateModels", 
        models: [],
        error: message
      });
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getWebviewContent();

    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; text?: string; model?: string }) => {
      if (msg.type === "stopAgent") {
        if (this._abortController) {
          this._abortController.abort();
        }
        return;
      }
      if (msg.type === "newSession") {
        this._history = [];
        this._initialized = false;
        if (this._abortController) {
          this._abortController.abort();
        }
        this._abortController = null;
        this._view?.webview.postMessage({ type: "clearMessages" });
        this._updateContextDisplay();
        return;
      }
      if (msg.type === "selectModel") {
        this._selectedModel = msg.model || null;
        return;
      }
      if (msg.type === "refreshModels") {
        await this._fetchAndSendModels();
        return;
      }
      if (msg.type !== "sendMessage" || !msg.text) { return; }

      // Create a new AbortController for this session
      this._abortController = new AbortController();
      const abortSignal = this._abortController.signal;
      
      const userText: string = msg.text;
      this._view?.webview.postMessage({ type: "append", role: "user", text: userText });
      this._view?.webview.postMessage({ type: "setLoading", loading: true });

      try {
        // ── One-time initialisation: inject system prompt + workspace files ──
        if (!this._initialized) {
          const files = await listWorkspaceFiles(200);
          const fileList = files.length > 0
            ? `\n\nWorkspace files you have access to:\n${files.map(f => `  ${f}`).join("\n")}`
            : "\n\n(No workspace folder is open.)";

          const { buildSystemPrompt } = await import("./agent/tools.js");
          this._history.push({ role: "system", content: buildSystemPrompt(this._mcpManager) + fileList });
          this._initialized = true;
          this._updateContextDisplay();
        }

        this._history.push({ role: "user", content: userText });

        // ── Agentic loop: keep calling the LLM until it returns empty actions ──
        const MAX_ITERATIONS = 8;
        let displayText = "";

        const { executeActions } = await import("./agent/executor.js");

        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
          if (abortSignal.aborted) {
            this._view?.webview.postMessage({ type: "append", role: "assistant", text: "⏹ Stopped by user." });
            break;
          }

          // Use streaming to get the response, but only show thought (not raw JSON)
          let raw = "";
          this._view?.webview.postMessage({ type: "setThinking", thinking: true });
          
          try {
            raw = await this._provider.chatStream(this._history, (_chunk) => {
              // Accumulate chunks silently — we'll display only the thought after parsing
            }, this._selectedModel || undefined, abortSignal);
          } catch (streamErr) {
            if (abortSignal.aborted) {
              this._view?.webview.postMessage({ type: "setThinking", thinking: false });
              this._view?.webview.postMessage({ type: "append", role: "assistant", text: "⏹ Stopped by user." });
              break;
            }
            // Fallback to non-streaming if streaming fails
            raw = await this._provider.chat(this._history, this._selectedModel || undefined, abortSignal);
          }
          
          this._view?.webview.postMessage({ type: "setThinking", thinking: false });

          if (abortSignal.aborted) {
            this._view?.webview.postMessage({ type: "append", role: "assistant", text: "⏹ Stopped by user." });
            break;
          }
          
          this._history.push({ role: "assistant", content: raw });
          this._updateContextDisplay();

          // Try to parse as an agent JSON response
          let parsed: { thought?: string; actions?: import("./agent/tools.js").ToolAction[] };
          try {
            // Try to extract JSON from the response - handle models that wrap JSON in text
            let jsonStr = raw;
            
            // First, try to find JSON within markdown code blocks
            const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (codeBlockMatch) {
              jsonStr = codeBlockMatch[1].trim();
            } else {
              // Try to find a JSON object in the response
              const jsonMatch = raw.match(/\{[\s\S]*"thought"[\s\S]*"actions"[\s\S]*\}/);
              if (jsonMatch) {
                jsonStr = jsonMatch[0];
              } else {
                // Try to find any JSON object
                const anyJsonMatch = raw.match(/\{[\s\S]*\}/);
                if (anyJsonMatch) {
                  jsonStr = anyJsonMatch[0];
                }
              }
            }
            
            parsed = JSON.parse(jsonStr);
          } catch {
            // LLM returned plain text (not JSON) — show as-is and stop
            displayText = raw;
            break;
          }

          displayText = parsed.thought ?? raw;

          const actions = parsed.actions ?? [];

          // Agent signals completion with an empty actions array
          if (actions.length === 0) {
            // Show the thought as the final answer
            this._view?.webview.postMessage({ type: "append", role: "assistant", text: displayText });
            break;
          }

          if (abortSignal.aborted) {
            this._view?.webview.postMessage({ type: "append", role: "assistant", text: "⏹ Stopped by user." });
            break;
          }

          // Execute the requested actions
          const results = await executeActions(actions, abortSignal, this._mcpManager);

          // Log to output channel
          outputChannel.appendLine(`\n── Chat iteration ${iteration + 1} ──────────────────────`);
          outputChannel.appendLine(`💭 ${displayText}`);

          const summaryLines: string[] = [];
          const feedbackLines: string[] = [];

          for (const r of results) {
            const loc = "path" in r.action
              ? r.action.path
              : "command" in r.action
              ? (r.action as { command: string }).command
              : "url" in r.action
              ? (r.action as { url: string }).url
              : r.action.tool === "mcp_tool"
              ? `${(r.action as { server: string; name: string }).server}/${(r.action as { server: string; name: string }).name}`
              : "";
            const icon = r.success ? "✅" : "❌";
            summaryLines.push(`${icon} \`${r.action.tool}\`${loc ? ` → ${loc}` : ""}`);
            outputChannel.appendLine(`  ${icon} ${r.action.tool}${loc ? ` → ${loc}` : ""}`);
            if (r.output && (r.action.tool === "run_command" || r.action.tool === "fetch_url" || r.action.tool === "mcp_tool" || !r.success)) {
              const indented = r.output.split("\n").map((l: string) => `     ${l}`).join("\n");
              outputChannel.appendLine(indented);
            }
            feedbackLines.push(
              `${icon} ${r.action.tool}${loc ? ` → ${loc}` : ""}` +
              (r.output ? `\n${r.output.slice(0, 20000)}` : "")
            );
          }

          // Show thought + action summary as an intermediate message
          const intermediateText = `${displayText}\n\n${summaryLines.join("\n")}`;
          this._view?.webview.postMessage({ type: "append", role: "assistant", text: intermediateText });

          // Feed execution results (including read_file content) back to the LLM
          this._history.push({ role: "user", content: `Tool execution results:\n\n${feedbackLines.join("\n\n")}` });
          this._updateContextDisplay();
        }
      } catch (err) {
        if (abortSignal.aborted) {
          this._view?.webview.postMessage({ type: "append", role: "assistant", text: "⏹ Stopped by user." });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this._view?.webview.postMessage({ type: "append", role: "assistant", text: `❌ Error: ${message}` });
        }
      } finally {
        this._abortController = null;
        this._view?.webview.postMessage({ type: "setLoading", loading: false });
      }
    });
  }

  private _getWebviewContent(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
    }
    body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); }
    #messages { flex: 1; padding: 12px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
    .msg { padding: 10px; border-radius: 6px; max-width: 90%; white-space: pre-wrap; font-size: 13px; line-height: 1.5; }
    .user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; }
    .assistant { background: var(--vscode-editor-inactiveSelectionBackground, #3a3d41); color: var(--vscode-editor-foreground, #cccccc); align-self: flex-start; border: 1px solid var(--vscode-widget-border, #454545); }
    #bar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--vscode-widget-border); }
    #input { flex: 1; padding: 8px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    button { padding: 8px 16px; border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #stop { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-inputValidation-errorForeground, #f48771); display: none; }
    #stop:not(:disabled) { cursor: pointer; }
    #toolbar { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px 0; }
    #new-session { font-size: 12px; padding: 4px 10px; opacity: 0.8; }
    #new-session:hover { opacity: 1; }
    #context-info { font-size: 12px; color: var(--vscode-foreground, #cccccc); font-family: monospace; background: var(--vscode-input-background, #3c3c3c); padding: 4px 8px; border-radius: 4px; }
    #context-bar { width: 60px; height: 4px; background: var(--vscode-progressBar-background, #0e70c0); border-radius: 2px; margin-left: 6px; }
    #context-container { display: flex; align-items: center; }
    #loading { display: none; padding: 8px 12px; font-size: 13px; color: var(--vscode-foreground, #cccccc); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .thinking { animation: pulse 1.5s ease-in-out infinite; }
    #model-bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-widget-border); }
    #model-select { flex: 1; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-size: 12px; }
    #refresh-models { padding: 4px 8px; font-size: 12px; opacity: 0.8; }
    #refresh-models:hover { opacity: 1; }
    #model-label { font-size: 12px; opacity: 0.8; }
  </style>
</head>
<body>
  <div id="model-bar">
    <span id="model-label">Model:</span>
    <select id="model-select" title="Select a model">
      <option value="">Loading models...</option>
    </select>
    <button id="refresh-models" title="Refresh model list">↻</button>
  </div>
  <div id="toolbar">
    <div id="context-container">
      <span id="context-info" title="Context window usage">Context: 0 / 32768</span>
    </div>
    <button id="new-session" title="Start a new session (clears history)">＋ New Session</button>
  </div>
  <div id="messages"></div>
  <div id="loading"><span class="thinking">Ollama is thinking...</span></div>
  <div id="bar">
    <input id="input" placeholder="Ask Ollama..."/>
    <button id="send">Send</button>
    <button id="stop" title="Stop the agent">⏹ Stop</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const stop = document.getElementById('stop');
    const newSession = document.getElementById('new-session');
    const loading = document.getElementById('loading');
    const contextInfo = document.getElementById('context-info');
    const modelSelect = document.getElementById('model-select');
    const refreshModels = document.getElementById('refresh-models');

    function formatTokens(n) {
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return n.toString();
    }

    function append(role, text) {
      const el = document.createElement('div');
      el.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
      el.textContent = text;
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
      return el;
    }

    send.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      vscode.postMessage({ type: 'sendMessage', text });
    });

    stop.addEventListener('click', () => {
      vscode.postMessage({ type: 'stopAgent' });
      stop.disabled = true;
    });

    newSession.addEventListener('click', () => {
      vscode.postMessage({ type: 'newSession' });
    });

    refreshModels.addEventListener('click', () => {
      modelSelect.innerHTML = '<option value="">Loading models...</option>';
      vscode.postMessage({ type: 'refreshModels' });
    });

    modelSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectModel', model: modelSelect.value });
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send.click();
      }
    });

    // Request models on load
    vscode.postMessage({ type: 'refreshModels' });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'append') {
        append(msg.role, msg.text);
      } else if (msg.type === 'setThinking') {
        // Show/hide a "thinking" indicator while the LLM is generating
        const existingThinking = document.getElementById('thinking-indicator');
        if (msg.thinking) {
          if (!existingThinking) {
            const el = document.createElement('div');
            el.id = 'thinking-indicator';
            el.className = 'msg assistant thinking';
            el.textContent = '⏳ Thinking...';
            messages.appendChild(el);
            messages.scrollTop = messages.scrollHeight;
          }
        } else {
          if (existingThinking) {
            existingThinking.remove();
          }
        }
      } else if (msg.type === 'clearMessages') {
        messages.innerHTML = '';
        input.focus();
      } else if (msg.type === 'setLoading') {
        loading.style.display = msg.loading ? 'block' : 'none';
        input.disabled = msg.loading;
        send.disabled = msg.loading;
        newSession.disabled = msg.loading;
        modelSelect.disabled = msg.loading;
        refreshModels.disabled = msg.loading;
        stop.style.display = msg.loading ? 'inline-block' : 'none';
        stop.disabled = false;
        if (!msg.loading) input.focus();
      } else if (msg.type === 'updateContext') {
        const used = formatTokens(msg.used);
        const max = formatTokens(msg.max);
        const remaining = formatTokens(msg.remaining);
        const percent = Math.round((msg.used / msg.max) * 100);
        contextInfo.textContent = 'Context: ' + used + '/' + max + ' (' + percent + '% used, ' + remaining + ' left)';
        contextInfo.title = 'Used: ' + msg.used + ' tokens\\nMax: ' + msg.max + ' tokens\\nRemaining: ' + msg.remaining + ' tokens';
      } else if (msg.type === 'updateModels') {
        modelSelect.innerHTML = '';
        if (msg.models && msg.models.length > 0) {
          msg.models.forEach(function(modelName) {
            const option = document.createElement('option');
            option.value = modelName;
            option.textContent = modelName;
            if (msg.selectedModel && modelName === msg.selectedModel) {
              option.selected = true;
            }
            modelSelect.appendChild(option);
          });
          // If no model was pre-selected, select the first one
          if (!msg.selectedModel && msg.models.length > 0) {
            modelSelect.value = msg.models[0];
            vscode.postMessage({ type: 'selectModel', model: msg.models[0] });
          }
        } else if (msg.error) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = 'Error: ' + msg.error;
          modelSelect.appendChild(option);
        } else {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = 'No models found';
          modelSelect.appendChild(option);
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
