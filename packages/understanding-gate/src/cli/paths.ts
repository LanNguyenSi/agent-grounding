import { homedir } from "node:os";
import { resolve } from "node:path";

export type Scope = "user" | "project";

export function settingsPathFor(scope: Scope, cwd: string = process.cwd()): string {
  return scope === "user"
    ? resolve(homedir(), ".claude", "settings.json")
    : resolve(cwd, ".claude", "settings.json");
}
