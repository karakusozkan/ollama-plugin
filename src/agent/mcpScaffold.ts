import * as cp from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { McpServerConfig } from "./mcp.js";

export type McpScaffoldTemplate = "basic" | "web";

export interface ScaffoldMcpServerOptions {
  name: string;
  template?: McpScaffoldTemplate;
  directory?: string;
  overwrite?: boolean;
}

export interface InstallMcpServerResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export interface ScaffoldMcpServerResult {
  name: string;
  slug: string;
  template: McpScaffoldTemplate;
  relativeDirectory: string;
  absoluteDirectory: string;
  files: string[];
  installCommand: string;
  serverConfig: McpServerConfig;
}

export async function scaffoldMcpServerFiles(options: ScaffoldMcpServerOptions): Promise<ScaffoldMcpServerResult> {
  const root = workspaceRoot();
  if (!root) {
    throw new Error("Open a workspace folder before scaffolding an MCP server.");
  }

  const trimmedName = options.name.trim();
  if (!trimmedName) {
    throw new Error("Server name is required.");
  }

  const slug = slugify(trimmedName);
  const template = options.template ?? "basic";
  const relativeDirectory = normalizeRelativeDirectory(options.directory || path.posix.join("mcp-servers", slug));
  const absoluteDirectory = path.join(root, ...relativeDirectory.split("/").filter(Boolean));

  const existingEntries = await readDirectoryEntries(absoluteDirectory);
  if (existingEntries.length > 0 && !options.overwrite) {
    throw new Error(`Target directory already exists and is not empty: ${relativeDirectory}`);
  }

  await fs.mkdir(absoluteDirectory, { recursive: true });

  const files = buildTemplateFiles(trimmedName, slug, template);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(absoluteDirectory, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  return {
    name: trimmedName,
    slug,
    template,
    relativeDirectory,
    absoluteDirectory,
    files: Object.keys(files).map((file) => `${relativeDirectory}/${file}`),
    installCommand: "npm install",
    serverConfig: {
      name: slug,
      command: "node",
      args: ["server.js"],
      cwd: absoluteDirectory,
      enabled: true,
      connectTimeoutMs: 120000,
      timeoutMs: 30000,
    },
  };
}

export async function installScaffoldDependencies(absoluteDirectory: string, timeoutMs = 120000): Promise<InstallMcpServerResult> {
  const command = "npm install";
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/c", command] : ["-lc", command];

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        command,
        exitCode,
        stdout,
        stderr,
        success: exitCode === 0,
      });
    };

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(shell, args, {
        cwd: absoluteDirectory,
        windowsHide: true,
      });
    } catch (err) {
      settle(1);
      return;
    }

    const timeout = setTimeout(() => {
      stderr += `${stderr ? "\n" : ""}Command timed out after ${timeoutMs}ms.`;
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      stderr += `${stderr ? "\n" : ""}${err.message}`;
      settle(1);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      settle(typeof code === "number" ? code : 1);
    });
  });
}

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "mcp-server";
}

function normalizeRelativeDirectory(value: string): string {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

  if (!normalized || normalized.includes("..")) {
    throw new Error("Directory must stay inside the workspace.");
  }

  return normalized;
}

