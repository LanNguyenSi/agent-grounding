// Read a Claude Code transcript JSONL file and extract the concatenated
// text of the trailing run of assistant entries (i.e. all assistant
// content since the most recent user entry). Returns "" on any failure
// — the calling Stop hook treats "" as "no assistant text yet, skip".

import { readFileSync } from "node:fs";

interface AssistantContentBlock {
  type?: string;
  text?: string;
}

interface TranscriptEntry {
  type?: string;
  /** Present on tool-result entries that Claude Code records as type:"user". */
  toolUseResult?: unknown;
  /** Present on tool-result entries; pairs with the assistant tool_use uuid. */
  sourceToolAssistantUUID?: string;
  message?: {
    role?: string;
    content?: AssistantContentBlock[];
  };
}

// A real human turn vs. a tool-result roundtrip. Tool-result entries are
// recorded as `type:"user"` in the JSONL but they're part of the agent's
// own turn and must NOT terminate the trailing-assistant walk — otherwise
// a Report split across tool-use boundaries (plausible in grill-me mode)
// gets silently truncated.
function isHumanUserTurn(entry: TranscriptEntry): boolean {
  if (entry.type !== "user") return false;
  if (entry.toolUseResult !== undefined) return false;
  if (typeof entry.sourceToolAssistantUUID === "string") return false;
  const content = entry.message?.content;
  if (Array.isArray(content) && content.length > 0) {
    const everyBlockToolResult = content.every(
      (b) => b && b.type === "tool_result",
    );
    if (everyBlockToolResult) return false;
  }
  return true;
}

export function extractLastAssistantText(transcriptPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  return parseTrailingAssistantText(raw);
}

// Split out for unit testing without touching the filesystem.
export function parseTrailingAssistantText(jsonl: string): string {
  const lines = jsonl.split(/\r?\n/);
  const trailing: AssistantContentBlock[] = [];
  // Walk backwards; collect text blocks from consecutive assistant entries
  // until we hit a user entry that marks the end of the assistant turn.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (isHumanUserTurn(entry)) break;
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    // Prepend so blocks land in source order in the final concatenation.
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (block && block.type === "text" && typeof block.text === "string") {
        trailing.unshift(block);
      }
    }
  }
  return trailing.map((b) => b.text ?? "").join("\n").trim();
}
