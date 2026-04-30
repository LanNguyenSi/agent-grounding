// Minimal structural types matching the @opencode-ai/plugin and
// @opencode-ai/sdk surface we touch. Vendoring this slice avoids pulling
// the whole SDK as a devDep — the SDK transitively brings in `effect`
// and `fast-check` with type-declaration bugs that conflict with our
// strict tsconfig (verified against @opencode-ai/sdk@1.14.30 + tsc 5.3).
//
// If the upstream surface changes shape between opencode releases, these
// types will silently drift. Schema-shape brittleness is acceptable for
// v0; a future task should pin to the real types once upstream cleans up.

export interface OpencodeAssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  finish?: string;
  // Plus many other fields we don't read (cost, tokens, modelID, ...).
}

export interface OpencodeUserMessage {
  id: string;
  sessionID: string;
  role: "user";
}

export type OpencodeMessage = OpencodeAssistantMessage | OpencodeUserMessage;

export interface OpencodeTextPart {
  type: "text";
  text: string;
}

export interface OpencodePart {
  type: string;
  text?: string;
}

export interface OpencodeMessageUpdated {
  type: "message.updated";
  properties: {
    info: OpencodeMessage;
  };
}

// We only act on message.updated; other event variants flow through the
// `event.type !== "message.updated"` guard untouched.
export type OpencodeEvent =
  | OpencodeMessageUpdated
  | { type: string; properties?: unknown };

// session.message returns { info, parts } in the response data envelope.
export interface OpencodeSessionMessageResponse {
  data?: {
    info?: OpencodeMessage;
    parts?: OpencodePart[];
  };
}

export interface OpencodeSessionApi {
  message(input: {
    path: { id: string; messageID: string };
  }): Promise<OpencodeSessionMessageResponse>;
}

export interface OpencodeClient {
  session: OpencodeSessionApi;
}

export interface OpencodePluginInput {
  client: OpencodeClient;
  directory: string;
}

export interface OpencodeHooks {
  event?: (input: { event: OpencodeEvent }) => Promise<void>;
}

export type OpencodePlugin = (input: OpencodePluginInput) => Promise<OpencodeHooks>;
