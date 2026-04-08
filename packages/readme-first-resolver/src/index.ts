#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from './lib.js';

const program = new Command();

program
  .name('readme-first')
  .description('Read primary docs before analysis — build a system mental model')
  .version('1.0.0');

program
  .command('resolve')
  .description('Read and analyze primary documentation for a repo')
  .requiredOption('-p, --path <path>', 'Path to repo directory')
  .option('-f, --files <files...>', 'Files to read (default: README.md, AGENT_ENTRYPOINT.yaml, .env.example)')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const result = resolve({ repo_path: opts.path, must_read: opts.files });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const status = result.ready_for_analysis ? chalk.green('✅ Ready') : chalk.red('❌ Not ready');
    console.log(chalk.bold.cyan(`\n📖 README First Resolver\n`));
    console.log(`  Status: ${status}`);
    console.log(`\n  ${chalk.bold('System Summary:')}`);
    console.log(`    Purpose: ${result.system_summary.purpose}`);
    console.log(`    Components: ${result.system_summary.main_components.join(', ')}`);
    console.log(`    Runtime: ${result.system_summary.runtime_model.join(', ')}`);

    if (result.system_summary.required_config.length > 0) {
      console.log(`    Config: ${result.system_summary.required_config.join(', ')}`);
    }

    console.log(`\n  ${chalk.bold('Sources read:')} ${result.sources_read.join(', ') || 'none'}`);

    if (result.sources_missing.length > 0) {
      console.log(`  ${chalk.yellow('Missing:')} ${result.sources_missing.join(', ')}`);
    }

    if (result.unknowns.length > 0) {
      console.log(`\n  ${chalk.bold.yellow('⚠ Unknowns:')}`);
      result.unknowns.forEach(u => console.log(`    - ${u}`));
    }
    console.log();
  });

program.parse();
