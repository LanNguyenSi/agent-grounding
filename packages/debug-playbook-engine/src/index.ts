#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { getPlaybook, initRun, getCurrentStep, recordStep, getRemainingMandatory } from './lib.js';

export * from './lib.js';

const program = new Command();

program
  .name('debug-playbook')
  .description('Run domain-specific diagnostic playbooks step-by-step')
  .version('0.1.0');

program
  .command('run')
  .description('Start a diagnostic playbook for a domain/problem')
  .requiredOption('-d, --domain <domain>', 'Domain (e.g. clawd-monitor, github)')
  .requiredOption('-p, --problem <problem>', 'Problem description')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const playbook = getPlaybook(opts.domain, opts.problem);
    const state = initRun(playbook);

    if (opts.json) {
      console.log(JSON.stringify(playbook, null, 2));
      return;
    }

    console.log(chalk.bold.cyan(`\n🔍 Debug Playbook: ${playbook.name}\n`));
    console.log(`  Problem: ${opts.problem}`);
    console.log(`\n  ${chalk.bold('Steps:')}`);

    playbook.steps.forEach((step, i) => {
      const mandatory = step.mandatory ? chalk.red('[mandatory]') : chalk.gray('[optional]');
      console.log(`    ${i + 1}. ${chalk.bold(step.id)} ${mandatory}`);
      console.log(`       → ${step.action}`);
    });

    const current = getCurrentStep(state);
    if (current) {
      console.log(`\n  ${chalk.green('▶ Start with:')} ${current.action}`);
    }
    console.log();
  });

program
  .command('next')
  .description('Show current pending step for a domain')
  .requiredOption('-d, --domain <domain>', 'Domain')
  .requiredOption('-p, --problem <problem>', 'Problem description')
  .action((opts) => {
    const playbook = getPlaybook(opts.domain, opts.problem);
    const state = initRun(playbook);
    const step = getCurrentStep(state);
    const remaining = getRemainingMandatory(state);

    console.log(chalk.bold.cyan(`\n📋 Next Step\n`));
    if (step) {
      console.log(`  ID:       ${chalk.bold(step.id)}`);
      console.log(`  Action:   ${step.action}`);
      console.log(`  Required: ${step.mandatory ? chalk.red('yes') : chalk.gray('no')}`);
      console.log(`  Remaining mandatory: ${remaining.length}`);
    } else {
      console.log('  All steps completed.');
    }
    console.log();
  });

if (require.main === module) {
  program.parse();
}
