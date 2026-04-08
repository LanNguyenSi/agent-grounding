#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import {
  initSession,
  getCurrentTools,
  advancePhase,
  isGuardrailActive,
  GuardrailId,
} from './lib.js';

const GUARDRAIL_LABELS: Record<GuardrailId, string> = {
  'no-root-cause-before-readme': 'No root-cause claim before README is read',
  'no-token-claim-before-config-check': 'No token/config claim before config source is verified',
  'no-architecture-claim-before-docs': 'No architecture claim before primary docs are read',
  'no-network-claim-before-process-check': 'No network claim before process state is verified',
  'no-step-skipping': 'Mandatory steps cannot be skipped',
};

const program = new Command();

program
  .name('grounding-wrapper')
  .description('Orchestrate the full lan-tools grounding stack — enforce correct agent entry path')
  .version('1.0.0');

program
  .command('start')
  .description('Initialize a grounding session for a keyword/problem')
  .requiredOption('-k, --keyword <keyword>', 'Domain keyword (e.g. clawd-monitor)')
  .requiredOption('-p, --problem <problem>', 'Problem description')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const session = initSession({ keyword: opts.keyword, problem: opts.problem });

    if (opts.json) {
      console.log(JSON.stringify({
        id: session.id,
        resolved_scope: session.resolved_scope,
        mandatory_sequence: session.mandatory_sequence,
        active_guardrails: session.active_guardrails,
        current_phase: session.current_phase,
      }, null, 2));
      return;
    }

    console.log(chalk.bold.cyan(`\n🧭 Grounding Wrapper — Session Started\n`));
    console.log(`  ID:      ${chalk.gray(session.id)}`);
    console.log(`  Scope:   ${chalk.bold(session.resolved_scope)}`);
    console.log(`  Problem: ${session.problem}`);

    console.log(`\n  ${chalk.bold('Mandatory Sequence:')}`);
    session.mandatory_sequence.forEach((tool, i) => {
      console.log(`    ${i + 1}. ${chalk.yellow(tool)}`);
    });

    console.log(`\n  ${chalk.bold.red('Active Guardrails:')}`);
    session.active_guardrails.forEach(g => {
      console.log(`    🔒 ${GUARDRAIL_LABELS[g] ?? g}`);
    });

    const current = getCurrentTools(session);
    console.log(`\n  ${chalk.bold.green('▶ Start now with:')}`);
    current.forEach(t => {
      console.log(`    → ${chalk.bold(t.tool)}: ${t.description}`);
    });
    console.log();
  });

program
  .command('check-guardrail')
  .description('Check if a specific guardrail is active for a keyword')
  .requiredOption('-k, --keyword <keyword>', 'Domain keyword')
  .requiredOption('-g, --guardrail <guardrail>', 'Guardrail ID to check')
  .action((opts) => {
    const session = initSession({ keyword: opts.keyword, problem: '-' });
    const active = isGuardrailActive(session, opts.guardrail as GuardrailId);
    const label = GUARDRAIL_LABELS[opts.guardrail as GuardrailId] ?? opts.guardrail;

    if (active) {
      console.log(chalk.red(`🔒 ACTIVE: ${label}`));
    } else {
      console.log(chalk.green(`✅ NOT ACTIVE: ${label}`));
    }
  });

program
  .command('show-phases')
  .description('Show the grounding phases for a keyword')
  .requiredOption('-k, --keyword <keyword>', 'Domain keyword')
  .requiredOption('-p, --problem <problem>', 'Problem description')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const session = initSession({ keyword: opts.keyword, problem: opts.problem });

    if (opts.json) {
      console.log(JSON.stringify(session.steps, null, 2));
      return;
    }

    console.log(chalk.bold.cyan(`\n📋 Grounding Phases — ${session.resolved_scope}\n`));
    let lastPhase = '';
    for (const step of session.steps) {
      if (step.phase !== lastPhase) {
        console.log(chalk.bold.yellow(`\n  [${step.phase}]`));
        lastPhase = step.phase;
      }
      const req = step.mandatory ? chalk.red('[mandatory]') : chalk.gray('[optional]');
      console.log(`    → ${chalk.bold(step.tool)} ${req}`);
      console.log(`       ${step.description}`);
    }
    console.log();
  });

program.parse();
