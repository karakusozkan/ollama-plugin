import * as vscode from "vscode";
import { LLMProvider, Message } from "./llm";
import { buildSystemPrompt, ToolAction, ExtendedToolAction } from "./tools";
import { executeActions, ActionResult } from "./executor";
import { McpManager } from "./mcp.js";

interface AgentResponse {
  thought: string;
  actions: ExtendedToolAction[];
}

/**
 * Parses the raw LLM output into a typed AgentResponse.
 * Handles models that wrap JSON in markdown code fences or add text around it.
 */
function parseResponse(raw: string): AgentResponse {
  // Try to extract JSON from the response - handle models that wrap JSON in text
  let jsonStr = raw;
  
  // First, try to find JSON within markdown code blocks
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    // Try to find a JSON object with thought and actions fields
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `Agent returned non-JSON output:\n${raw.slice(0, 500)}`
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("actions" in parsed)
  ) {
    throw new Error(
      `Agent response missing required "actions" field:\n${JSON.stringify(parsed, null, 2)}`
    );
  }

  return parsed as AgentResponse;
}

/**
 * Build a follow-up user message that summarises the execution results so
 * the agent can perform a reflection/correction step in future iterations.
 */
function buildFeedbackMessage(results: ActionResult[]): string {
  const lines = results.map((r) => {
    const label = r.success ? "✅" : "❌";
    const tool = r.action.tool;
    const path = "path" in r.action ? r.action.path : "";
    let line = `${label} ${tool}${path ? ` → ${path}` : ""}`;
    if (r.output) {
      line += `\n${r.output.slice(0, 20000)}`; // cap output
    }
    return line;
  });
  return `Tool execution results:\n\n${lines.join("\n\n")}`;
}

/**
 * The main agent.  Call run() with a natural-language goal;
 * it will loop LLM → actions → feedback until the model emits
 * an empty actions array (or we hit the iteration cap).
 */
export class Agent {
  private readonly maxIterations = 8;
  private _mcpManager?: McpManager;

  constructor(private readonly llm: LLMProvider) {}

  set mcpManager(manager: McpManager | undefined) {
    this._mcpManager = manager;
  }

  async run(goal: string, output: vscode.OutputChannel, abortSignal?: AbortSignal): Promise<void> {
    const messages: Message[] = [
      { role: "system", content: buildSystemPrompt(this._mcpManager) },
      { role: "user", content: goal },
    ];

    let lastActionsIncludedFetch = false;
    let fetchExtractionRetryUsed = false;

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      output.appendLine(`\n── Iteration ${iteration} ──────────────────────`);
      output.appendLine("⏳ Waiting for LLM…");

      if (abortSignal?.aborted) {
        output.appendLine("⏹ Agent run cancelled.");
        return;
      }

      let raw = "";
      const useStreaming = vscode.workspace.getConfiguration("ollamaAgent").get<boolean>("useStreaming", true);

      if (useStreaming) {
        try {
          raw = await this.llm.chatStream(messages, () => {
            // The Run command writes parsed thoughts/actions to the output channel,
            // so there is no need to print raw token chunks here.
          }, undefined, abortSignal);
        } catch (streamErr) {
          if (abortSignal?.aborted) {
            output.appendLine("⏹ Agent run cancelled.");
            return;
          }
          const message = streamErr instanceof Error ? streamErr.message : String(streamErr);
          output.appendLine(`ℹ️ Streaming failed or stalled; retrying without streaming. ${message}`);
          raw = await this.llm.chat(messages, undefined, abortSignal);
        }
      } else {
        output.appendLine("ℹ️ Streaming disabled; using non-streaming chat request.");
        raw = await this.llm.chat(messages, undefined, abortSignal);
      }

      if (abortSignal?.aborted) {
        output.appendLine("⏹ Agent run cancelled.");
        return;
      }

      if (!raw.trim()) {
        output.appendLine("ℹ️ Empty response received; retrying once without streaming.");
        raw = await this.llm.chat(messages, undefined, abortSignal);
      }

      let parsed: AgentResponse;
      try {
        parsed = parseResponse(raw);
      } catch (err) {
        output.appendLine(`❌ Parse error: ${err}`);
        vscode.window.showErrorMessage(`Ollama Agent: ${err}`);
        return;
      }

      output.appendLine(`💭 ${parsed.thought}`);

      if (!parsed.actions || parsed.actions.length === 0) {
        // If the model returned no actions immediately after we executed a fetch_url,
        // it may have failed to produce the final extraction. Give it one retry with
        // a short clarifying prompt so it can extract the fetched page text. Only
        // retry once to avoid infinite loops.
        if (lastActionsIncludedFetch && !fetchExtractionRetryUsed) {
          fetchExtractionRetryUsed = true;
          output.appendLine("ℹ️ No actions returned after fetch — asking model to extract fetched content and retrying once.");
          // Push the assistant's raw response so the model has its last turn, then
          // add a concise user instruction to extract the first news article.
          messages.push({ role: "assistant", content: raw });
          messages.push({ role: "user", content: "Please extract the first news article from the previously fetched page text and return the full article text inside the \"thought\" field. Do not call any tools; return an empty \"actions\" array when finished." });
          // Continue to next iteration (will call LLM again)
          continue;
        }

        output.appendLine("✅ Agent completed — no further actions.");
        vscode.window.showInformationMessage("Ollama Agent: Task complete!");
        return;
      }

      output.appendLine(`🔧 Executing ${parsed.actions.length} action(s)…`);
      const results = await executeActions(parsed.actions, undefined, this._mcpManager);

      // Track whether the actions we just executed included a fetch_url so we can
      // optionally prompt the model to extract the fetched content if it returns
      // an empty actions array in the next turn.
      lastActionsIncludedFetch = parsed.actions.some(a => a.tool === "fetch_url");

      for (const r of results) {
        const label = r.success ? "✅" : "❌";
        const loc = "path" in r.action
          ? ` → ${r.action.path}`
          : "command" in r.action
          ? ` $ ${(r.action as { command: string }).command}`
          : "";
        output.appendLine(`  ${label} ${r.action.tool}${loc}`);

        // Always show run_command output; show other output on failure
        if (r.output && (r.action.tool === "run_command" || !r.success)) {
          const indented = r.output.split("\n").map(l => `     ${l}`).join("\n");
          output.appendLine(indented);
        }
      }


      // Push the model's last response + execution feedback into history
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: buildFeedbackMessage(results),
      });
    }

    output.appendLine("⚠️  Reached maximum iterations.");
    vscode.window.showWarningMessage(
      "Ollama Agent: Reached maximum iterations — review the output channel."
    );
  }
}
