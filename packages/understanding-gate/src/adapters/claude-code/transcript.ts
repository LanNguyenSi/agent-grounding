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
  message?: {
    role?: string;
    content?: AssistantContentBlock[];
  };
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
    if (entry.type === "user") break;
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
