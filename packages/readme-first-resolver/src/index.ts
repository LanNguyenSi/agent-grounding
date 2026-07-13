#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from './lib.js';

export * from './lib.js';

// Reads the version from package.json instead of hardcoding it, so the CLI
// can never desync from the published version on a release bump. __dirname
// resolves relative to this module so it works both from src/ (dev, via
// ts-node) and from the built dist/ layout (dist/index.js sits one level
// below the package root, same as src/index.ts).
function readVersion(): string {
  try {
    const text = readFileSync(join(__dirname, '../package.json'), 'utf8');
    const pkg = JSON.parse(text) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('readme-first')
    .description('Read primary docs before analysis — build a system mental model')
    .version(readVersion());

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

  return program;
}

if (require.main === module) {
  buildProgram().parse();
}
