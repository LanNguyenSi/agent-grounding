import chalk from "chalk";
import type { LedgerEntry } from "./types.js";

const TYPE_ICONS: Record<string, string> = {
  fact: "✓",
  hypothesis: "?",
  rejected: "✗",
  unknown: "~",
};

const TYPE_COLORS: Record<string, (s: string) => string> = {
  fact: chalk.green,
  hypothesis: chalk.yellow,
  rejected: chalk.red,
  unknown: chalk.gray,
};

const CONFIDENCE_BADGES: Record<string, string> = {
  high: chalk.bgGreen.black(" HIGH "),
  medium: chalk.bgYellow.black(" MED  "),
  low: chalk.bgRed.white(" LOW  "),
};

export function formatEntry(entry: LedgerEntry): string {
  const icon = TYPE_ICONS[entry.type] ?? "·";
  const colorFn = TYPE_COLORS[entry.type] ?? chalk.white;
  const badge = CONFIDENCE_BADGES[entry.confidence] ?? "";
  const source = entry.source ? chalk.dim(` (${entry.source})`) : "";
  const id = chalk.dim(`[#${entry.id}]`);

  return `  ${colorFn(icon)} ${id} ${colorFn(entry.content)}${source} ${badge}`;
}

export function printSummary(
  summary: {
    facts: LedgerEntry[];
    hypotheses: LedgerEntry[];
    rejected: LedgerEntry[];
    unknowns: LedgerEntry[];
  },
  session: string,
): void {
  const total =
    summary.facts.length +
    summary.hypotheses.length +
    summary.rejected.length +
    summary.unknowns.length;

  console.log();
  console.log(chalk.bold.cyan(`📋 Evidence Ledger — session: ${session}`));
  console.log(chalk.dim(`   ${total} entries total`));
  console.log();

  if (summary.facts.length > 0) {
    console.log(chalk.bold.green(`✓ FACTS (${summary.facts.length})`));
    summary.facts.forEach((e) => console.log(formatEntry(e)));
    console.log();
  }

  if (summary.hypotheses.length > 0) {
    console.log(chalk.bold.yellow(`? HYPOTHESES (${summary.hypotheses.length})`));
    summary.hypotheses.forEach((e) => console.log(formatEntry(e)));
    console.log();
  }

  if (summary.unknowns.length > 0) {
    console.log(chalk.bold.gray(`~ UNKNOWNS (${summary.unknowns.length})`));
    summary.unknowns.forEach((e) => console.log(formatEntry(e)));
    console.log();
  }

  if (summary.rejected.length > 0) {
    console.log(chalk.bold.red(`✗ REJECTED (${summary.rejected.length})`));
    summary.rejected.forEach((e) => console.log(formatEntry(e)));
    console.log();
  }

  if (total === 0) {
    console.log(chalk.dim("  No entries yet. Use `ledger add` to start tracking."));
    console.log();
  }
}

export function printEntry(entry: LedgerEntry): void {
  console.log();
  console.log(formatEntry(entry));
  console.log();
}
