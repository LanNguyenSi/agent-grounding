import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface DomainRouterInput {
  keyword: string;
  workspace: string;
  context?: {
    host?: string;
    problem_hint?: string;
  };
}

export interface DomainRouterOutput {
  domain: string;
  primary_repos: string[];
  related_components: string[];
  priority_files: string[];
  forbidden_initial_jumps: string[];
  confidence: number;
}

export interface RepoInfo {
  name: string;
  score: number;
  path: string;
}

/** Normalize keyword for comparison */
export function normalizeKeyword(keyword: string): string {
  return keyword.toLowerCase().replace(/[-_\s]+/g, '-').trim();
}

/** Score a repo name against the keyword */
export function scoreRepo(repoName: string, keyword: string): number {
  const normalizedRepo = normalizeKeyword(repoName);
  const normalizedKeyword = normalizeKeyword(keyword);

  if (normalizedRepo === normalizedKeyword) return 1.0;
  if (normalizedRepo.includes(normalizedKeyword)) return 0.8;
  if (normalizedKeyword.includes(normalizedRepo)) return 0.7;

  // Partial word match
  const keywordParts = normalizedKeyword.split('-');
  const repoParts = normalizedRepo.split('-');
  const matchCount = keywordParts.filter(p => repoParts.includes(p)).length;
  if (matchCount > 0) {
    return 0.4 + (matchCount / Math.max(keywordParts.length, repoParts.length)) * 0.3;
  }

  return 0;
}

/** Get priority files that should be read first */
export function getPriorityFiles(repoPath: string): string[] {
  const candidates = [
    'README.md',
    'docs/architecture.md',
    'AGENT_ENTRYPOINT.yaml',
    '.env.example',
    'docker-compose.yml',
    'docker-compose.yaml',
  ];

  if (!fs.existsSync(repoPath)) return candidates.slice(0, 3);

  return candidates.filter(f => fs.existsSync(path.join(repoPath, f)));
}

/** Discover repos in workspace directory */
export function discoverRepos(workspace: string): string[] {
  if (!fs.existsSync(workspace)) return [];

  return fs.readdirSync(workspace).filter(entry => {
    const fullPath = path.join(workspace, entry);
    return fs.statSync(fullPath).isDirectory() &&
      fs.existsSync(path.join(fullPath, '.git'));
  });
}

/** Infer related components from keyword */
export function inferRelatedComponents(keyword: string): string[] {
  const k = keyword.toLowerCase();
  const components: string[] = [];

  if (k.includes('monitor') || k.includes('dashboard')) {
    components.push('Web UI', 'Backend API', 'Agent process');
  }
  if (k.includes('agent') || k.includes('openclaw') || k.includes('clawd')) {
    components.push('OpenClaw Gateway', 'Agent runtime');
  }
  if (k.includes('gateway') || k.includes('api')) {
    components.push('REST API', 'WebSocket server');
  }
  if (k.includes('auth') || k.includes('token')) {
    components.push('Auth service', 'Token management');
  }
  if (components.length === 0) {
    components.push('Core service');
  }

  return [...new Set(components)];
}

// ── Impact analysis ──────────────────────────────────────────────────────────

export interface ImpactDependency {
  repo: string;
  type: 'npm' | 'entrypoint';
  detail: string;
}

export interface ImpactResult {
  keyword: string;
  dependents: ImpactDependency[];
}

/** Check if a repo's package.json depends on the keyword */
export function findNpmDependency(repoPath: string, keyword: string): ImpactDependency | null {
  const pkgPath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const allDeps: Record<string, string> = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    const normalizedKeyword = normalizeKeyword(keyword);
    const match = Object.keys(allDeps).find(
      dep => normalizeKeyword(dep) === normalizedKeyword || dep.includes(keyword),
    );
    if (match) {
      return { repo: path.basename(repoPath), type: 'npm', detail: `${match}@${allDeps[match]}` };
    }
  } catch { /* ignore malformed package.json */ }
  return null;
}

/** Check if a repo's AGENT_ENTRYPOINT.yaml references the keyword */
export function findEntrypointReference(repoPath: string, keyword: string): ImpactDependency | null {
  const entryPath = path.join(repoPath, 'AGENT_ENTRYPOINT.yaml');
  if (!fs.existsSync(entryPath)) return null;

  try {
    const doc = yaml.load(fs.readFileSync(entryPath, 'utf-8')) as Record<string, unknown>;
    const related = doc?.related_components;
    if (Array.isArray(related)) {
      const normalizedKeyword = normalizeKeyword(keyword);
      const match = related.find(
        (c: unknown) => typeof c === 'string' && normalizeKeyword(c).includes(normalizedKeyword),
      );
      if (match) {
        return { repo: path.basename(repoPath), type: 'entrypoint', detail: `related_components: ${match}` };
      }
    }
  } catch { /* ignore malformed yaml */ }
  return null;
}

/** Find all repos that depend on the given keyword */
export function impact(keyword: string, workspace: string): ImpactResult {
  const repos = discoverRepos(workspace);
  const dependents: ImpactDependency[] = [];

  for (const repo of repos) {
    const repoPath = path.join(workspace, repo);
    const npmDep = findNpmDependency(repoPath, keyword);
    if (npmDep) dependents.push(npmDep);
    const entryRef = findEntrypointReference(repoPath, keyword);
    if (entryRef) dependents.push(entryRef);
  }

  return { keyword, dependents };
}

/** Main routing function */
export function route(input: DomainRouterInput): DomainRouterOutput {
  const { keyword, workspace } = input;
  const repos = discoverRepos(workspace);

  const scored: RepoInfo[] = repos
    .map(name => ({
      name,
      score: scoreRepo(name, keyword),
      path: path.join(workspace, name),
    }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const primaryRepos = scored.slice(0, 3).map(r => r.name);
  const topRepo = scored[0];
  const confidence = topRepo ? Math.min(topRepo.score + 0.05, 1.0) : 0.1;

  const priorityFiles = topRepo
    ? getPriorityFiles(topRepo.path)
    : ['README.md', '.env.example'];

  return {
    domain: normalizeKeyword(keyword),
    primary_repos: primaryRepos.length > 0 ? primaryRepos : [keyword],
    related_components: inferRelatedComponents(keyword),
    priority_files: priorityFiles,
    forbidden_initial_jumps: [
      'random log search',
      'unrelated service inspection',
      'network diagnosis before process check',
    ],
    confidence,
  };
}
