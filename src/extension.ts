import * as vscode from "vscode";
import { Agent } from "./agent/agent";
import { OllamaProvider, estimateMessagesTokens, OllamaModel } from "./agent/llm";
import { McpManager, McpServerConfig } from "./agent/mcp";
import { executeActions } from "./agent/executor";
import { buildSystemPrompt, ToolAction, ExtendedToolAction } from "./agent/tools";

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem | undefined;
let mcpManager: McpManager;

function formatLogTimestamp(date = new Date()): string {
  const pad = (value: number, size = 2) => value.toString().padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function prefixLogLines(message: string, timestamp = formatLogTimestamp()): string {
  return message
    .split(/\r?\n/)
    .map((line) => `[${timestamp}] ${line}`)
    .join("\n");
}

interface SidebarAgentResponse {
  thought: string;
  actions: ExtendedToolAction[];
}

function parseSidebarAgentResponse(raw: string): SidebarAgentResponse {
  let jsonStr = raw;

  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    const jsonMatch = raw.match(/\{[\s\S]*"thought"[\s\S]*"actions"[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    } else {
      const anyJsonMatch = raw.match(/\{[\s\S]*\}/);
      if (anyJsonMatch) {
        jsonStr = anyJsonMatch[0];
      }
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Agent returned non-JSON output:\n${raw.slice(0, 500)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("actions" in parsed)
  ) {
    throw new Error(`Agent response missing required \"actions\" field:\n${JSON.stringify(parsed, null, 2)}`);
  }

  return parsed as SidebarAgentResponse;
}

function buildSidebarFeedbackMessage(results: import("./agent/executor").ActionResult[]): string {
  const lines = results.map((result) => {
    const label = result.success ? "✅" : "❌";
    const action = result.action;
    const location = "path" in action
      ? action.path
      : "command" in action
      ? action.command
      : "url" in action
      ? action.url
      : action.tool === "mcp_tool"
      ? `${action.server}/${action.name}`
      : "";

    let line = `${label} ${action.tool}${location ? ` → ${location}` : ""}`;
    if (result.output) {
      line += `\n${result.output.slice(0, 20000)}`;
    }
    return line;
  });

  return `Tool execution results:\n\n${lines.join("\n\n")}`;
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Ollama Agent");
  context.subscriptions.push(outputChannel);

  // Forward OutputChannel messages to the Debug Console as well so logs
  // are visible in the Debug Console. We monkey-patch `append`/`appendLine`
  // so all existing usage of `outputChannel` continues to work.
  try {
    const oc: any = outputChannel;
    const origAppendLine = oc.appendLine.bind(oc);
    oc.appendLine = (msg: string) => {
      const formatted = prefixLogLines(msg);
      try { origAppendLine(formatted); } catch {}
      try { vscode.debug.activeDebugConsole.appendLine(formatted); } catch {}
    };
    const origAppend = oc.append.bind(oc);
    let appendBufferAtLineStart = true;
    oc.append = (msg: string) => {
      const text = String(msg ?? "");
      const formatted = appendBufferAtLineStart ? prefixLogLines(text) : text;
      appendBufferAtLineStart = /(?:\r?\n)$/.test(text);
      try { origAppend(formatted); } catch {}
      try { vscode.debug.activeDebugConsole.append(formatted); } catch {}
    };
  } catch {}

  // Log configuration values read at startup for visibility
  try {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const startupConfig = {
      endpoint: config.get<string>("endpoint"),
      model: config.get<string>("model"),
      chatFormat: config.get<string>("chatFormat"),
      temperature: config.get<number>("temperature"),
      useStreaming: config.get<boolean>("useStreaming"),
      streamingStallTimeoutMs: config.get<number>("streamingStallTimeoutMs"),
      requestTimeoutMs: config.get<number>("requestTimeoutMs"),
      mcpServers: config.get("mcpServers"),
      mcpDisabledTools: config.get("mcpDisabledTools"),
    };
    outputChannel.appendLine(`[startup] ollamaAgent configuration:\n${JSON.stringify(startupConfig, null, 2)}`);
  } catch (err) {
    outputChannel.appendLine(`[startup] Failed to read ollamaAgent configuration: ${err}`);
  }

  const provider = new OllamaProvider();
  provider.outputChannel = outputChannel;  // wire logging
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

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Ollama Agent is working…",
          cancellable: true,
        },
        async (_progress, token) => {
          const abortController = new AbortController();
          token.onCancellationRequested(() => {
            abortController.abort();
            outputChannel.appendLine("⏹ Run command cancelled by user.");
          });

          try {
            await agent.run(goal, outputChannel, abortController.signal);
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

  // ── ollamaAgent.addMcpServer ─────────────────────────────────────────────────
  const addMcpServerCommand = vscode.commands.registerCommand(
    "ollamaAgent.addMcpServer",
    async () => {
      await addMcpServer(mcpManager, outputChannel);
    }
  );
  context.subscriptions.push(addMcpServerCommand);

  // ── ollamaAgent.addPlaywrightMcp ──────────────────────────────────────────
  const addPlaywrightMcpCommand = vscode.commands.registerCommand(
    "ollamaAgent.addPlaywrightMcp",
    async () => {
      const confirm = await vscode.window.showInformationMessage(
        "Add a Playwright MCP server configuration and attempt to connect?",
        "Add and Connect",
        "Cancel"
      );
      if (confirm !== "Add and Connect") return;

      const config = vscode.workspace.getConfiguration("ollamaAgent");
      const existing = config.get<McpServerConfig[]>("mcpServers", []);
      const name = "playwright";
      const already = existing.find(s => s.name === name);
      const entry: McpServerConfig = {
        name,
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
        enabled: true
      };

      if (already) {
        const replace = await vscode.window.showWarningMessage(
          `A server named "${name}" already exists. Replace it?`,
          "Replace",
          "Cancel"
        );
        if (replace !== "Replace") return;
        const idx = existing.indexOf(already);
        existing[idx] = entry;
      } else {
        existing.push(entry);
      }

      try {
        await config.update("mcpServers", existing, vscode.ConfigurationTarget.Workspace);
        outputChannel.appendLine(`[MCP] Added Playwright MCP server configuration.`);
        await mcpManager.loadFromSettings();
        vscode.window.showInformationMessage("Playwright MCP server added and connection attempted.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to add Playwright MCP server: ${msg}`);
      }
    }
  );
  context.subscriptions.push(addPlaywrightMcpCommand);

  // ── ollamaAgent.debugMcpTools ─────────────────────────────────────────────
  const debugMcpToolsCommand = vscode.commands.registerCommand(
    "ollamaAgent.debugMcpTools",
    async () => {
      const config = vscode.workspace.getConfiguration("ollamaAgent");
      const servers = config.get<McpServerConfig[]>("mcpServers", []);
      if (!servers || servers.length === 0) {
        vscode.window.showInformationMessage("No MCP servers configured.");
        return;
      }
      const pick = await vscode.window.showQuickPick(servers.map((s) => s.name), { placeHolder: "Select MCP server to fetch tools from" });
      if (!pick) return;
      try {
        const tools = await mcpManager.fetchToolsRaw(pick);
        outputChannel.appendLine(`Raw tools for ${pick}:\n${JSON.stringify(tools, null, 2)}`);
        vscode.window.showInformationMessage(`Fetched tools for ${pick}. See 'Ollama Agent' output.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to fetch tools: ${msg}`);
      }
    }
  );
  context.subscriptions.push(debugMcpToolsCommand);

  // ── Register the MCP servers webview view provider ───────────────────────────
  const mcpViewProvider = new McpServersViewProvider(context.extensionUri, mcpManager, outputChannel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "ollamaAgent.mcpView",
      mcpViewProvider,
      {
        webviewOptions: { retainContextWhenHidden: true }
      }
    )
  );

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

// ── Add MCP Server Command ─────────────────────────────────────────────────

async function addMcpServer(mcpManager: McpManager, outputChannel: vscode.OutputChannel): Promise<void> {
  // Get current MCP servers from settings
  const config = vscode.workspace.getConfiguration("ollamaAgent");
  const existingServers = config.get<McpServerConfig[]>("mcpServers", []);
  
  // Build list items: existing servers + "Add new server" option
  const items: vscode.QuickPickItem[] = [
    { label: "$(add) Add new MCP server", description: "Create a new MCP server configuration" }
  ];
  
  for (const server of existingServers) {
    const status = server.enabled ? "✅" : "❌";
    items.push({
      label: `${status} ${server.name}`,
      description: `${server.command} ${(server.args || []).join(" ")}`,
      detail: server.enabled ? "Enabled" : "Disabled"
    });
  }
  
  // Show quick pick to select server or add new
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Select an MCP server to manage or add a new one",
    matchOnDescription: true,
    matchOnDetail: true
  });
  
  if (!selected) {
    return;
  }
  
  // Check if user selected "Add new server"
  if (selected.label.includes("Add new MCP server")) {
    await promptAndAddServer(mcpManager, outputChannel, existingServers);
    return;
  }
  
  // User selected an existing server - show management options
  const serverName = selected.label.replace(/^[✅❌]\s*/, "");
  const server = existingServers.find(s => s.name === serverName);
  
  if (!server) {
    return;
  }
  
  // Show actions for the selected server
  const action = await vscode.window.showQuickPick(
    [
      { label: "$(debug-start) Enable", description: "Enable this MCP server" },
      { label: "$(debug-stop) Disable", description: "Disable this MCP server" },
      { label: "$(edit) Edit", description: "Edit this server configuration" },
      { label: "$(trash) Remove", description: "Remove this MCP server" }
    ],
    {
      placeHolder: `Manage server: ${serverName}`
    }
  );
  
  if (!action) {
    return;
  }
  
  if (action.label.includes("Enable")) {
    server.enabled = true;
    await saveAndReload(mcpManager, outputChannel, existingServers, `Enabled MCP server "${serverName}"`);
  } else if (action.label.includes("Disable")) {
    server.enabled = false;
    await saveAndReload(mcpManager, outputChannel, existingServers, `Disabled MCP server "${serverName}"`);
  } else if (action.label.includes("Edit")) {
    await promptAndEditServer(mcpManager, outputChannel, existingServers, server);
  } else if (action.label.includes("Remove")) {
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to remove "${serverName}"?`,
      "Remove",
      "Cancel"
    );
    if (confirm === "Remove") {
      const index = existingServers.indexOf(server);
      existingServers.splice(index, 1);
      await saveAndReload(mcpManager, outputChannel, existingServers, `Removed MCP server "${serverName}"`);
    }
  }
}

async function promptAndAddServer(
  mcpManager: McpManager, 
  outputChannel: vscode.OutputChannel, 
  servers: McpServerConfig[]
): Promise<void> {
  // Step 1: Ask for server name
  const name = await vscode.window.showInputBox({
    prompt: "MCP Server Name",
    placeHolder: "e.g., filesystem",
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Server name is required";
      }
      return null;
    }
  });
  
  if (!name) {
    return;
  }

  // Step 2: Ask for command
  const command = await vscode.window.showInputBox({
    prompt: "Command to launch MCP server",
    placeHolder: "e.g., npx, python, uvx",
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Command is required";
      }
      return null;
    }
  });
  
  if (!command) {
    return;
  }

  // Step 3: Ask for optional arguments
  const argsInput = await vscode.window.showInputBox({
    prompt: "Arguments for the command (comma-separated, optional)",
    placeHolder: "e.g., -y, @modelcontextprotocol/server-filesystem, /path/to/folder"
  });
  
  const args = argsInput 
    ? argsInput.split(",").map(arg => arg.trim()).filter(arg => arg.length > 0)
    : [];

  // Step 4: Ask for optional working directory
  const cwd = await vscode.window.showInputBox({
    prompt: "Working directory (optional, leave empty for workspace root)",
    placeHolder: "e.g., C:\\Projects\\my-folder"
  });

  // Step 5: Ask if server should be enabled
  const enableServer = await vscode.window.showQuickPick(
    ["Yes, enable immediately", "No, add as disabled"],
    {
      placeHolder: "Enable this MCP server immediately?"
    }
  );

  if (!enableServer) {
    return;
  }

  const shouldEnable = enableServer.startsWith("Yes");

  // Create the new server configuration
  const newServer: McpServerConfig = {
    name: name.trim(),
    command: command.trim(),
    args: args.length > 0 ? args : undefined,
    cwd: cwd?.trim() || undefined,
    enabled: shouldEnable
  };

  // Get current MCP servers from settings
  const config = vscode.workspace.getConfiguration("ollamaAgent");
  const existingServers = config.get<McpServerConfig[]>("mcpServers", []);

  // Check if a server with this name already exists
  const existingIndex = existingServers.findIndex(s => s.name === newServer.name);
  if (existingIndex >= 0) {
    const replace = await vscode.window.showWarningMessage(
      `A server named "${newServer.name}" already exists. Do you want to replace it?`,
      "Replace",
      "Cancel"
    );
    if (replace !== "Replace") {
      return;
    }
    existingServers[existingIndex] = newServer;
  } else {
    existingServers.push(newServer);
  }

  // Save to settings
  try {
    await config.update("mcpServers", existingServers, vscode.ConfigurationTarget.Workspace);
    
    outputChannel.appendLine(`[MCP] Added/updated server: ${newServer.name}`);
    
    // Reload MCP servers
    await mcpManager.loadFromSettings();
    
    if (mcpManager.connectedCount > 0) {
      const toolsCount = mcpManager.getAllTools().length;
      vscode.window.showInformationMessage(
        `MCP server "${newServer.name}" added successfully! ${mcpManager.connectedCount} server(s) connected with ${toolsCount} tool(s) available.`
      );
    } else {
      vscode.window.showWarningMessage(
        `MCP server "${newServer.name}" added but could not connect. Check the output channel for details.`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to save MCP server: ${message}`);
  }
}

async function saveAndReload(
  mcpManager: McpManager,
  outputChannel: vscode.OutputChannel,
  servers: McpServerConfig[],
  message: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration("ollamaAgent");
  try {
    await config.update("mcpServers", servers, vscode.ConfigurationTarget.Workspace);
    outputChannel.appendLine(`[MCP] ${message}`);
    await mcpManager.loadFromSettings();
    const toolsCount = mcpManager.getAllTools().length;
    vscode.window.showInformationMessage(
      `${message}. ${mcpManager.connectedCount} server(s) connected with ${toolsCount} tool(s) available.`
    );
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to update MCP server: ${errMessage}`);
  }
}

async function promptAndEditServer(
  mcpManager: McpManager,
  outputChannel: vscode.OutputChannel,
  servers: McpServerConfig[],
  server: McpServerConfig
): Promise<void> {
  // Ask for new command
  const command = await vscode.window.showInputBox({
    prompt: "Command to launch MCP server",
    value: server.command,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Command is required";
      }
      return null;
    }
  });

  if (!command) {
    return;
  }

  // Ask for optional arguments
  const argsInput = await vscode.window.showInputBox({
    prompt: "Arguments for the command (comma-separated)",
    value: (server.args || []).join(", ")
  });

  const args = argsInput
    ? argsInput.split(",").map(arg => arg.trim()).filter(arg => arg.length > 0)
    : [];

  // Ask for optional working directory
  const cwd = await vscode.window.showInputBox({
    prompt: "Working directory (optional)",
    value: server.cwd || ""
  });

  // Update server
  server.command = command.trim();
  server.args = args.length > 0 ? args : undefined;
  server.cwd = cwd?.trim() || undefined;

  await saveAndReload(mcpManager, outputChannel, servers, `Updated MCP server "${server.name}"`);
}

// ── MCP Servers View Provider ─────────────────────────────────────────────────

class McpServersViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _extensionUri: vscode.Uri;
  private _mcpManager: McpManager;
  private _outputChannel: vscode.OutputChannel;

  constructor(extensionUri: vscode.Uri, mcpManager: McpManager, outputChannel: vscode.OutputChannel) {
    this._extensionUri = extensionUri;
    this._mcpManager = mcpManager;
    this._outputChannel = outputChannel;
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

    this.refreshView();

    // Refresh the view whenever MCP finishes (re)loading so tools appear immediately.
    this._mcpManager.onDidLoad(() => this.refreshView());

    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; action?: string; serverName?: string; toolName?: string; enabled?: boolean }) => {
      if (msg.type === "manageServer" && msg.action && msg.serverName) {
        await this.manageServer(msg.serverName, msg.action);
      } else if (msg.type === "addServer") {
        await addMcpServer(this._mcpManager, this._outputChannel);
        this.refreshView();
      } else if (msg.type === "addPlaywright") {
        await vscode.commands.executeCommand('ollamaAgent.addPlaywrightMcp');
        this.refreshView();
      } else if (msg.type === "refresh") {
        await this._mcpManager.loadFromSettings();
        this.refreshView();
      } else if (msg.type === "toggleTool" && msg.serverName && msg.toolName && msg.enabled !== undefined) {
        await this.toggleTool(msg.serverName, msg.toolName, msg.enabled);
      }
    });
  }

  private async toggleTool(serverName: string, toolName: string, enabled: boolean): Promise<void> {
    await this._mcpManager.toggleTool(serverName, toolName, enabled);
    const status = enabled ? "enabled" : "disabled";
    this._outputChannel.appendLine(`[MCP] Tool "${toolName}" on server "${serverName}" ${status}`);
    this.refreshView();
  }

  private async manageServer(serverName: string, action: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    const servers = config.get<McpServerConfig[]>("mcpServers", []);
    const server = servers.find(s => s.name === serverName);

    if (!server) {
      return;
    }

    if (action === "enable") {
      server.enabled = true;
      await this.saveAndReload(servers, `Enabled MCP server "${serverName}"`);
    } else if (action === "disable") {
      server.enabled = false;
      await this.saveAndReload(servers, `Disabled MCP server "${serverName}"`);
    } else if (action === "remove") {
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to remove "${serverName}"?`,
        "Remove",
        "Cancel"
      );
      if (confirm === "Remove") {
        const index = servers.indexOf(server);
        servers.splice(index, 1);
        await this.saveAndReload(servers, `Removed MCP server "${serverName}"`);
      }
    } else if (action === "edit") {
      await promptAndEditServer(this._mcpManager, this._outputChannel, servers, server);
    }

    this.refreshView();
  }

  private async saveAndReload(servers: McpServerConfig[], message: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    try {
      await config.update("mcpServers", servers, vscode.ConfigurationTarget.Workspace);
      this._outputChannel.appendLine(`[MCP] ${message}`);
      await this._mcpManager.loadFromSettings();
      const toolsCount = this._mcpManager.getAllTools().length;
      vscode.window.showInformationMessage(
        `${message}. ${this._mcpManager.connectedCount} server(s) connected with ${toolsCount} tool(s) available.`
      );
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to update MCP server: ${errMessage}`);
    }
  }

  private refreshView(): void {
    if (!this._view) return;
    
    const allTools = this._mcpManager.getAllToolsWithStatus();
    const allServers = this.getServerConfigs();
    const enabledToolsCount = this._mcpManager.getAllTools().length;
    
    this._view.webview.html = this._getWebviewContent(allServers, allTools, enabledToolsCount);
  }

  private getServerConfigs(): McpServerConfig[] {
    const config = vscode.workspace.getConfiguration("ollamaAgent");
    return config.get<McpServerConfig[]>("mcpServers", []);
  }

  private _getWebviewContent(servers: McpServerConfig[], allTools: Array<{ serverName: string; tool: import("./agent/mcp").McpToolDefinition; enabled: boolean }>, enabledToolsCount: number): string {
    let serversHtml = "";
    
    if (servers.length === 0) {
      serversHtml = `<div class="empty">No MCP servers configured. Click "Add Server" to add one.</div>`;
    } else {
      // Group tools by server
      const toolsByServer = new Map<string, typeof allTools>();
      for (const t of allTools) {
        const existing = toolsByServer.get(t.serverName) || [];
        existing.push(t);
        toolsByServer.set(t.serverName, existing);
      }
      
      for (let i = 0; i < servers.length; i++) {
        const server = servers[i];
        const isConnected = server.enabled !== false && this._mcpManager.isServerConnected(server.name);
        const statusIcon = server.enabled === false ? "❌" : (isConnected ? "✅" : "⚠️");
        const statusText = server.enabled === false ? "Disabled" : (isConnected ? "Connected" : "Connecting…");
        const statusClass = server.enabled === false ? "status-disabled" : (isConnected ? "status-connected" : "status-connecting");
        const tools = toolsByServer.get(server.name) || [];
        
        // Build tools list
        let toolsHtml = "";
        for (const t of tools) {
          const toggleLabel = t.enabled ? "Disable" : "Enable";
          toolsHtml += `
            <div class="tool-item">
              <span class="tool-name">${t.tool.name}</span>
              <button class="toggle-btn ${t.enabled ? 'enabled' : ''}" 
                onclick="vscode.postMessage({ type: 'toggleTool', serverName: '${server.name}', toolName: '${t.tool.name}', enabled: ${!t.enabled} })">
                ${t.enabled ? '✅ On' : '❌ Off'}
              </button>
            </div>`;
        }
        
        if (tools.length === 0 && server.enabled) {
          toolsHtml = `<div class="no-tools">No tools discovered yet</div>`;
        } else if (tools.length === 0) {
          toolsHtml = `<div class="no-tools">Server is disabled</div>`;
        }
        
        serversHtml += `
          <div class="server-card" id="server-card-${i}">
            <div class="server-header">
              <button class="collapse-btn" data-idx="${i}" aria-expanded="true" title="Collapse/Expand">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <span class="server-name">${server.name}</span>
              <span class="server-status ${statusClass}">${statusIcon} ${statusText}</span>
            </div>
            <div class="server-details">
              <code>${server.command} ${(server.args || []).join(" ")}</code>
            </div>
            <div class="tools-section">
              <div class="tools-header"><span>Tools (${tools.length})</span><button class="tools-toggle" data-idx="${i}" aria-expanded="true" title="Collapse/Expand Tools">▾</button></div>
              <div class="tools-list" id="tools-list-${i}">
                ${toolsHtml}
              </div>
            </div>
            <div class="server-actions">
              ${server.enabled 
                ? `<button class="icon-btn" title="Disable Server" aria-label="Disable Server" onclick="vscode.postMessage({ type: 'manageServer', action: 'disable', serverName: '${server.name}' })"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 2v10\"/><path d=\"M5.07 6.93a8 8 0 1 0 13.86 0\"/></svg></button>`
                : `<button class="icon-btn" title="Enable Server" aria-label="Enable Server" onclick="vscode.postMessage({ type: 'manageServer', action: 'enable', serverName: '${server.name}' })"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"9\"></circle><path d=\"M12 7v5l3 3\"/></svg></button>`
              }
              <button class="icon-btn" title="Edit Server" aria-label="Edit Server" onclick="vscode.postMessage({ type: 'manageServer', action: 'edit', serverName: '${server.name}' })"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 21v-3l11-11 3 3L6 21H3z\"/></svg></button>
              <button class="danger icon-btn" title="Remove Server" aria-label="Remove Server" onclick="vscode.postMessage({ type: 'manageServer', action: 'remove', serverName: '${server.name}' })"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"3 6 5 6 21 6\"/><path d=\"M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6\"/></svg></button>
            </div>
          </div>`;
      }
    }

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
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --input-bg: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
    }
    body { margin: 0; padding: 12px; background: var(--bg); color: var(--fg); }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .title { font-size: 16px; font-weight: 600; color: var(--vscode-foreground, #cccccc); }
    .stats { font-size: 12px; color: var(--vscode-foreground, #cccccc); margin-bottom: 12px; }
    .btn { padding: 6px 12px; border-radius: 4px; border: none; cursor: pointer; background: var(--btn-bg); color: var(--btn-fg); font-size: 12px; transition: background-color .18s ease, transform .08s ease; }
    .btn:hover { transform: translateY(-1px); }
    .btn.danger { background: #d32f2f; color: white; }
    .btn.secondary { background: var(--vscode-button-secondaryBackground); }
    /* Icon button coloring */
    .icon-btn { background: var(--btn-bg); color: var(--btn-fg); border-radius: 6px; transition: background-color .18s ease, color .18s ease, transform .08s ease; }
    .icon-btn:hover { background: rgba(255,255,255,0.04); transform: translateY(-1px); }
    .icon-btn[title="Remove Server"]:hover { background: #b71c1c; }
    .server-card { position: relative; background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-widget-border, #454545); border-radius: 6px; padding: 12px; margin-bottom: 12px; }
    .server-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding-left: 44px; }
    .server-header { gap: 8px; }
    .collapse-btn { position: absolute; left: 12px; top: 12px; width: 28px; height: 28px; padding: 4px; background: var(--vscode-input-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; transition: transform .18s ease, background-color .12s ease; z-index: 6; }
    .collapse-btn:hover { transform: translateY(-1px); background: rgba(255,255,255,0.03); }
    .collapse-btn svg { width: 14px; height: 14px; }
    .server-card.collapsed .collapse-btn { transform: rotate(-90deg); }
    /* Smooth collapse: animate max-height + opacity */
    .server-details, .tools-section, .server-actions { overflow: hidden; transition: max-height .28s ease, opacity .18s ease; }
    .server-details { max-height: 120px; opacity: 1; }
    .tools-section { max-height: 400px; opacity: 1; }
    .server-actions { max-height: 80px; opacity: 1; }
    .server-card.collapsed .server-details { max-height: 0; opacity: 0; }
    .server-card.collapsed .tools-section { max-height: 0; opacity: 0; }
    .server-card.collapsed .server-actions { max-height: 0; opacity: 0; }
    .server-name { font-weight: 600; font-size: 14px; }
    .server-status { font-size: 12px; }
    .status-connected { color: #4caf50; }
    .status-disabled { color: #f44336; }
    .server-details { margin-bottom: 8px; }
    .server-details code { font-size: 11px; background: var(--vscode-input-background); padding: 4px 8px; border-radius: 4px; }
    .tools-section { margin: 12px 0; padding-top: 12px; border-top: 1px solid var(--vscode-widget-border, #454545); }
    .tools-header { font-size: 12px; font-weight: 600; margin-bottom: 8px; color: var(--vscode-foreground, #cccccc); display:flex; justify-content:space-between; align-items:center; }
    .tools-toggle { width: 28px; height: 28px; padding: 4px; background: var(--vscode-input-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: transform .18s ease, background-color .12s ease; }
    .tools-toggle:hover { background: rgba(255,255,255,0.03); transform: translateY(-1px); }
    .tools-toggle[aria-expanded="false"] { transform: rotate(-90deg); }
    /* Make only the tools-list animate so header stays visible */
    .tools-list { overflow-y: auto; transition: max-height .28s ease; max-height: 400px; }
    .tools-list.collapsed { max-height: 0; }
    .tools-list { display: flex; flex-direction: column; gap: 4px; }
    .tool-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: var(--vscode-input-background); border-radius: 4px; }
    .tool-name { font-size: 12px; font-family: monospace; }
    .toggle-btn { padding: 4px 8px; border-radius: 4px; border: none; cursor: pointer; font-size: 11px; background: #666; color: white; }
    .toggle-btn.enabled { background: #4caf50; }
    .toggle-btn:hover { opacity: 0.9; }
    .no-tools { font-size: 11px; color: var(--vscode-foreground, #888); font-style: italic; padding: 4px 0; }
    .status-connecting { color: #ff9800; }
    .server-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .server-actions button { flex: 1; min-width: 80px; }
    .server-actions .icon-btn { flex: 0 0 auto; min-width: 36px; padding: 6px; display: inline-flex; align-items: center; justify-content: center; }
    .server-actions .icon-btn svg { width: 16px; height: 16px; }
    .server-actions .danger.icon-btn { background: #d32f2f; color: white; }
    .empty { text-align: center; padding: 24px; color: var(--vscode-foreground, #cccccc); }
  </style>
</head>
<body>
    <div class="header">
    <span class="title">MCP Servers</span>
    <div>
      <button class="btn secondary" onclick="vscode.postMessage({ type: 'refresh' })">↻</button>
      <button class="btn" title="Add Server" onclick="vscode.postMessage({ type: 'addServer' })" aria-label="Add Server">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  </div>
  <div class="stats">${servers.length} server(s) • ${enabledToolsCount} tool(s) enabled</div>
  <div class="servers">
    ${serversHtml}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    // Collapse/expand per-server with measured-height animation
    document.addEventListener('DOMContentLoaded', () => {
      function animateSection(el, expand) {
        if (!el) return;
        // Clear any inline transition hooks when done
        const cleanup = () => { el.style.maxHeight = ''; el.removeEventListener('transitionend', cleanup); };

        if (expand) {
          // expand: ensure start at 0 then animate to scrollHeight
          el.classList.remove('collapsed');
          el.style.maxHeight = '0px';
          // force reflow
          void el.offsetHeight;
          const full = el.scrollHeight;
          el.style.maxHeight = full + 'px';
          el.addEventListener('transitionend', cleanup);
        } else {
          // collapse: animate from current height to 0 (or the collapsed max)
          const full = el.scrollHeight;
          el.style.maxHeight = full + 'px';
          // force reflow
          void el.offsetHeight;
          el.style.maxHeight = '0px';
          // when finished, keep the collapsed class for styling
          const onEnd = () => { el.classList.add('collapsed'); cleanup(); el.removeEventListener('transitionend', onEnd); };
          el.addEventListener('transitionend', onEnd);
        }
      }

      // Server header collapse button
      document.querySelectorAll('.collapse-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = btn.dataset.idx;
          const card = document.getElementById('server-card-' + idx);
          if (!card) return;
          const isNowCollapsed = card.classList.toggle('collapsed');
          btn.setAttribute('aria-expanded', isNowCollapsed ? 'false' : 'true');

          const details = card.querySelector('.server-details');
          const tools = document.getElementById('tools-section-' + idx);
          const actions = card.querySelector('.server-actions');

          // If we're un-collapsing the card, ensure the tools section is expanded
          if (!isNowCollapsed) {
            // expand tools-list when un-collapsing card so header/toggle remain visible
            const toolsList = document.getElementById('tools-list-' + idx);
            if (toolsList) {
              toolsList.classList.remove('collapsed');
              const toolsToggle = card.querySelector('.tools-toggle[data-idx="' + idx + '"]');
              if (toolsToggle) toolsToggle.setAttribute('aria-expanded', 'true');
            }
          }

          // animate each section; tools-list (if present) is animated separately
          animateSection(details, !isNowCollapsed);
          const toolsList = document.getElementById('tools-list-' + idx);
          if (toolsList) animateSection(toolsList, !isNowCollapsed);
          animateSection(actions, !isNowCollapsed);
        });
      });

      // Tools toggles (collapse just the tools-list so header stays visible)
      document.querySelectorAll('.tools-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = btn.dataset.idx;
          const toolsList = document.getElementById('tools-list-' + idx);
          if (!toolsList) return;
          const isNowCollapsed = toolsList.classList.toggle('collapsed');
          btn.setAttribute('aria-expanded', isNowCollapsed ? 'false' : 'true');
          animateSection(toolsList, !isNowCollapsed);
        });
      });
    });
  </script>
</body>
</html>`;
  }
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

  private async _buildChatSystemPrompt(): Promise<string> {
    return buildSystemPrompt(this._mcpManager);
  }

  private async _syncChatSystemPrompt(): Promise<void> {
    const systemPrompt = await this._buildChatSystemPrompt();
    if (this._history.length > 0 && this._history[0].role === "system") {
      this._history[0] = { role: "system", content: systemPrompt };
      return;
    }

    this._history.unshift({ role: "system", content: systemPrompt });
  }

  private async _refreshRunningContext(): Promise<void> {
    this._updateContextDisplay();
  }

  private _getModelContextSize(): number | null {
    if (!this._selectedModel || !this._availableModels) return null;
    const m = this._availableModels.find(x => x.name === this._selectedModel) as any;
    if (!m) {
      outputChannel.appendLine(`[context] selected model "${this._selectedModel}" not in availableModels`);
      return null;
    }

    // 1. model_info from /api/show — look for *.context_length (e.g. "llama.context_length")
    if (m.model_info && typeof m.model_info === 'object') {
      const key = Object.keys(m.model_info).find(k => k.endsWith('.context_length'));
      if (key) {
        const val = m.model_info[key];
        if (typeof val === 'number' && val > 0) {
          outputChannel.appendLine(`[context] "${m.name}" → model_info.${key}: ${val}`);
          return val;
        }
      }
    }

    // 2. Fallback: other known field names
    const fallback = m.context_window ?? m.contextWindow ?? m.max_tokens ?? m.maxTokens;
    outputChannel.appendLine(`[context] "${m.name}" → no context found (context=${m.context} model_info keys=${m.model_info ? Object.keys(m.model_info).join(',') : 'none'} fallback=${fallback})`);
    return typeof fallback === 'number' && fallback > 0 ? fallback : null;
  }

  private _updateContextDisplay(): void {
    const usedTokens = estimateMessagesTokens(this._history);
    const maxTokens = this._getModelContextSize();
    if (maxTokens === null) {
      // Context size not yet known — keep the placeholder display
      return;
    }
    const remaining = Math.max(0, maxTokens - usedTokens);
    this._view?.webview.postMessage({ 
      type: "updateContext", 
      used: usedTokens, 
      max: maxTokens,
      remaining 
    });
  }

  private async _fetchAndSendModels(): Promise<void> {
    outputChannel.show(true);
    outputChannel.appendLine('[models] fetching model list...');
    try {
      const baseList = await this._provider.listModels();
      outputChannel.appendLine(`[models] got ${baseList.length} model(s): ${baseList.map(m => m.name).join(', ')}`);
      // Fetch detailed metadata for each model via /api/show.

      const detailed = await Promise.all(baseList.map(async (m) => {
        try {
          const info = await (this._provider as any).getModelInfo(m.name).catch(() => ({}));
          return { ...m, ...info } as OllamaModel & any;
        } catch {
          return m as OllamaModel & any;
        }
      }));

      this._availableModels = detailed;

      // Log available models and their full metadata for debugging/startup visibility.
      try {
        this._availableModels.forEach(m => {
          try {
            outputChannel.appendLine(`Model: ${m.name} metadata: ${JSON.stringify(m)}`);
          } catch {
            outputChannel.appendLine(`Model: ${m.name} (metadata unavailable)`);
          }
        });
      } catch {}
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
      if (msg.type === 'openMcp') {
        try {
          await vscode.commands.executeCommand('workbench.views.revealView', 'ollamaAgent.mcpView');
        } catch {
          // Fallback: open the extension sidebar container
          await vscode.commands.executeCommand('workbench.view.extension.ollama-agent-sidebar');
        }
        return;
      }
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
        await this._refreshRunningContext();
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
        const agentConfig = vscode.workspace.getConfiguration("ollamaAgent");
        const useStreaming = agentConfig.get<boolean>("useStreaming", true);
        const maxIterations = 8;

        if (!this._initialized) {
          await this._syncChatSystemPrompt();
          this._initialized = true;
        } else {
          await this._syncChatSystemPrompt();
        }

        this._history.push({ role: "user", content: userText });
        this._updateContextDisplay();

        for (let iteration = 0; iteration < maxIterations; iteration++) {
          if (abortSignal.aborted) {
            this._view?.webview.postMessage({ type: "append", role: "assistant", text: "⏹ Stopped by user." });
            return;
          }

          let raw = "";
          this._view?.webview.postMessage({ type: "setThinking", thinking: true });

          if (useStreaming) {
            try {
              raw = await this._provider.chatStream(this._history, (_chunk) => {
                // The sidebar renders whole assistant messages after parsing.
              }, this._selectedModel || undefined, abortSignal);
            } catch (streamErr) {
              if (abortSignal.aborted) {
                this._view?.webview.postMessage({ type: "setThinking", thinking: false });
                this._view?.webview.postMessage({ type: "append", role: "assistant", text: "⏹ Stopped by user." });
                return;
              }

              const streamMessage = streamErr instanceof Error ? streamErr.message : String(streamErr);
              outputChannel.appendLine(`[chat] Streaming failed or stalled; retrying without streaming. ${streamMessage}`);
              raw = await this._provider.chat(this._history, this._selectedModel || undefined, abortSignal);
            }
          } else {
            outputChannel.appendLine("[chat] Streaming disabled; using non-streaming chat request.");
            raw = await this._provider.chat(this._history, this._selectedModel || undefined, abortSignal);
          }

          if (!abortSignal.aborted && !raw.trim()) {
            outputChannel.appendLine("[chat] Empty response received; retrying once with the same chat request.");
            raw = await this._provider.chat(this._history, this._selectedModel || undefined, abortSignal);
          }

          this._view?.webview.postMessage({ type: "setThinking", thinking: false });

          if (abortSignal.aborted) {
            this._view?.webview.postMessage({ type: "append", role: "assistant", text: "⏹ Stopped by user." });
            return;
          }

          if (!raw.trim()) {
            throw new Error("The model returned an empty response.");
          }

          let parsed: SidebarAgentResponse;
          try {
            parsed = parseSidebarAgentResponse(raw);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Sidebar agent parse error: ${message}`);
          }

          this._history.push({ role: "assistant", content: raw });
          this._updateContextDisplay();

          if (!parsed.actions || parsed.actions.length === 0) {
            this._view?.webview.postMessage({ type: "append", role: "assistant", text: parsed.thought });
            return;
          }

          const results = await executeActions(parsed.actions, abortSignal, this._mcpManager);
          const summaryLines = results.map((result) => {
            const location = "path" in result.action
              ? result.action.path
              : "command" in result.action
              ? result.action.command
              : "url" in result.action
              ? result.action.url
              : result.action.tool === "mcp_tool"
              ? `${result.action.server}/${result.action.name}`
              : "";
            return `${result.success ? "✅" : "❌"} ${result.action.tool}${location ? ` → ${location}` : ""}`;
          });

          this._view?.webview.postMessage({
            type: "append",
            role: "assistant",
            text: `${parsed.thought}\n\n${summaryLines.join("\n")}`,
          });

          this._history.push({ role: "user", content: buildSidebarFeedbackMessage(results) });
          this._updateContextDisplay();
        }

        this._view?.webview.postMessage({ type: "append", role: "assistant", text: "⚠️ Reached maximum iterations." });
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
    /* Messages use an explicit height (resizable) rather than flex-grow */
    #messages { padding: 12px; overflow: auto; display: flex; flex-direction: column; gap: 12px; flex: 1 1 auto; min-height: 80px; }
    #resizer { height: 8px; cursor: ns-resize; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.03), transparent); margin: 4px 0; }
    .msg { padding: 10px; border-radius: 6px; max-width: 90%; white-space: pre-wrap; font-size: 13px; line-height: 1.5; }
    .user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; }
    .assistant { background: var(--vscode-editor-inactiveSelectionBackground, #3a3d41); color: var(--vscode-editor-foreground, #cccccc); align-self: flex-start; border: 1px solid var(--vscode-widget-border, #454545); }
    #bar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--vscode-widget-border); }
    #input { flex: 1; padding: 8px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); resize: vertical; min-height: 40px; max-height: 300px; overflow: auto; }
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
    /* Mini row below input */
    #mini-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--vscode-widget-border); }
    .mini-text { font-size: 11px; color: var(--vscode-foreground); opacity: 0.85; }
    .mini-btn { padding: 6px 10px; font-size: 12px; border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
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
      <span id="context-info" title="Context window usage">Context: — / — (loading…)</span>
    </div>
    <button id="new-session" title="Start a new session (clears history)">＋ New Session</button>
  </div>
  <div id="resizer" title="Drag to resize chat"></div>
  <div id="messages"></div>
  <div id="loading"><span class="thinking">Ollama is thinking...</span></div>
  <div id="bar">
    <textarea id="input" rows="2" placeholder="Ask Ollama... (Shift+Enter = new line, Enter = send)"></textarea>
    <button id="send">Send</button>
    <button id="stop" title="Stop the agent">⏹ Stop</button>
  </div>
  <div id="mini-row">
    <div class="mini-text"></div>
    <button id="open-mcp" class="mini-btn" title="MCP Servers" aria-label="Open MCP Servers">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block">
        <rect x="3" y="4" width="18" height="5" rx="1.5"></rect>
        <rect x="3" y="15" width="18" height="5" rx="1.5"></rect>
        <circle cx="7" cy="6.5" r="0.6"></circle>
        <circle cx="7" cy="17.5" r="0.6"></circle>
      </svg>
    </button>
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
    const openMcp = document.getElementById('open-mcp');

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

    // Restore persisted state (only messages height). Prompts are kept in-memory per session only.
    const _state = vscode.getState() || {};
    if (_state.messagesHeight) {
      messages.style.height = _state.messagesHeight;
    } else {
      // Make the chat bigger by default
      messages.style.height = '400px';
    }

    // Resizer to adjust chat height
    const resizer = document.getElementById('resizer');
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;
    if (resizer) {
      resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = messages.getBoundingClientRect().height;
        document.body.style.cursor = 'ns-resize';
      });
    }
    window.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const dy = e.clientY - startY;
      const newH = Math.max(120, startHeight + dy);
      messages.style.height = newH + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.cursor = '';
        const s = vscode.getState() || {};
        s.messagesHeight = messages.style.height;
        vscode.setState(s);
      }
    });

    send.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) return;
      // Keep last prompt in-memory for this session only
      window.__ollama_lastPrompt = text;
      const s = vscode.getState() || {};
      s.messagesHeight = messages.style.height;
      vscode.setState(s);
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

    if (openMcp) {
      openMcp.addEventListener('click', () => {
        vscode.postMessage({ type: 'openMcp' });
      });
    }

    modelSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectModel', model: modelSelect.value });
    });

    input.addEventListener('keydown', (e) => {
      // ArrowUp recalls the previous prompt when input is empty
      if (e.key === 'ArrowUp' && !input.value.trim()) {
        const last = window.__ollama_lastPrompt;
        if (last) {
          input.value = last;
          // Select the text so pressing Enter sends immediately
          try { input.setSelectionRange(0, input.value.length); } catch {}
          e.preventDefault();
          return;
        }
      }
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
        // Clear in-memory last prompt when starting a new session
        try { window.__ollama_lastPrompt = undefined; } catch {}
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
    // Focus the input on load for quick typing
    input.focus();
  </script>
</body>
</html>`;
  }
}
