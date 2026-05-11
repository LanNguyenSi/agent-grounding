#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import {
  getDb,
  addEntry,
  rejectHypothesis,
  listEntries,
  getSummary,
  clearSession,
  listSessions,
  parseDuration,
  pruneEntries,
} from "./db.js";
import { printSummary, printEntry, formatEntry } from "./display.js";
import type { EntryType, ConfidenceLevel } from "./types.js";
import { buildHandoffMarkdown, buildHandoffJson } from "./handoff.js";

const program = new Command();

program
  .name("ledger")
  .description("Evidence Ledger — track facts, hypotheses and rejections during debugging")
  .version("0.2.0");

// ── add ──────────────────────────────────────────────────────────────────────

program
  .command("fact <content>")
  .description("Add a confirmed fact")
  .option("-s, --source <source>", "evidence source (e.g. 'ps aux', 'curl response')")
  .option("-c, --confidence <level>", "high | medium | low", "high")
  .option("--session <name>", "session name", "default")
  .action((content: string, opts: { source?: string; confidence: string; session: string }) => {
    const db = getDb();
    const entry = addEntry(db, {
      type: "fact",
      content,
      source: opts.source,
      confidence: opts.confidence as ConfidenceLevel,
      session: opts.session,
    });
    console.log(chalk.green("✓ Fact recorded:"));
    printEntry(entry);
  });

program
  .command("hypothesis <content>")
  .alias("hyp")
  .description("Add a hypothesis (unconfirmed explanation)")
  .option("-s, --source <source>", "basis for this hypothesis")
  .option("-c, --confidence <level>", "high | medium | low", "medium")
  .option("--session <name>", "session name", "default")
  .action((content: string, opts: { source?: string; confidence: string; session: string }) => {
    const db = getDb();
    const entry = addEntry(db, {
      type: "hypothesis",
      content,
      source: opts.source,
      confidence: opts.confidence as ConfidenceLevel,
      session: opts.session,
    });
    console.log(chalk.yellow("? Hypothesis added:"));
    printEntry(entry);
  });

program
  .command("unknown <content>")
  .description("Record something unknown / still needs investigation")
  .option("-s, --source <source>", "where this question came from")
  .option("--session <name>", "session name", "default")
  .action((content: string, opts: { source?: string; session: string }) => {
    const db = getDb();
    const entry = addEntry(db, {
      type: "unknown",
      content,
      source: opts.source,
      confidence: "low",
      session: opts.session,
    });
    console.log(chalk.gray("~ Unknown recorded:"));
    printEntry(entry);
  });

// ── reject ───────────────────────────────────────────────────────────────────

program
  .command("reject <id>")
  .description("Reject a hypothesis by its ID (marks it as disproven)")
  .option("-r, --reason <reason>", "why this hypothesis was rejected")
  .action((id: string, opts: { reason?: string }) => {
    const db = getDb();
    const updated = rejectHypothesis(db, Number.parseInt(id), opts.reason);
    if (!updated) {
      console.error(chalk.red(`Entry #${id} not found`));
      process.exit(1);
    }
    console.log(chalk.red("✗ Hypothesis rejected:"));
    printEntry(updated);
  });

// ── show ─────────────────────────────────────────────────────────────────────

program
  .command("show")
  .description("Show the current evidence summary")
  .option("--session <name>", "session name", "default")
  .action((opts: { session: string }) => {
    const db = getDb();
    const summary = getSummary(db, opts.session);
    printSummary(summary, opts.session);
  });

// ── list ─────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List all entries (optionally filtered)")
  .option("--session <name>", "filter by session", "default")
  .option("--type <type>", "filter by type: fact | hypothesis | rejected | unknown")
  .action((opts: { session: string; type?: string }) => {
    const db = getDb();
    const entries = listEntries(db, {
      session: opts.session,
      type: opts.type as EntryType | undefined,
    });
    if (entries.length === 0) {
      console.log(chalk.dim("No entries found."));
      return;
    }
    console.log();
    entries.forEach((e) => console.log(formatEntry(e)));
    console.log();
  });

// ── sessions ─────────────────────────────────────────────────────────────────

program
  .command("sessions")
  .description("List all sessions")
  .action(() => {
    const db = getDb();
    const sessions = listSessions(db);
    if (sessions.length === 0) {
      console.log(chalk.dim("No sessions yet."));
      return;
    }
    console.log();
    sessions.forEach((s) => console.log(chalk.cyan(`  · ${s}`)));
    console.log();
  });

// ── clear ────────────────────────────────────────────────────────────────────

program
  .command("clear")
  .description("Clear all entries for a session")
  .option("--session <name>", "session name", "default")
  .action((opts: { session: string }) => {
    const db = getDb();
    const count = clearSession(db, opts.session);
    console.log(chalk.dim(`Cleared ${count} entries from session '${opts.session}'.`));
  });

// ── export ───────────────────────────────────────────────────────────────────

program
  .command("export")
  .description("Export session as JSON")
  .option("--session <name>", "session name", "default")
  .action((opts: { session: string }) => {
    const db = getDb();
    const summary = getSummary(db, opts.session);
    const output = {
      session: opts.session,
      exportedAt: new Date().toISOString(),
      facts: summary.facts.map((e) => ({ content: e.content, source: e.source, confidence: e.confidence })),
      hypotheses: summary.hypotheses.map((e) => ({ content: e.content, source: e.source, confidence: e.confidence })),
      rejected_hypotheses: summary.rejected.map((e) => ({ content: e.content, source: e.source })),
      unknowns: summary.unknowns.map((e) => ({ content: e.content, source: e.source })),
    };
    console.log(JSON.stringify(output, null, 2));
  });

// ── prune ────────────────────────────────────────────────────────────────────

program
  .command("prune")
  .description("Delete ledger entries older than a given age")
  .requiredOption("--older-than <duration>", "age cutoff, e.g. 30d, 24h, 15m, 3600s")
  .option("--dry-run", "count what would be deleted, leave the DB untouched")
  .option("--json", "emit a structured JSON result on stdout")
  .action((opts: { olderThan: string; dryRun?: boolean; json?: boolean }) => {
    let olderThanMs: number;
    try {
      olderThanMs = parseDuration(opts.olderThan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.json) {
        console.log(JSON.stringify({ error: msg }));
      } else {
        console.error(chalk.red(msg));
      }
      process.exit(1);
    }

    const db = getDb();
    const result = pruneEntries(db, { olderThanMs, dryRun: opts.dryRun });

    if (opts.json) {
      console.log(JSON.stringify(result));
      return;
    }

    const verb = result.dryRun ? "would delete" : "deleted";
    console.log();
    console.log(
      chalk.cyan(`Prune ${result.dryRun ? "(dry-run) " : ""}— cutoff ${result.cutoff} UTC`),
    );
    console.log(chalk.dim(`   scanned ${result.scanned} entries, ${verb} ${result.deleted}`));
    console.log();
  });

// ── handoff ─────────────────────────────────────────────────────────────────

program
  .command("handoff")
  .description("Generate a structured handoff document for agent transitions")
  .option("--session <name>", "session name", "default")
  .option("--json", "Output as JSON instead of Markdown")
  .action((opts: { session: string; json?: boolean }) => {
    const db = getDb();
    const summary = getSummary(db, opts.session);

    if (opts.json) {
      console.log(JSON.stringify(buildHandoffJson(opts.session, summary), null, 2));
    } else {
      console.log(buildHandoffMarkdown(opts.session, summary));
    }
  });

program.parse();
