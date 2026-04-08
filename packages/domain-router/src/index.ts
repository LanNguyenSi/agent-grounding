#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { route, impact } from './lib.js';

const program = new Command();

program
  .name('domain-router')
  .description('Route a keyword/problem to the correct repos, components and docs')
  .version('1.0.0');

program
  .command('route')
  .description('Resolve domain scope for a keyword')
  .requiredOption('-k, --keyword <keyword>', 'Problem keyword (e.g. clawd-monitor)')
  .requiredOption('-w, --workspace <path>', 'Path to workspace directory containing repos')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const result = route({ keyword: opts.keyword, workspace: opts.workspace });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(chalk.bold.cyan(`\n🗂  Domain Router — "${opts.keyword}"\n`));
    console.log(`  Domain:      ${chalk.bold(result.domain)}`);
    console.log(`  Confidence:  ${chalk.yellow((result.confidence * 100).toFixed(0) + '%')}`);
    console.log(`\n  ${chalk.bold('Primary Repos:')}`);
    result.primary_repos.forEach(r => console.log(`    📁 ${r}`));
    console.log(`\n  ${chalk.bold('Related Components:')}`);
    result.related_components.forEach(c => console.log(`    - ${c}`));
    console.log(`\n  ${chalk.bold('Priority Files (read first):')}`);
    result.priority_files.forEach(f => console.log(`    📄 ${f}`));
    console.log(`\n  ${chalk.bold.red('❌ Forbidden initial jumps:')}`);
    result.forbidden_initial_jumps.forEach(j => console.log(`    - ${j}`));
    console.log();
  });

program
  .command('impact')
  .description('Show which repos depend on a given keyword/package')
  .requiredOption('-k, --keyword <keyword>', 'Package or component name (e.g. clawd-monitor)')
  .requiredOption('-w, --workspace <path>', 'Path to workspace directory containing repos')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const result = impact(opts.keyword, opts.workspace);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(chalk.bold.cyan(`\n🔍 Impact Analysis — "${opts.keyword}"\n`));
    if (result.dependents.length === 0) {
      console.log(chalk.dim('  No dependents found.\n'));
      return;
    }
    for (const dep of result.dependents) {
      const typeLabel = dep.type === 'npm' ? chalk.green('npm') : chalk.blue('entrypoint');
      console.log(`  📦 ${chalk.bold(dep.repo)} [${typeLabel}] — ${dep.detail}`);
    }
    console.log();
  });

program.parse();
