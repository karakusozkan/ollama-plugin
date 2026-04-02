import { McpManager } from "./mcp.js";

/**
 * Every action the agent is allowed to take must be listed here.
 * The discriminated union enforces full type safety throughout the pipeline.
 */
export type ToolAction =
  | { tool: "edit_file"; path: string; content: string }
  | { tool: "create_file"; path: string; content: string }
  | { tool: "delete_file"; path: string }
  | { tool: "read_file"; path: string }
  | { tool: "list_workspace_files"; limit?: number }
  | { tool: "run_command"; command: string }
  | { tool: "fetch_url"; url: string }
  | { tool: "parse_content"; html: string }
  | { tool: "list_mcp_servers" }
  | { tool: "list_mcp_tools"; server?: string; includeDisabled?: boolean }
  | { tool: "mcp_tool"; server: string; name: string; arguments: Record<string, unknown> };

/*
 * High-level web search action. The executor will try to use a connected
 * Playwright (or other browser-capable) MCP server if available. If no
 * suitable MCP server or browser tools are found, the executor falls back
 * to a direct 'fetch_url' request to perform the search.
 */
export type WebSearchAction = { tool: "web_search"; query: string; server?: string; engine?: "google" | "bing" | "duckduckgo" };

// Append to ToolAction union
export type ExtendedToolAction = ToolAction | WebSearchAction;

type LegacyActionShape = {
  action?: string;
  tool?: string;
  [key: string]: unknown;
};

export function normalizeToolActions(actions: unknown): ExtendedToolAction[] {
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions
    .filter((item): item is LegacyActionShape => typeof item === "object" && item !== null)
    .map((item) => {
      if (!item.tool && typeof item.action === "string") {
        return {
          ...item,
          tool: item.action,
        } as ExtendedToolAction;
      }

      return item as ExtendedToolAction;
    });
}

/**
 * Detect the current operating system and return a descriptor string.
 */
function getOSDescriptor(): { name: string; shell: string; commandGuidance: string } {
  const platform = process.platform;
  switch (platform) {
    case "win32":
      return {
        name: "Windows",
        shell: "PowerShell",
        commandGuidance: `## OS-Specific Command Rules (Windows / PowerShell)
You are running on **Windows** with **PowerShell** as the shell.
You MUST use PowerShell-compatible commands. NEVER use POSIX/Unix commands.

| Task                  | ❌ Do NOT use (Unix)         | ✅ Use instead (PowerShell)                        |
|-----------------------|-----------------------------|----------------------------------------------------|
| List files            | ls, find                    | Get-ChildItem, Get-ChildItem -Recurse              |
| Read file             | cat                         | Get-Content                                        |
| Write file            | echo > file                 | Set-Content, Out-File                              |
| Delete file           | rm                          | Remove-Item                                        |
| Copy file             | cp                          | Copy-Item                                          |
| Move file             | mv                          | Move-Item                                          |
| Search in files       | grep                        | Select-String                                      |
| Count lines           | wc -l                       | (Get-Content file).Count  or  Measure-Object -Line |
| Current directory     | pwd                         | Get-Location (or pwd alias works)                  |
| Environment variable  | $VAR or export VAR=         | $env:VAR                                           |
| Chain commands        | cmd1 && cmd2                | cmd1; cmd2  (or use -and)                          |
| Pipe + filter         | cmd \\| grep pattern         | cmd \\| Select-String pattern                       |
| Process list          | ps aux                      | Get-Process                                        |
| Create directory      | mkdir -p                    | New-Item -ItemType Directory -Force                |
| Download file         | curl, wget                  | Invoke-WebRequest -Uri URL -OutFile path           |
| Text replacement      | sed                         | (Get-Content f) -replace 'old','new' \\| Set-Content f |
| File permissions      | chmod                       | icacls (or not needed)                             |
| Which/where binary    | which                       | Get-Command                                        |

Additional notes:
- Use semicolons (;) to chain commands, NOT && or ||.
- Use backtick (\`) for line continuation, NOT backslash (\\).
- Paths use backslashes (\\) but forward slashes (/) also work in most cases.
- npm, node, git, python, and other cross-platform CLI tools work normally.`,
      };
    case "darwin":
      return {
        name: "macOS",
        shell: "zsh/bash",
        commandGuidance: `## OS-Specific Command Rules (macOS / zsh)
You are running on **macOS** with **zsh** (or bash) as the shell.
Use standard Unix/POSIX commands. Do NOT use PowerShell cmdlets.

Additional notes:
- Use && to chain commands.
- Use backslash (\\) for line continuation.
- Paths use forward slashes (/).
- macOS uses BSD variants of commands (e.g. sed -i '' instead of sed -i).
- Homebrew (brew) is the common package manager.`,
      };
    default:
      return {
        name: "Linux",
        shell: "bash",
        commandGuidance: `## OS-Specific Command Rules (Linux / bash)
You are running on **Linux** with **bash** as the shell.
Use standard Unix/POSIX commands. Do NOT use PowerShell cmdlets.

Additional notes:
- Use && to chain commands.
- Use backslash (\\) for line continuation.
- Paths use forward slashes (/).
- GNU coreutils are available (e.g. sed -i works without extra argument).`,
      };
  }
}

