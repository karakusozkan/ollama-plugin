import * as cp from "child_process";
import * as path from "path";
import { promises as fs } from "fs";
import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import { ToolAction, ExtendedToolAction } from "./tools";
import { McpManager } from "./mcp.js";
import { installScaffoldDependencies, scaffoldMcpServerFiles } from "./mcpScaffold.js";
import { listWorkspaceFiles } from "../utils/workspace.js";

export interface ActionResult {
	action: ExtendedToolAction;
	success: boolean;
 	output?: string; // non-empty for read_file or errors
}

//

export async function executeActions(actions: ExtendedToolAction[], abortSignal?: AbortSignal, mcpManager?: McpManager): Promise<ActionResult[]> {
	const results: ActionResult[] = [];
	for (const action of actions) {
		if (abortSignal?.aborted) {
			results.push({ action, success: false, output: "Operation cancelled by user." });
			break;
		}
		results.push(await executeOne(action, abortSignal, mcpManager));
	}
	return results;
}

async function executeOne(action: ExtendedToolAction, abortSignal?: AbortSignal, mcpManager?: McpManager): Promise<ActionResult> {
	try {
		switch (action.tool) {
			case "create_file": {
				const uri = resolveUri(action.path);
				const createEdit = new vscode.WorkspaceEdit();
				createEdit.createFile(uri, { ignoreIfExists: true, overwrite: false });
				await vscode.workspace.applyEdit(createEdit);
				const doc = await openOrCreate(uri);
				// Open the file in the editor so the user can see it being created
				await vscode.window.showTextDocument(doc, {
					preview: false,
					preserveFocus: true,
					viewColumn: vscode.ViewColumn.One,
				});
				const insertEdit = new vscode.WorkspaceEdit();
				insertEdit.insert(uri, new vscode.Position(0, 0), action.content);
				await vscode.workspace.applyEdit(insertEdit);
				await doc.save();
				return { action, success: true };
			}
	
			case "edit_file": {
				const uri = resolveUri(action.path);
				const doc = await openOrCreate(uri);
				// Open the file in the editor so the user can see it being edited
				await vscode.window.showTextDocument(doc, {
					preview: false,
					preserveFocus: true,
					viewColumn: vscode.ViewColumn.One,
				});
				const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
				const edit = new vscode.WorkspaceEdit();
				edit.replace(uri, fullRange, action.content);
				await vscode.workspace.applyEdit(edit);
				await doc.save();
				return { action, success: true };
			}

			case "delete_file": {
				const uri = resolveUri(action.path);
				await vscode.workspace.fs.delete(uri, { useTrash: true });
				return { action, success: true };
			}

			case "read_file": {
				const uri = resolveUri(action.path);
				const bytes = await vscode.workspace.fs.readFile(uri);
				const content = Buffer.from(bytes).toString("utf-8");
				return { action, success: true, output: content };
			}

			case "list_workspace_files": {
				const listAction = action as { tool: "list_workspace_files"; limit?: number };
				const requestedLimit = typeof listAction.limit === "number" ? Math.floor(listAction.limit) : 200;
				const limit = Math.max(1, Math.min(1000, requestedLimit || 200));
				const files = await listWorkspaceFiles(limit);
				return {
					action,
					success: true,
					output: JSON.stringify({ files, count: files.length, limit }, null, 2),
				};
			}

			case "run_command": {
				if (!("command" in action)) return { action, success: false, output: "run_command: missing command field." };
				const command = (action as any).command as string;
				const workspaceFolders = vscode.workspace.workspaceFolders;
				const cwd = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : workspaceRoot() || process.cwd();
				const { exitCode, stdout, stderr } = await runCommand(command, cwd, 60_000, abortSignal);
				const output = [stdout.trim() ? `stdout:\n${stdout.trim()}` : "", stderr.trim() ? `stderr:\n${stderr.trim()}` : "", `exit code: ${exitCode}`]
					.filter(Boolean)
					.join("\n\n");
				return { action, success: exitCode === 0, output };
			}

			case "fetch_url": {
				if (!("url" in action)) return { action, success: false, output: "fetch_url: missing url field." };
				const url = (action as any).url as string;
				try {
					const html = await fetchUrl(url, 30_000, abortSignal);
					// Automatically parse HTML to readable text so the LLM can process it
					const text = parseHtmlToText(html);
					return { action, success: true, output: text };
				} catch (err) {
					return { action, success: false, output: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}` };
				}
			}

			case "parse_content": {
				if (!("html" in action)) return { action, success: false, output: "parse_content: missing html field." };
				const html = (action as any).html as string;
				try {
					const text = parseHtmlToText(html);
					return { action, success: true, output: text };
				} catch (err) {
					return { action, success: false, output: `Failed to parse HTML: ${err instanceof Error ? err.message : String(err)}` };
				}
			}

			case "list_mcp_servers": {
				if (!mcpManager) {
					return { action, success: true, output: "No MCP servers are configured." };
				}

				const servers = mcpManager.getServerSummaries();
				if (servers.length === 0) {
					return { action, success: true, output: "No MCP servers are configured." };
				}

				const output = JSON.stringify({ servers }, null, 2);
				return { action, success: true, output };
			}

			case "list_mcp_tools": {
				if (!mcpManager) {
					return { action, success: true, output: "No MCP servers are configured." };
				}

				const listAction = action as { tool: "list_mcp_tools"; server?: string; includeDisabled?: boolean };
				const tools = mcpManager.getToolSummaries(listAction.server, listAction.includeDisabled ?? false);
				if (tools.length === 0) {
					// Provide more actionable diagnostics so the LLM or user understands why no tools were listed.
					if (listAction.server) {
						const serverSummary = mcpManager.getServerSummaries().find(s => s.name === listAction.server);
						if (!serverSummary) {
							return { action, success: true, output: `No MCP server named "${listAction.server}" is configured.` };
						}
						if (!serverSummary.connected) {
							return {
								action,
								success: true,
								output: `MCP server "${listAction.server}" is configured but not connected. It may have failed to start or be stopped. Check the 'Ollama Agent' output channel or run the Debug MCP Tools command for details.`,
							};
						}

						// Server exists and is connected but returned no tools (or they are filtered out)
						return {
							action,
							success: true,
							output: `No MCP tools are currently available for server "${listAction.server}". This may mean the server reported zero tools, or tools are present but disabled/filtered. To include disabled tools, call list_mcp_tools with \"includeDisabled\": true, or run the Debug MCP Tools command to fetch raw tool definitions.`,
						};
					}

					// No server was specified and there are no tools across connected servers.
					return {
						action,
						success: true,
						output: `No MCP tools are currently available. This may mean no connected servers exposed tools, or all tools are disabled. Run list_mcp_servers to inspect server connection status or call list_mcp_tools with \"includeDisabled\": true to see disabled tools.`,
					};
				}

				const output = JSON.stringify({ tools }, null, 2);
				return { action, success: true, output };
			}

			case "scaffold_mcp_server": {
				const scaffoldAction = action as {
					tool: "scaffold_mcp_server";
					name?: string;
					template?: "basic" | "web";
					directory?: string;
					install?: boolean;
					register?: boolean;
					connect?: boolean;
					overwrite?: boolean;
				};

				if (!scaffoldAction.name) {
					return { action, success: false, output: "scaffold_mcp_server: missing name field." };
				}

				try {
					const scaffoldResult = await scaffoldMcpServerFiles({
						name: scaffoldAction.name,
						template: scaffoldAction.template,
						directory: scaffoldAction.directory,
						overwrite: scaffoldAction.overwrite,
					});

					const shouldInstall = scaffoldAction.install ?? true;
					const shouldRegister = scaffoldAction.register ?? true;
					const shouldConnect = scaffoldAction.connect ?? shouldRegister;

					let installResult: Awaited<ReturnType<typeof installScaffoldDependencies>> | undefined;
					if (shouldInstall) {
						installResult = await installScaffoldDependencies(scaffoldResult.absoluteDirectory);
						if (!installResult.success) {
							return {
								action,
								success: false,
								output: JSON.stringify({ scaffoldResult, installResult }, null, 2),
							};
						}
					}

					let registrationResult: unknown;
					if (shouldRegister) {
						if (!mcpManager) {
							return {
								action,
								success: false,
								output: JSON.stringify({
									scaffoldResult,
									installResult,
									error: "MCP manager is not available for registration.",
								}, null, 2),
							};
						}

						registrationResult = await mcpManager.upsertServerConfig(
							scaffoldResult.serverConfig,
							shouldConnect && (installResult?.success ?? true)
						);
					}

					return {
						action,
						success: true,
						output: JSON.stringify({ scaffoldResult, installResult, registrationResult }, null, 2),
					};
				} catch (err) {
					return { action, success: false, output: `Failed to scaffold MCP server: ${err instanceof Error ? err.message : String(err)}` };
				}
			}

			case "upsert_mcp_server": {
				if (!mcpManager) {
					return { action, success: false, output: "MCP manager is not available." };
				}

				const configAction = action as {
					tool: "upsert_mcp_server";
					config?: {
						name?: string;
						command?: string;
						args?: string[];
						env?: Record<string, string>;
						cwd?: string;
						enabled?: boolean;
						transport?: "stdio" | "tcp";
						host?: string;
						port?: number;
						timeoutMs?: number;
						connectTimeoutMs?: number;
					};
					connect?: boolean;
				};

				if (!configAction.config?.name || !configAction.config?.command) {
					return { action, success: false, output: 'upsert_mcp_server: missing config.name or config.command.' };
				}

				try {
					const result = await mcpManager.upsertServerConfig({
						...configAction.config,
						name: configAction.config.name,
						command: configAction.config.command,
					}, configAction.connect !== false);
					return { action, success: result.connected || !result.reloaded, output: JSON.stringify(result, null, 2) };
				} catch (err) {
					return { action, success: false, output: `Failed to save MCP server: ${err instanceof Error ? err.message : String(err)}` };
				}
			}

			case "remove_mcp_server": {
				if (!mcpManager) {
					return { action, success: false, output: "MCP manager is not available." };
				}

				const removeAction = action as { tool: "remove_mcp_server"; name?: string };
				if (!removeAction.name) {
					return { action, success: false, output: "remove_mcp_server: missing name field." };
				}

				try {
					const result = await mcpManager.removeServerConfig(removeAction.name, true);
					return { action, success: result.removed ?? false, output: JSON.stringify(result, null, 2) };
				} catch (err) {
					return { action, success: false, output: `Failed to remove MCP server: ${err instanceof Error ? err.message : String(err)}` };
				}
			}

			case "reload_mcp_servers": {
				if (!mcpManager) {
					return { action, success: false, output: "MCP manager is not available." };
				}

				try {
					const result = await mcpManager.reloadServers();
					return { action, success: true, output: JSON.stringify(result, null, 2) };
				} catch (err) {
					return { action, success: false, output: `Failed to reload MCP servers: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
	
			case "mcp_tool": {
				if (!mcpManager) {
					return { action, success: false, output: "MCP tools are not available — no MCP servers are configured." };
				}
				const mcpAction = action as { tool: "mcp_tool"; server: string; name: string; arguments: Record<string, unknown> };
				if (!mcpAction.server || !mcpAction.name) {
					return { action, success: false, output: "mcp_tool: missing 'server' or 'name' field." };
				}
				try {
					const result = await mcpManager.callTool(mcpAction.server, mcpAction.name, mcpAction.arguments || {});
					// Handle various content parts: text, data (base64), json
					const contents = (result && (result as any).content) || [];
					const textParts: string[] = [];
					const savedFiles: string[] = [];
					const outDir = workspaceRoot() ? path.join(workspaceRoot()!, ".ollama-agent", "mcp_outputs") : undefined;
					if (outDir) await fs.mkdir(outDir, { recursive: true });
					let idx = 0;
					for (const c of contents) {
						if (!c) continue;
						const type = (c.type || "").toString();
						if (type === "text" && c.text) {
							textParts.push(c.text);
							continue;
						}
						if (c.data) {
							// Save base64-encoded data to workspace .ollama-agent/mcp_outputs
							const mime = (c.mimeType || "").toString().toLowerCase();
							const extMap: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "application/json": "json", "text/plain": "txt", "text/html": "html" };
							let ext = "bin";
							for (const k of Object.keys(extMap)) {
								if (mime.startsWith(k)) {
									ext = extMap[k];
									break;
								}
							}
							const fileName = `mcp_${mcpAction.server}_${mcpAction.name}_${idx}.${ext}`;
							const filePath = outDir ? path.join(outDir, fileName) : fileName;
							const buffer = Buffer.from(String(c.data), "base64");
							if (outDir) await fs.writeFile(filePath, buffer);
							savedFiles.push(filePath);
							// If JSON mime, try to parse and include in textParts
							if (mime === "application/json") {
								try {
									const parsed = JSON.parse(buffer.toString("utf8"));
									textParts.push(JSON.stringify(parsed, null, 2));
								} catch {
									textParts.push(buffer.toString("utf8"));
								}
							}
							idx++;
							continue;
						}
						// Some servers may return JSON in a 'json' or 'data' field
						if (type === "json" && c.data) {
							try {
								textParts.push(JSON.stringify(JSON.parse(String(c.data)), null, 2));
							} catch {
								textParts.push(String(c.data));
							}
						}
					}
					const outputParts: string[] = [];
					if (textParts.length) outputParts.push(textParts.join("\n"));
					if (savedFiles.length) outputParts.push(`Saved files:\n${savedFiles.join("\n")}`);
					const output = outputParts.join("\n\n") || "(no text content returned)";
					return { action, success: !(result as any).isError, output };
				} catch (err) {
					return { action, success: false, output: `MCP tool error: ${err instanceof Error ? err.message : String(err)}` };
				}
			}

			case "web_search": {
				const webAction = action as any as { tool: "web_search"; query: string; server?: string; engine?: string };
				const query = webAction.query;
				const engine = (webAction.engine as string) || "google";
				const buildSearchUrl = (q: string) => {
					if (engine === "bing") return `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
					if (engine === "duckduckgo") return `https://duckduckgo.com/html?q=${encodeURIComponent(q)}`;
					// default: google
					return `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`;
				};
				const url = buildSearchUrl(query);
				// Try to use a browser-capable MCP server if available
				if (mcpManager) {
					const allTools = mcpManager.getAllTools();
					// Prefer a server that exposes navigation-like tools
					const navCandidates = allTools.filter(t => /navigate|goto|open|page\.go|page\.goto|browser_navigate|browser.goto/i.test(t.tool.name));
					const evalCandidates = allTools.filter(t => /evaluate|extract|query|screenshot|innerText|text|content|page_eval|page.evaluate/i.test(t.tool.name));
					let usedServer: string | undefined;
					let navToolName: string | undefined;
					let evalToolName: string | undefined;
					if (webAction.server) {
						usedServer = webAction.server;
						const serverTools = allTools.filter(t => t.serverName === usedServer).map(t => t.tool.name);
						navToolName = serverTools.find(n => /navigate|goto|open|page\.go|page\.goto|browser_navigate|browser.goto/i.test(n));
						evalToolName = serverTools.find(n => /evaluate|extract|query|screenshot|innerText|text|content|page_eval|page.evaluate/i.test(n));
					} else if (navCandidates.length > 0) {
						navToolName = navCandidates[0].tool.name;
						usedServer = navCandidates[0].serverName;
						// try to find an eval tool on the same server
						evalToolName = evalCandidates.find(e => e.serverName === usedServer)?.tool.name;
					} else if (allTools.length > 0) {
						// Try any browser-like tool across servers
						const anyBrowser = allTools.find(t => /browser|page|tab|playwright|chromium|firefox|webkit/i.test(t.tool.name));
						if (anyBrowser) {
							usedServer = anyBrowser.serverName;
							navToolName = anyBrowser.tool.name;
							evalToolName = evalCandidates.find(e => e.serverName === usedServer)?.tool.name;
						}
					}

					if (usedServer && navToolName) {
						try {
							// Navigate to Google search URL
							await mcpManager.callTool(usedServer, navToolName, { url });
							// If we have an eval tool, try a few common argument shapes to extract text
							let evalResult: any = null;
							if (evalToolName) {
								const trials = [
									{ selector: "body" },
									{ script: "return document.body.innerText" },
									{},
								];
								for (const args of trials) {
									try {
										evalResult = await mcpManager.callTool(usedServer, evalToolName, args as Record<string, unknown>);
										if (evalResult && Array.isArray((evalResult as any).content) && (evalResult as any).content.length > 0) break;
									} catch {
									// ignore trial failure and continue
									continue;
								}
								}
							}
							// If we got evalResult, reuse mcp_tool processing to produce output
							if (evalResult && (evalResult as any).content) {
								const contents = (evalResult as any).content as any[];
								const textParts: string[] = [];
								for (const c of contents) {
									if (!c) continue;
									if ((c.type || "").toString() === "text" && c.text) {
										textParts.push(c.text);
										continue;
									}
									if (c.data) {
										try {
											const parsed = JSON.parse(String(c.data));
											textParts.push(JSON.stringify(parsed, null, 2));
										} catch {
										textParts.push(String(c.data));
									}
									}
								}
								const output = textParts.join("\n\n") || "(no text content returned)";
								return { action, success: true, output };
							}
							// If eval failed, fall back to direct fetch
						} catch (err) {
							// fall through to fallback
						}
					}
				}
				// Fallback: use fetchUrl to perform the search and parse text
				try {
					const html = await fetchUrl(url, 30000, abortSignal);
					const text = parseHtmlToText(html);
					return { action, success: true, output: text };
				} catch (err) {
					return { action, success: false, output: `Web search failed: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
		}
	} catch (err) {
		return { action, success: false, output: err instanceof Error ? err.message : String(err) };
	}
	return { action, success: false, output: "Unsupported action." };
}

function workspaceRoot(): string | undefined {
	const folders = vscode.workspace.workspaceFolders;
	return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/**
 * Map of POSIX commands to their PowerShell equivalents, used to provide
 * actionable error messages when the LLM generates the wrong command type.
 */
const POSIX_TO_POWERSHELL: Record<string, string> = {
	"find": "Get-ChildItem -Recurse",
	"wc": "Measure-Object -Line",
	"grep": "Select-String",
	"ls": "Get-ChildItem",
	"sed": "(Get-Content file) -replace 'old','new' | Set-Content file",
	"awk": "ForEach-Object with -split",
	"chmod": "icacls",
	"chown": "icacls",
	"xargs": "ForEach-Object",
	"which": "Get-Command",
	"du": "Get-ChildItem -Recurse | Measure-Object -Property Length -Sum",
	"cat": "Get-Content",
	"rm": "Remove-Item",
	"cp": "Copy-Item",
	"mv": "Move-Item",
	"mkdir -p": "New-Item -ItemType Directory -Force",
	"touch": "New-Item -ItemType File",
	"curl": "Invoke-WebRequest",
	"wget": "Invoke-WebRequest",
	"head": "Get-Content -TotalCount",
	"tail": "Get-Content -Tail",
	"pwd": "Get-Location",
	"echo": "Write-Output",
	"ps": "Get-Process",
	"kill": "Stop-Process",
};

function looksLikePosixCommand(command: string): { detected: boolean; matches: string[] } {
	const posixTokens = ["find", "wc", "grep", "ls", "sed", "awk", "chmod", "chown", "xargs", "which", "du", "cat", "rm", "cp", "mv", "touch", "curl", "wget", "head", "tail", "ps", "kill"];
	const matches: string[] = [];
	for (const token of posixTokens) {
		if (new RegExp(`\\b${token}\\b`).test(command)) {
			matches.push(token);
		}
	}
	// Also detect Unix-specific syntax like pipes with grep, semicolons for chaining
	const hasPipe = /\|\s*(grep|awk|sed|wc|head|tail|sort|uniq|cut|tr)\b/.test(command);
	if (hasPipe && matches.length === 0) {
		matches.push("pipe-to-unix-tool");
	}
	return { detected: matches.length > 0, matches };
}

function looksLikePowerShellCommand(command: string): boolean {
	const tokens = ["Get-ChildItem", "Measure-Object", "Select-String", "Out-File", "Set-Content", "Get-Content", "Remove-Item", "Copy-Item", "Move-Item", "New-Item", "Invoke-WebRequest", "Get-Command", "Get-Process", "Stop-Process", "Write-Output", "ForEach-Object", "Where-Object", "-Recurse", "-Force"];
	return new RegExp(tokens.join("|"), "i").test(command);
}

function buildPosixErrorMessage(matches: string[]): string {
	const suggestions = matches
		.filter(m => m in POSIX_TO_POWERSHELL)
		.map(m => `  "${m}" → use "${POSIX_TO_POWERSHELL[m]}" instead`)
		.join("\n");
	return [
		"ERROR: Detected POSIX/Unix command(s) on Windows. This will not work.",
		"You MUST use PowerShell-compatible commands on this system.",
		suggestions ? `Suggested replacements:\n${suggestions}` : "",
		"Please retry with the correct PowerShell command.",
	].filter(Boolean).join("\n");
}

function runCommand(command: string, cwd: string, timeoutMs = 60_000, abortSignal?: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const posixCheck = looksLikePosixCommand(command);
	const isPs = looksLikePowerShellCommand(command);

	if (abortSignal?.aborted) {
		return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Operation cancelled by user." });
	}

	if (process.platform === "win32" && posixCheck.detected && !isPs) {
		return Promise.resolve({ exitCode: 1, stdout: "", stderr: buildPosixErrorMessage(posixCheck.matches) });
	}
	if (process.platform !== "win32" && isPs) {
		return Promise.resolve({ exitCode: 1, stdout: "", stderr: "ERROR: Detected PowerShell cmdlet on a Unix system. Use standard POSIX/bash commands instead (e.g. ls, grep, find, cat, etc.). Please retry with the correct command." });
	}

	const usePowerShell = process.platform === "win32" || isPs;

	return new Promise((resolve) => {
		if (usePowerShell) {
			const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
			const args = ["-NoProfile", "-NonInteractive", "-Command", command];
			let child: cp.ChildProcess;
			try {
				child = cp.spawn(shell, args, { cwd, windowsHide: true });
			} catch (err) {
				cp.exec(command, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (err2, stdout, stderr) => {
					const exitCode = err2 ? (typeof (err2 as any).code === "number" ? (err2 as any).code : 1) : 0;
					resolve({ exitCode, stdout: String(stdout || ""), stderr: String(stderr || "") });
				});
				return;
			}

			let stdout = "";
			let stderr = "";
			const to = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
			
			// Handle abort signal
			const abortHandler = () => {
				clearTimeout(to);
				try { child.kill(); } catch {}
				resolve({ exitCode: 1, stdout, stderr: "Operation cancelled by user." });
			};
			abortSignal?.addEventListener("abort", abortHandler);

			if (child.stdout) child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
			if (child.stderr) child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

			child.on("error", (err) => {
				abortSignal?.removeEventListener("abort", abortHandler);
				if ((err as any).code === "ENOENT") {
					cp.exec(command, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (err2, out, errOut) => {
						const exitCode = err2 ? (typeof (err2 as any).code === "number" ? (err2 as any).code : 1) : 0;
						clearTimeout(to);
						resolve({ exitCode, stdout: String(out || ""), stderr: String(errOut || "") });
					});
					return;
				}
				clearTimeout(to);
				resolve({ exitCode: 1, stdout, stderr: String((err && (err as any).message) || "") });
			});

			child.on("close", (code) => {
				abortSignal?.removeEventListener("abort", abortHandler);
				clearTimeout(to);
				const exitCode = typeof code === "number" ? code : 0;
				resolve({ exitCode, stdout, stderr });
			});
		} else {
			const shell = "/bin/bash";
			const args = ["-lc", command];
			let child: cp.ChildProcess;
			try {
				child = cp.spawn(shell, args, { cwd, windowsHide: true });
			} catch (err) {
				cp.exec(command, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (err2, stdout, stderr) => {
					const exitCode = err2 ? (typeof (err2 as any).code === "number" ? (err2 as any).code : 1) : 0;
					resolve({ exitCode, stdout: String(stdout || ""), stderr: String(stderr || "") });
				});
				return;
			}

			let stdout = "";
			let stderr = "";
			const to = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
			
			// Handle abort signal
			const abortHandler = () => {
				clearTimeout(to);
				try { child.kill(); } catch {}
				resolve({ exitCode: 1, stdout, stderr: "Operation cancelled by user." });
			};
			abortSignal?.addEventListener("abort", abortHandler);

			if (child.stdout) child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
			if (child.stderr) child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

			child.on("error", (err) => {
				abortSignal?.removeEventListener("abort", abortHandler);
				if ((err as any).code === "ENOENT") {
					cp.exec(command, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (err2, out, errOut) => {
						const exitCode = err2 ? (typeof (err2 as any).code === "number" ? (err2 as any).code : 1) : 0;
						clearTimeout(to);
						resolve({ exitCode, stdout: String(out || ""), stderr: String(errOut || "") });
					});
					return;
				}
				clearTimeout(to);
				resolve({ exitCode: 1, stdout, stderr: String((err && (err as any).message) || "") });
			});

			child.on("close", (code) => {
				abortSignal?.removeEventListener("abort", abortHandler);
				clearTimeout(to);
				const exitCode = typeof code === "number" ? code : 0;
				resolve({ exitCode, stdout, stderr });
			});
		}
	});
}

function resolveUri(filePath: string): vscode.Uri {
	const folders = vscode.workspace.workspaceFolders
	if (!folders || folders.length === 0) {
		return vscode.Uri.file(filePath)
	}

	const rootUri = folders[0].uri
	const resolved = vscode.Uri.joinPath(rootUri, filePath)
	const rootFsPath = path.normalize(rootUri.fsPath)
	const resolvedFsPath = path.normalize(resolved.fsPath)
	if (!resolvedFsPath.startsWith(rootFsPath + path.sep) && resolvedFsPath !== rootFsPath) {
		throw new Error(`Path traversal denied: "${filePath}" resolves outside the workspace root.`)
	}
	return resolved
}

async function openOrCreate(uri: vscode.Uri): Promise<vscode.TextDocument> {
	try {
		return await vscode.workspace.openTextDocument(uri)
	} catch {
		await vscode.workspace.fs.writeFile(uri, new Uint8Array())
		return vscode.workspace.openTextDocument(uri)
	}
}

/**
 * Fetch content from a URL using Node.js native http/https modules.
 * Returns the response body as a string. Large responses are gracefully
 * truncated at 2MB of raw HTML (the parsed text is further trimmed to 50KB
 * by parseHtmlToText).
 */
function fetchUrl(url: string, timeoutMs = 30_000, abortSignal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		if (abortSignal?.aborted) {
			reject(new Error("Operation cancelled by user."));
			return;
		}

		let settled = false;
		const settle = (fn: typeof resolve | typeof reject, value: string | Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			abortSignal?.removeEventListener("abort", abortHandler);
			(fn as any)(value);
		};

		const parsedUrl = new URL(url);
		const isHttps = parsedUrl.protocol === "https:";
		const client = isHttps ? https : http;

		const options = {
			hostname: parsedUrl.hostname,
			port: parsedUrl.port || (isHttps ? 443 : 80),
			path: parsedUrl.pathname + parsedUrl.search,
			method: "GET",
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
			},
		};

		const timer = setTimeout(() => {
			req.destroy(new Error("Request timeout"));
		}, timeoutMs);

		// Handle abort signal
		const abortHandler = () => {
			req.destroy(new Error("Operation cancelled by user."));
		};
		abortSignal?.addEventListener("abort", abortHandler);

		const req = client.request(options, (res) => {
			// Handle redirects
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				clearTimeout(timer);
				abortSignal?.removeEventListener("abort", abortHandler);
				const redirectUrl = res.headers.location;
				// Handle relative redirects
				if (redirectUrl.startsWith("/")) {
					const fullRedirect = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
					fetchUrl(fullRedirect, timeoutMs, abortSignal).then(resolve).catch(reject);
				} else {
					fetchUrl(redirectUrl, timeoutMs, abortSignal).then(resolve).catch(reject);
				}
				return;
			}

			if (res.statusCode && res.statusCode >= 400) {
				// For 401/403/paywall, provide a helpful message instead of throwing
				if (res.statusCode === 401 || res.statusCode === 403) {
					settle(reject as any, new Error(`HTTP ${res.statusCode}: Access denied (paywall or authentication required)`));
				} else {
					settle(reject as any, new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
				}
				return;
			}

			const chunks: Buffer[] = [];
			let totalSize = 0;
			let truncated = false;
			const maxSize = 2 * 1024 * 1024; // 2MB raw limit (parsed text is further trimmed)

			res.on("data", (chunk: Buffer) => {
				if (truncated) {
					return; // Already have enough data, ignore the rest
				}
				totalSize += chunk.length;
				if (totalSize > maxSize) {
					// Keep only the portion that fits within the limit
					const overshoot = totalSize - maxSize;
					const trimmedChunk = chunk.slice(0, chunk.length - overshoot);
					if (trimmedChunk.length > 0) {
						chunks.push(trimmedChunk);
					}
					truncated = true;
					// Destroy the response stream to stop downloading
					res.destroy();
					return;
				}
				chunks.push(chunk);
			});

			res.on("end", () => {
				const buffer = Buffer.concat(chunks);
				let text = buffer.toString("utf-8");
				if (truncated) {
					text += "\n<!-- [Content truncated: page exceeded 2MB raw size] -->";
				}
				settle(resolve, text);
			});

			res.on("close", () => {
				// Handle 'close' for when we destroy the stream early (truncation)
				if (truncated) {
					const buffer = Buffer.concat(chunks);
					let text = buffer.toString("utf-8");
					text += "\n<!-- [Content truncated: page exceeded 2MB raw size] -->";
					settle(resolve, text);
				}
			});

			res.on("error", (err) => {
				// If we already collected data before the error (e.g. from truncation destroy),
				// resolve with what we have instead of rejecting
				if (truncated && chunks.length > 0) {
					const buffer = Buffer.concat(chunks);
					let text = buffer.toString("utf-8");
					text += "\n<!-- [Content truncated: page exceeded 2MB raw size] -->";
					settle(resolve, text);
				} else {
					settle(reject as any, err);
				}
			});
		});

		req.on("error", (err) => {
			settle(reject as any, err);
		});

		req.end();
	});
}

/**
 * Parse HTML content and extract readable text.
 * Strips HTML tags, scripts, styles, and normalizes whitespace.
 * Returns clean readable text limited to 100KB.
 */
function parseHtmlToText(html: string): string {
	// Remove script and style blocks entirely
	let text = html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
		.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ");

	// Replace block-level elements with newlines for readability
	text = text
		.replace(/<\/?(p|div|section|article|header|footer|h[1-6]|li|tr|blockquote|br)[^>]*>/gi, "\n")
		.replace(/<\/?(td|th)[^>]*>/gi, " | ");

	// Remove all remaining HTML tags
	text = text.replace(/<[^>]+>/g, " ");

	// Decode common HTML entities
	text = text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
		.replace(/&[a-z]+;/gi, " ");

	// Normalize whitespace: collapse multiple spaces/tabs, but preserve newlines
	text = text
		.split("\n")
		.map(line => line.replace(/[ \t]+/g, " ").trim())
		.filter(line => line.length > 0)
		.join("\n");

	// Collapse multiple consecutive blank lines
	text = text.replace(/\n{3,}/g, "\n\n");

	// Limit output size to 100KB
	const maxBytes = 100 * 1024;
	if (text.length > maxBytes) {
		text = text.slice(0, maxBytes) + "\n\n[Content truncated at 100KB]";
	}

	return text.trim();
}
