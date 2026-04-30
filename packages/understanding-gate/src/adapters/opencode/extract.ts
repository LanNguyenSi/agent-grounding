// Pull assistant text out of a SessionMessageResponse. Defensive: opencode
// SDK responses are wrapped in `{ data: ... }` envelopes, but the shape
// varies between client transports — always treat the payload as unknown
// and validate at the boundary so a plugin runtime change can't crash us.

export function extractAssistantText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== "object") return "";
  const parts = (data as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";

  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type !== "text") continue;
    if (typeof p.text !== "string") continue;
    texts.push(p.text);
  }
  return texts.join("\n").trim();
}
