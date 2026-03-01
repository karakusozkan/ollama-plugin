import * as vscode from "vscode";
import { LLMProvider, Message } from "./llm";
import { buildSystemPrompt, ToolAction } from "./tools";
import { executeActions, ActionResult } from "./executor";

interface AgentResponse {
  thought: string;
  actions: ToolAction[];
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

  constructor(private readonly llm: LLMProvider) {}

  async run(goal: string, output: vscode.OutputChannel): Promise<void> {
    const messages: Message[] = [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: goal },
    ];

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      output.appendLine(`\n── Iteration ${iteration} ──────────────────────`);
      output.appendLine("⏳ Waiting for LLM…");

      const raw = await this.llm.chat(messages);

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
        output.appendLine("✅ Agent completed — no further actions.");
        vscode.window.showInformationMessage("Ollama Agent: Task complete!");
        return;
      }

      output.appendLine(`🔧 Executing ${parsed.actions.length} action(s)…`);
      const results = await executeActions(parsed.actions);

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
