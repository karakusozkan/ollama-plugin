# Playwright MCP Example

This folder contains guidance for running a Playwright-based MCP (Model Context Protocol) server
that exposes browser automation tools the Ollama Agent can use.

Prerequisites

- Node.js and npm installed
- (Optional) On Windows, ensure `npx` is available in PATH (PowerShell will prefer npx.cmd)

Quick start (recommended):

1. From your workspace root, run the Playwright MCP server with npx:

```powershell
# Windows / PowerShell
npx -y @playwright/mcp@latest
```

```bash
# macOS / Linux
npx -y @playwright/mcp@latest
```

2. Add a Playwright MCP server config in VS Code settings (Workspace settings -> Extensions -> Ollama Agent -> MCP Servers):

```json
{
	"ollamaAgent.mcpServers": [
		{
			"name": "playwright",
			"command": "npx",
			"args": ["-y", "@playwright/mcp@latest"],
			"enabled": true,
			"timeoutMs": 120000
		}
	]
}
```

3. In the extension, run the command "Ollama Agent: Add Playwright MCP" (or use the MCP Servers view "Add Playwright" button). The extension will attempt to connect and discover tools.

Notes & Troubleshooting

- If `npx` fails on Windows, the extension attempts common fallbacks such as `npx.cmd` or running via `cmd /c`.
- Check the "Ollama Agent" output channel (and Debug Console) for detailed MCP connection logs.
- If tools are not discovered, run the `Ollama Agent: Debug MCP Tools` command and inspect the raw tool list.

Security

- Running an MCP server with browser automation can access the network and local filesystem depending on server capabilities. Only run MCP servers you trust.

This README is a lightweight scaffold to help reproducible local testing and diagnostics.
