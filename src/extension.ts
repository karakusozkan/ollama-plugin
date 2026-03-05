import * as vscode from "vscode";
import { Agent } from "./agent/agent";
import { OllamaProvider, estimateMessagesTokens, OllamaModel } from "./agent/llm";
import { McpManager, McpServerConfig } from "./agent/mcp";
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

  // ── ollamaAgent.addMcpServer ─────────────────────────────────────────────────
  const addMcpServerCommand = vscode.commands.registerCommand(
    "ollamaAgent.addMcpServer",
    async () => {
      await addMcpServer(mcpManager, outputChannel);
    }
  );
  context.subscriptions.push(addMcpServerCommand);

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

    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; action?: string; serverName?: string; toolName?: string; enabled?: boolean }) => {
      if (msg.type === "manageServer" && msg.action && msg.serverName) {
        await this.manageServer(msg.serverName, msg.action);
      } else if (msg.type === "addServer") {
        await addMcpServer(this._mcpManager, this._outputChannel);
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
      
      for (const server of servers) {
        const statusIcon = server.enabled ? "✅" : "❌";
        const statusText = server.enabled ? "Connected" : "Disabled";
        const statusClass = server.enabled ? "status-connected" : "status-disabled";
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
          <div class="server-card">
            <div class="server-header">
              <span class="server-name">${server.name}</span>
              <span class="server-status ${statusClass}">${statusIcon} ${statusText}</span>
            </div>
            <div class="server-details">
              <code>${server.command} ${(server.args || []).join(" ")}</code>
            </div>
            <div class="tools-section">
              <div class="tools-header">Tools (${tools.length})</div>
              <div class="tools-list">
                ${toolsHtml}
              </div>
            </div>
            <div class="server-actions">
              ${server.enabled 
                ? `<button onclick="vscode.postMessage({ type: 'manageServer', action: 'disable', serverName: '${server.name}' })">Disable Server</button>`
                : `<button onclick="vscode.postMessage({ type: 'manageServer', action: 'enable', serverName: '${server.name}' })">Enable Server</button>`
              }
              <button onclick="vscode.postMessage({ type: 'manageServer', action: 'edit', serverName: '${server.name}' })">Edit</button>
              <button class="danger" onclick="vscode.postMessage({ type: 'manageServer', action: 'remove', serverName: '${server.name}' })">Remove</button>
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
    .btn { padding: 6px 12px; border-radius: 4px; border: none; cursor: pointer; background: var(--btn-bg); color: var(--btn-fg); font-size: 12px; }
    .btn:hover { opacity: 0.9; }
    .btn.danger { background: #d32f2f; color: white; }
    .btn.secondary { background: var(--vscode-button-secondaryBackground); }
    .server-card { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-widget-border, #454545); border-radius: 6px; padding: 12px; margin-bottom: 12px; }
    .server-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .server-name { font-weight: 600; font-size: 14px; }
    .server-status { font-size: 12px; }
    .status-connected { color: #4caf50; }
    .status-disabled { color: #f44336; }
    .server-details { margin-bottom: 8px; }
    .server-details code { font-size: 11px; background: var(--vscode-input-background); padding: 4px 8px; border-radius: 4px; }
    .tools-section { margin: 12px 0; padding-top: 12px; border-top: 1px solid var(--vscode-widget-border, #454545); }
    .tools-header { font-size: 12px; font-weight: 600; margin-bottom: 8px; color: var(--vscode-foreground, #cccccc); }
    .tools-list { display: flex; flex-direction: column; gap: 4px; }
    .tool-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: var(--vscode-input-background); border-radius: 4px; }
    .tool-name { font-size: 12px; font-family: monospace; }
    .toggle-btn { padding: 4px 8px; border-radius: 4px; border: none; cursor: pointer; font-size: 11px; background: #666; color: white; }
    .toggle-btn.enabled { background: #4caf50; }
    .toggle-btn:hover { opacity: 0.9; }
    .no-tools { font-size: 11px; color: var(--vscode-foreground, #888); font-style: italic; padding: 4px 0; }
    .server-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .server-actions button { flex: 1; min-width: 80px; }
    .empty { text-align: center; padding: 24px; color: var(--vscode-foreground, #cccccc); }
  </style>
</head>
<body>
  <div class="header">
    <span class="title">MCP Servers</span>
    <div>
      <button class="btn secondary" onclick="vscode.postMessage({ type: 'refresh' })">↻</button>
      <button class="btn" onclick="vscode.postMessage({ type: 'addServer' })">+ Add Server</button>
    </div>
  </div>
  <div class="stats">${servers.length} server(s) • ${enabledToolsCount} tool(s) enabled</div>
  <div class="servers">
    ${serversHtml}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
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
