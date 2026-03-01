import * as path from "path";
import * as vscode from "vscode";

/**
 * Directories that are never relevant to the agent.
 * Everything else — including dotfiles like .eslintrc, .env, .prettierrc —
 * is included so the agent has a full picture of the working directory.
 */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "out",           // compiled TS output
  "dist",
  "build",
  ".vscode-test",
]);

/**
 * Returns a snapshot of every file in the active workspace folder (up to `limit`).
 * Paths are POSIX-style relative to the workspace root.
 */
export async function listWorkspaceFiles(limit = 200): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }

  const rootUri = folders[0].uri;
  const results: string[] = [];

  await walk(rootUri, rootUri, results, limit);
  return results;
}

async function walk(
  root: vscode.Uri,
  dir: vscode.Uri,
  results: string[],
  limit: number
): Promise<void> {
  if (results.length >= limit) {
    return;
  }

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }

  for (const [name, type] of entries) {
    if (results.length >= limit) {
      break;
    }

    // Skip build artifacts and vendored code — nothing else
    if (type === vscode.FileType.Directory && IGNORED_DIRS.has(name)) {
      continue;
    }

    const childUri = vscode.Uri.joinPath(dir, name);
    const relative = path.posix.relative(
      root.path,
      childUri.path
    );

    if (type === vscode.FileType.File) {
      results.push(relative);
    } else if (type === vscode.FileType.Directory) {
      await walk(root, childUri, results, limit);
    }
  }
}
