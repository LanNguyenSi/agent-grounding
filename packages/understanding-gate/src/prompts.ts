import type { Mode } from "./mode.js";
import { FAST_CONFIRM_PROMPT } from "./prompts/fast-confirm.js";
import { GRILL_ME_PROMPT } from "./prompts/grill-me.js";
import { FULL_PROMPT } from "./prompts/full.js";

export function getPromptSnippet(mode: Mode): string {
  switch (mode) {
    case "fast_confirm":
      return FAST_CONFIRM_PROMPT;
    case "grill_me":
      return GRILL_ME_PROMPT;
  }
}

export { FAST_CONFIRM_PROMPT, GRILL_ME_PROMPT, FULL_PROMPT };