/**
 * The JSON schema the model must follow (embedded in the system prompt so
 * even models that don't support native tool-calling still work).
 *
 * This is a function (not a constant) so it can inject the current OS
 * information at runtime, ensuring the LLM always generates commands
 * appropriate for the host operating system.
 */
export function buildSystemPrompt(mcpManager?: McpManager): string {
  const os = getOSDescriptor();
  return `\
You are an expert coding agent embedded inside VS Code.
You have FULL READ AND WRITE ACCESS to every file in the user's open workspace,
and you can execute shell commands in the workspace root directory.

**Operating System: ${os.name}  |  Shell: ${os.shell}**

## Rules
1. Respond ONLY with valid JSON — no prose, no markdown fences, no code blocks.
2. Every response must exactly match the schema below.
2.1. Every entry in "actions" MUST use the field name "tool". Never use "action" as the field name.
3. All file paths are relative to the workspace root (e.g. "src/index.ts", ".eslintrc.json").
  Never use absolute paths or path traversal (../).
4. Before editing an EXISTING file you MUST read it first with "read_file" so you
  have the current contents. Never guess what a file contains.
5. For "edit_file" supply the COMPLETE new file content — not a diff or partial snippet.
6. You may act on any file in the workspace: source, config, dotfiles, markdown, JSON, etc.
7. Use "run_command" to build, test, install, lint, or inspect the project.
  The command runs in the workspace root with stdout + stderr returned to you.
  **CRITICAL: You MUST use commands compatible with ${os.name} / ${os.shell}.**
  See the OS-Specific Command Rules section below.
8. IMPORTANT: Keep working until the task is FULLY complete. Do NOT stop early.
  - If a tool result shows the task is not done, take more actions to complete it.
  - If you encounter an obstacle, try a different approach.
  - Only return an empty "actions" array when the goal is truly achieved.
9. If the user is just chatting, greeting you, or asking a question that
  doesn't require file operations or commands, respond with an empty "actions" array
  and put your conversational response in "thought". Do NOT read files or run commands
  unless the user explicitly asks you to do something with their code or project.
10. The workspace file list and MCP tool inventory are NOT preloaded into this prompt.
  - If you need a workspace overview, call "list_workspace_files".
  - If you need to know which MCP servers or MCP tools are available, call "list_mcp_servers" and/or "list_mcp_tools" first.
    - If "list_mcp_tools" returns no tools, the reason may be that: the named server is not configured, the server is configured but not connected, the server reported zero tools, or tools are present but disabled/filtered. In that case, check server connection with "list_mcp_servers", try "list_mcp_tools" with "includeDisabled": true, or run the Debug MCP Tools command to fetch raw tool definitions.
  - Before calling "mcp_tool", make sure you know the exact server name, tool name, and expected arguments.

## Available Tools
| Tool          | Fields            | Description                                                        |
|---------------|-------------------|--------------------------------------------------------------------|
| read_file     | path              | Read any file — always do this before editing                      |
| list_workspace_files | limit        | List workspace files on demand instead of assuming a file inventory |
| create_file   | path, content     | Create a new file (fails if it already exists)                     |
| edit_file     | path, content     | Overwrite an existing file with full new content                   |
| delete_file   | path              | Delete a file (moves to OS trash)                                  |
| run_command   | command           | Run a shell command in the workspace root directory                |
| fetch_url     | url               | Fetch a URL and return its content as clean readable text (large pages are automatically truncated) |
| list_mcp_servers | none           | List configured MCP servers and their current connection status    |
| list_mcp_tools | server, includeDisabled | List MCP tools on demand instead of assuming a tool inventory |
| mcp_tool      | server, name, arguments | Call a specific MCP tool once you know its exact schema     |

${os.commandGuidance}

## Workflow for web content
When the user asks about web content (for example: "Search Google for X" or "Find MCP servers for Postgres"):
1. Do NOT respond by saying you cannot browse. Instead, try to perform the requested web search.
2. First call 'list_mcp_servers' and 'list_mcp_tools' as needed to discover available MCP servers and tools.
  - If a browser-capable MCP server is available (e.g. Playwright, or any server exposing 'navigate', 'goto', 'page.*', 'browser_navigate', 'screenshot', or 'evaluate'-style tools), call those tools via the 'mcp_tool' action to navigate to the search engine and extract page text or screenshots.
  - Prefer using the high-level 'web_search' action when available; set 'engine' to 'google' and supply the 'query' field. The executor will attempt a browser-based search first and fall back to 'fetch_url'.
3. If no suitable MCP browser tools are available, fall back to 'fetch_url' on the search results page (e.g. 'https://www.google.com/search?q=...') and then parse the returned HTML to readable text.
4. After obtaining the page text or extracted content, include the summarized search results in 'thought' and return an empty 'actions' array. Do not return a refusal or a statement that browsing is impossible.
5. Do NOT fetch individual paywalled article URLs; instead use the search results snippets and the front page summary content.
6. NEVER fetch the same exact URL twice in the same run.

## Response Schema
{
  "thought": "<your reasoning, explanation, or answer to the user>",
  "actions": [
    {
      "tool": "read_file",
      "path": "package.json"
    }
  ]
}

Note: when the agent has finished the task it should return an empty "actions" array and place the final answer in the "thought" field.
`;
}

/** @deprecated Use buildSystemPrompt() instead — kept for backward compatibility */
export const SYSTEM_PROMPT = buildSystemPrompt();
