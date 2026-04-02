# Ollama Agentz

An AI coding plugin for VS Code powered by Ollama running locally. This project provides an intelligent assistant that can read, write, and modify files in your workspace, execute shell commands, fetch web content, and integrate with MCP (Model Context Protocol) servers for extended functionality.

![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

## What's New

- Improved streaming detection and automatic fallback to buffered responses when servers do not stream as expected.
- MCP server tooling enhancements: optional `/api/ps` handling, Playwright MCP example, and better error diagnostics.
- The agent now receives live MCP server/tool inventory in its system prompt and can add, update, remove, and reload MCP servers during a session.
- Built-in MCP scaffolding workflow: generate a local MCP server starter, optionally install dependencies, register it, and connect it from the extension.
- Debugging and logging improvements: output forwarded to Debug Console and key settings logged at startup.

## Compatibility

- **Endpoints supported:** Ollama-native (`/api/tags`, `/api/show`, `/api/chat`) and OpenAI-compatible (`/v1/models`, `/v1/chat/completions`).
- **Discovery order:** The extension attempts Ollama-native discovery first, then falls back to OpenAI-compatible discovery.
- **Manual override:** If discovery fails, set `ollamaAgent.endpoint` and `ollamaAgent.model` in settings to point at your server and model.
- **Streaming behavior:** Streaming is detected automatically; when a server does not stream as expected the extension falls back to buffered responses and caches that behavior for the current session.
- **Examples:** See the existing "Native Ollama-compatible server example" and "OpenAI-compatible local server example" sections below for configuration snippets.

## Features

- 🤖 **AI-Powered Coding Assistant**: Leverages local LLMs via Ollama for code generation, refactoring, and analysis
- 💬 **Interactive Chat Interface**: Sidebar chat panel with conversation history and context management
- 🛠️ **File Operations**: Read, create, edit, and delete files in your workspace
- ⚡ **Command Execution**: Run shell commands directly from the agent (PowerShell on Windows, bash/zsh on macOS/Linux)
- 🌐 **Web Fetching**: Retrieve and analyze web content
- 🔌 **MCP Server Support**: Extend capabilities with Model Context Protocol servers
- 🔄 **Streaming Responses**: Real-time response streaming with stop capability
- 📊 **Context Window Tracking**: Monitor token usage and remaining context
- 🧭 **MCP Server Management & Debugging**: Add and manage MCP servers (including Playwright), attempt connections on add, and inspect MCP tools
- 🧠 **MCP-Aware Agent Planning**: The LLM is told which MCP servers and tools are currently available so it can use them for browsing, automation, and external integrations
- 🏗️ **Local MCP Server Scaffolding**: Create a ready-to-edit Node-based MCP server starter directly in your workspace
- 🛟 **Improved Logging & Debug Forwarding**: OutputChannel messages are forwarded to the Debug Console and configuration values are logged at startup for visibility
- 🧰 **Enhanced Chat UX**: Resizable message area and last-prompt recall for faster iterative prompts

## Requirements

- [VS Code](https://code.visualstudio.com/) 1.85.0 or higher
- [Ollama](https://ollama.com/) installed and running locally
- At least one model pulled in Ollama (e.g., `qwen2.5-coder:32b`)

## Installation

1. Clone this repository:

    ```bash
    git clone <repository-url>
    cd ollama-agent
    ```

2. Install dependencies:

    ```bash
    npm install
    ```

3. Compile the extension:

    ```bash
    npm run compile
    ```

4. Press `F5` to open a new Extension Development Host window

## Configuration

Configure the extension through VS Code settings (`Ctrl+,` or `Cmd+,`):

| Setting                               | Default                           | Description                                                                  |
| ------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `ollamaAgent.endpoint`                | `http://localhost:11434/api/chat` | Chat endpoint (native Ollama or OpenAI-compatible)                           |
| `ollamaAgent.model`                   | `""`                              | Optional model override when discovery is unavailable                        |
| `ollamaAgent.chatFormat`              | `"auto"`                          | Optional Ollama `/api/chat` format hint (`peg-native` for custom servers)    |
| `ollamaAgent.temperature`             | `0.2`                             | Sampling temperature (0-2)                                                   |
| `ollamaAgent.useStreaming`            | `true`                            | Use streaming chat responses when the server supports them                   |
| `ollamaAgent.streamingStallTimeoutMs` | `60000`                           | Cancel stalled streaming requests after this many ms and retry non-streaming |
| `ollamaAgent.maxIterations`           | `8`                               | Maximum number of think-act iterations the agent can perform per request     |
| `ollamaAgent.mcpServers`              | `[]`                              | MCP servers configuration                                                    |

The extension first tries Ollama-native model discovery via `/api/tags`, then falls back to OpenAI-compatible discovery via `/v1/models`. If your server only exposes chat completions, set `ollamaAgent.model` manually.

If your server does not implement `/api/ps`, that is now treated as optional. The extension will use `/api/show` metadata to determine context size and continue normally.

If your server accepts `/api/chat` but returns a normal `application/json` body even when `stream` is set to `true`, the extension now detects that and reads the response as a buffered reply automatically.

If your server accepts `/api/chat` but does not finish streamed responses until the client disconnects, set `ollamaAgent.useStreaming` to `false`. The extension also retries non-streaming automatically when a stream produces no activity for `ollamaAgent.streamingStallTimeoutMs`.

When the extension detects that a specific endpoint is not actually streaming, it now caches that result for the current VS Code session and stops sending `stream: true` to that endpoint on later requests.

### Native Ollama-compatible server example

For a server like yours that exposes `/api/tags`, `/api/show`, and `/api/chat` but not `/v1` routes, configure:

```json
{
	"ollamaAgent.endpoint": "http://localhost:8080/api/chat",
	"ollamaAgent.chatFormat": "peg-native"
}
```

If your server uses a custom chat-format selector and logs `Chat format: peg-native`, set `ollamaAgent.chatFormat` to `peg-native` so the extension sends that format hint explicitly on `/api/chat` requests.

### OpenAI-compatible local server example

For a server like your `turbo-server` running on port `8080`, configure:

```json
{
	"ollamaAgent.endpoint": "http://localhost:8080/v1/chat/completions",
	"ollamaAgent.model": "Qwen3 Coder 30B A3B Instruct"
}
```

If `/v1/models` returns a different model ID, use that exact ID instead of the display name above.

### Example MCP Server Configuration

```json
{
	"ollamaAgent.mcpServers": [
		{
			"name": "filesystem",
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
			"enabled": true
		}
	]
}
```

### Playwright MCP server example

You can run a Playwright-based MCP server to enable browser automation tools. Example configuration (uses the hypothetical `@modelcontextprotocol/server-playwright` package):

```json
{
	"ollamaAgent.mcpServers": [
		{
			"name": "playwright",
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-playwright"],
			"enabled": true,
			"timeoutMs": 120000
		}
	]
}
```

Notes:

- `timeoutMs` increases the MCP request timeout for long-running browser actions.
- The extension writes binary or file outputs from MCP tools to `.ollama-agent/mcp_outputs` in the workspace.

## MCP Server Management & Debugging

- Add MCP server: The extension includes a command to add a Playwright (or other) MCP server configuration and will attempt to connect after adding it. If the connection fails the extension surfaces diagnostic information in the Output and Debug Consoles.
- Debug MCP tools: Use the `Ollama Agent: Debug MCP Tools` command to fetch registered tool details, endpoints, and capabilities from a connected MCP server.
- UI improvements: The MCP server management view now uses collapsible sections with improved styling for easier navigation and state visibility.

## Logging & Debug Forwarding

- Debug Console forwarding: Messages written to the extension OutputChannel are forwarded to the Debug Console to make interactive debugging and breakpoints easier to correlate with agent output.
- Startup configuration logging: Key configuration values (endpoint, enabled MCP servers, timeouts) are logged at startup to help with troubleshooting and reproducibility.

## Chat Improvements

- Resizable message area: The chat message input supports resizing so you can compose longer prompts comfortably.
- Last-prompt recall: The chat will remember and offer the last prompt for quick re-use or iteration when composing follow-ups.

## Usage

### Opening the Chat

- Click the **Ollama** icon in the Activity Bar
- Use the status bar button: `$(comment-discussion) Ollama Chat`
- Run the command: `Ollama Agent: Chat`

### Running a Task

1. Open the chat panel
2. Select a model discovered from Ollama in the dropdown
3. Type your request (e.g., "Create a React component for a todo list")
4. The agent will:
    - Analyze your request
    - Read existing files if needed
    - Create or modify files
    - Execute commands (build, test, etc.)
    - Provide a summary of actions taken

### Available Commands

| Command                             | Description                                                   |
| ----------------------------------- | ------------------------------------------------------------- |
| `Ollama Agent: Run`                 | Execute a one-off task via input box                          |
| `Ollama Agent: Chat`                | Open the sidebar chat panel                                   |
| `Ollama Agent: Scaffold MCP Server` | Generate a local MCP server starter and optionally connect it |

## Agent Capabilities

The agent can perform the following actions:

| Action                | Description                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| `read_file`           | Read any file in the workspace                                               |
| `create_file`         | Create new files                                                             |
| `edit_file`           | Modify existing files (full overwrite)                                       |
| `delete_file`         | Delete files (moves to trash)                                                |
| `run_command`         | Execute shell commands in workspace root                                     |
| `fetch_url`           | Fetch web content as readable text                                           |
| `list_mcp_servers`    | Inspect configured MCP servers and connection state                          |
| `list_mcp_tools`      | Inspect available MCP tools and argument schemas                             |
| `scaffold_mcp_server` | Create a local MCP server starter and optionally install/register/connect it |
| `upsert_mcp_server`   | Add or update an MCP server configuration and reconnect                      |
| `remove_mcp_server`   | Remove an MCP server configuration                                           |
| `reload_mcp_servers`  | Reload MCP settings and reconnect configured servers                         |
| `mcp_tool`            | Invoke tools from connected MCP servers                                      |

This lets the agent do two MCP-specific workflows that were previously unreliable:

- Use connected browser-capable MCP servers for navigation and online tasks instead of assuming browsing is unavailable.
- Create a new MCP server in the workspace, install/build it, register it in settings, and connect it without leaving the chat.

## Scaffold A Local MCP Server

Use the command `Ollama Agent: Scaffold MCP Server` to generate a local MCP server starter under `mcp-servers/<name>`.

The workflow can:

- scaffold a `basic` template with `echo` and `get_time` tools,
- scaffold a `web` template with `fetch_url` and `search_web` tools,
- run `npm install` in the generated folder,
- add the generated server to `ollamaAgent.mcpServers`, and
- attempt to connect it immediately.

## Supported Models

The extension works with any Ollama model that supports chat completions. Recommended models:

- `qwen2.5-coder:32b` (default) - Excellent for coding tasks
- `codellama:34b` - Good for code generation
- `deepseek-coder:33b` - Strong coding capabilities
- `llama3.1:70b` - General purpose with good reasoning

## Development

### Project Structure

```
ollama-agent/
├── src/
│   ├── extension.ts          # Main extension entry point
│   ├── agent/
│   │   ├── agent.ts          # Agent orchestration
│   │   ├── executor.ts       # Tool execution logic
│   │   ├── llm.ts            # LLM provider (Ollama)
│   │   ├── mcp.ts            # MCP server management
│   │   └── tools.ts          # Tool definitions and prompts
│   ├── utils/
│   │   └── workspace.ts      # Workspace utilities
│   └── test/
│       └── mockProvider.ts   # Test utilities
├── package.json              # Extension manifest
└── tsconfig.json             # TypeScript configuration
```

### Building

```bash
# Compile TypeScript
npm run compile

# Watch for changes
npm run watch

# Package for distribution
npm run package
```

### Debugging

1. Open the project in VS Code
2. Set breakpoints in the source code
3. Press `F5` to launch the Extension Development Host
4. Use the extension in the new window
5. Debugging output appears in the Debug Console

## Platform Support

The extension automatically adapts to your operating system:

| Platform | Shell      | Notes                   |
| -------- | ---------- | ----------------------- |
| Windows  | PowerShell | Uses PowerShell cmdlets |
| macOS    | zsh/bash   | Standard Unix commands  |
| Linux    | bash       | GNU coreutils           |

## Troubleshooting

### Ollama Connection Issues

1. Ensure Ollama is running: `ollama serve`
2. Verify the endpoint URL in settings
3. Check that the model is downloaded: `ollama list`

### OpenAI-Compatible Server Issues

1. Verify the server responds on `/v1/chat/completions`
2. If the model dropdown is empty, set `ollamaAgent.model` manually
3. If available, check whether `/v1/models` returns the model ID the server expects

### Model Not Responding

1. Check the Output panel (View → Output → Ollama Agent)
2. Verify the model appears in the Ollama model list
3. Try a different model if the current one hangs

### MCP Server Errors

1. Check the server command is installed and in PATH
2. Verify the arguments are correct
3. Check the Output panel for error messages

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

- [Ollama](https://ollama.com/) for making local LLMs accessible
- [Model Context Protocol](https://modelcontextprotocol.io/) for extending AI capabilities