async function readDirectoryEntries(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function buildTemplateFiles(name: string, slug: string, template: McpScaffoldTemplate): Record<string, string> {
  return {
    ".gitignore": "node_modules/\n",
    "package.json": buildPackageJson(slug),
    "README.md": buildReadme(name, slug, template),
    "server.js": template === "web" ? buildWebServerTemplate(name, slug) : buildBasicServerTemplate(name, slug),
  };
}

function buildPackageJson(slug: string): string {
  return `${JSON.stringify({
    name: `${slug}-mcp-server`,
    version: "0.0.1",
    private: true,
    type: "module",
    scripts: {
      start: "node server.js",
      dev: "node --watch server.js",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.0.0",
      zod: "^3.23.8",
    },
  }, null, 2)}\n`;
}

function buildReadme(name: string, slug: string, template: McpScaffoldTemplate): string {
  const tools = template === "web"
    ? "- fetch_url: Fetch a URL and return the response text\n- search_web: Query DuckDuckGo HTML and return the result page text"
    : "- echo: Return the text you pass in\n- get_time: Return the current ISO timestamp";

  return `# ${name}\n\nThis folder was scaffolded by Ollama Agent as a local MCP server starter.\n\n## Template\n\n${template}\n\n## Included Tools\n\n${tools}\n\n## Run Locally\n\n1. Install dependencies:\n\n   npm install\n\n2. Start the server:\n\n   npm start\n\n## Suggested Ollama Agent MCP Config\n\n- name: ${slug}\n- command: node\n- args: server.js\n- cwd: ${slug}\n\nThe extension can register this server automatically when you scaffold it through the built-in workflow.\n`;
}

function buildBasicServerTemplate(name: string, slug: string): string {
  return `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";\nimport { z } from "zod";\n\nconst server = new McpServer({\n  name: ${JSON.stringify(slug)},\n  version: "0.0.1",\n});\n\nserver.tool(\n  "echo",\n  "Echo text back to the caller.",\n  {\n    text: z.string().describe("Text to echo back."),\n  },\n  async ({ text }) => ({\n    content: [{ type: "text", text }],\n  })\n);\n\nserver.tool(\n  "get_time",\n  "Return the current time as an ISO timestamp.",\n  {},\n  async () => ({\n    content: [{ type: "text", text: new Date().toISOString() }],\n  })\n);\n\nconst transport = new StdioServerTransport();\nawait server.connect(transport);\nconsole.error(${JSON.stringify(`${name} MCP server is running on stdio.`)});\n`;
}

function buildWebServerTemplate(name: string, slug: string): string {
  return `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";\nimport { z } from "zod";\n\nconst server = new McpServer({\n  name: ${JSON.stringify(slug)},\n  version: "0.0.1",\n});\n\nfunction clip(text, maxChars = 20000) {\n  return text.length > maxChars ? text.slice(0, maxChars) + "\\n\\n[truncated]" : text;\n}\n\nserver.tool(\n  "fetch_url",\n  "Fetch a URL and return the response body as text.",\n  {\n    url: z.string().url().describe("URL to fetch."),\n    maxChars: z.number().int().positive().max(50000).optional().describe("Maximum characters to return."),\n  },\n  async ({ url, maxChars }) => {\n    const response = await fetch(url, {\n      headers: {\n        "user-agent": "ollama-agent-mcp-scaffold/0.0.1",\n      },\n    });\n    const body = await response.text();\n    return {\n      content: [{\n        type: "text",\n        text: [\n          "URL: " + url,\n          "Status: " + response.status + " " + response.statusText,\n          "Content-Type: " + (response.headers.get("content-type") || "unknown"),\n          "",\n          clip(body, maxChars ?? 20000),\n        ].join("\\n"),\n      }],\n    };\n  }\n);\n\nserver.tool(\n  "search_web",\n  "Search DuckDuckGo HTML and return the result page text.",\n  {\n    query: z.string().min(1).describe("Search query."),\n    maxChars: z.number().int().positive().max(50000).optional().describe("Maximum characters to return."),\n  },\n  async ({ query, maxChars }) => {\n    const url = "https://duckduckgo.com/html/?q=" + encodeURIComponent(query);\n    const response = await fetch(url, {\n      headers: {\n        "user-agent": "ollama-agent-mcp-scaffold/0.0.1",\n      },\n    });\n    const body = await response.text();\n    return {\n      content: [{\n        type: "text",\n        text: [\n          "Query: " + query,\n          "Status: " + response.status + " " + response.statusText,\n          "",\n          clip(body, maxChars ?? 20000),\n        ].join("\\n"),\n      }],\n    };\n  }\n);\n\nconst transport = new StdioServerTransport();\nawait server.connect(transport);\nconsole.error(${JSON.stringify(`${name} MCP server is running on stdio.`)});\n`;
}