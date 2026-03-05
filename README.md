# Ollama Agent

An AI coding agent VS Code extension powered by Ollama running locally. This extension provides an intelligent coding assistant that can read, write, and modify files in your workspace, execute shell commands, fetch web content, and integrate with MCP (Model Context Protocol) servers for extended functionality.

![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

## Features

- 🤖 **AI-Powered Coding Assistant**: Leverages local LLMs via Ollama for code generation, refactoring, and analysis
- 💬 **Interactive Chat Interface**: Sidebar chat panel with conversation history and context management
- 🛠️ **File Operations**: Read, create, edit, and delete files in your workspace
- ⚡ **Command Execution**: Run shell commands directly from the agent (PowerShell on Windows, bash/zsh on macOS/Linux)
- 🌐 **Web Fetching**: Retrieve and analyze web content
- 🔌 **MCP Server Support**: Extend capabilities with Model Context Protocol servers
- 🔄 **Streaming Responses**: Real-time response streaming with stop capability
- 📊 **Context Window Tracking**: Monitor token usage and remaining context

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

| Setting                   | Default                                      | Description                             |
| ------------------------- | -------------------------------------------- | --------------------------------------- |
| `ollamaAgent.endpoint`    | `http://localhost:11435/v1/chat/completions` | Ollama API endpoint (OpenAI-compatible) |
| `ollamaAgent.model`       | `qwen2.5-coder:32b`                          | Model name to use for the agent         |
| `ollamaAgent.temperature` | `0.2`                                        | Sampling temperature (0-2)              |
| `ollamaAgent.mcpServers`  | `[]`                                         | MCP servers configuration               |

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

## Usage

### Opening the Chat

- Click the **Ollama** icon in the Activity Bar
- Use the status bar button: `$(comment-discussion) Ollama Chat`
- Run the command: `Ollama Agent: Chat`

### Running a Task

1. Open the chat panel
2. Select your desired model from the dropdown
3. Type your request (e.g., "Create a React component for a todo list")
4. The agent will:
    - Analyze your request
    - Read existing files if needed
    - Create or modify files
    - Execute commands (build, test, etc.)
    - Provide a summary of actions taken

### Available Commands

| Command              | Description                          |
| -------------------- | ------------------------------------ |
| `Ollama Agent: Run`  | Execute a one-off task via input box |
| `Ollama Agent: Chat` | Open the sidebar chat panel          |

## Agent Capabilities

The agent can perform the following actions:

| Action        | Description                              |
| ------------- | ---------------------------------------- |
| `read_file`   | Read any file in the workspace           |
| `create_file` | Create new files                         |
| `edit_file`   | Modify existing files (full overwrite)   |
| `delete_file` | Delete files (moves to trash)            |
| `run_command` | Execute shell commands in workspace root |
| `fetch_url`   | Fetch web content as readable text       |
| `mcp_tool`    | Invoke tools from connected MCP servers  |

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

### Model Not Responding

1. Check the Output panel (View → Output → Ollama Agent)
2. Verify the model name is correct
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
