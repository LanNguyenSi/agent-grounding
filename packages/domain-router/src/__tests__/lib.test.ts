import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  normalizeKeyword,
  scoreRepo,
  getPriorityFiles,
  discoverRepos,
  inferRelatedComponents,
  route,
  findNpmDependency,
  findEntrypointReference,
  impact,
} from '../lib';

describe('normalizeKeyword', () => {
  it('lowercases and normalizes separators', () => {
    expect(normalizeKeyword('Clawd-Monitor')).toBe('clawd-monitor');
    expect(normalizeKeyword('clawd_monitor')).toBe('clawd-monitor');
    expect(normalizeKeyword('Clawd Monitor')).toBe('clawd-monitor');
  });
});

describe('scoreRepo', () => {
  it('returns 1.0 for exact match', () => {
    expect(scoreRepo('clawd-monitor', 'clawd-monitor')).toBe(1.0);
  });

  it('returns 0.8 when repo contains keyword', () => {
    expect(scoreRepo('clawd-monitor-agent', 'clawd-monitor')).toBe(0.8);
  });

  it('returns 0.7 when keyword contains repo name', () => {
    expect(scoreRepo('clawd', 'clawd-monitor')).toBe(0.7);
  });

  it('returns partial score for shared words', () => {
    const score = scoreRepo('monitor-dashboard', 'clawd-monitor');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.8);
  });

  it('returns 0 for no match', () => {
    expect(scoreRepo('totally-unrelated', 'clawd-monitor')).toBe(0);
  });
});

describe('getPriorityFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns only existing files', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test');
    const result = getPriorityFiles(tmpDir);
    expect(result).toContain('README.md');
    expect(result).not.toContain('docs/architecture.md');
  });

  it('returns defaults for non-existent path', () => {
    const result = getPriorityFiles('/nonexistent/path');
    expect(result).toContain('README.md');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('discoverRepos', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-ws-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('finds directories with .git', () => {
    const repoPath = path.join(tmpDir, 'my-repo');
    fs.mkdirSync(repoPath);
    fs.mkdirSync(path.join(repoPath, '.git'));
    const result = discoverRepos(tmpDir);
    expect(result).toContain('my-repo');
  });

  it('ignores non-git directories', () => {
    fs.mkdirSync(path.join(tmpDir, 'not-a-repo'));
    const result = discoverRepos(tmpDir);
    expect(result).not.toContain('not-a-repo');
  });

  it('returns empty array for nonexistent workspace', () => {
    expect(discoverRepos('/nonexistent')).toEqual([]);
  });
});

describe('inferRelatedComponents', () => {
  it('includes web UI for monitor keywords', () => {
    expect(inferRelatedComponents('clawd-monitor')).toContain('Web UI');
  });

  it('includes OpenClaw Gateway for agent keywords', () => {
    expect(inferRelatedComponents('clawd-agent')).toContain('OpenClaw Gateway');
  });

  it('returns core service as fallback', () => {
    expect(inferRelatedComponents('random-tool')).toContain('Core service');
  });

  it('deduplicates components', () => {
    const result = inferRelatedComponents('clawd-monitor-agent');
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });
});

describe('route', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-route-'));
    // Create some fake repos
    for (const name of ['clawd-monitor', 'clawd-monitor-agent', 'unrelated-tool']) {
      const p = path.join(tmpDir, name);
      fs.mkdirSync(p);
      fs.mkdirSync(path.join(p, '.git'));
      fs.writeFileSync(path.join(p, 'README.md'), `# ${name}`);
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('finds relevant repos for keyword', () => {
    const result = route({ keyword: 'clawd-monitor', workspace: tmpDir });
    expect(result.primary_repos).toContain('clawd-monitor');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('domain is normalized keyword', () => {
    const result = route({ keyword: 'Clawd Monitor', workspace: tmpDir });
    expect(result.domain).toBe('clawd-monitor');
  });

  it('always includes forbidden jumps', () => {
    const result = route({ keyword: 'anything', workspace: tmpDir });
    expect(result.forbidden_initial_jumps.length).toBeGreaterThan(0);
  });

  it('handles empty workspace', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-empty-'));
    const result = route({ keyword: 'clawd-monitor', workspace: emptyDir });
    expect(result.primary_repos).toContain('clawd-monitor');
    fs.rmSync(emptyDir, { recursive: true });
  });
});

describe('findNpmDependency', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-npm-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('finds dependency in package.json', () => {
    const repoPath = path.join(tmpDir, 'my-app');
    fs.mkdirSync(repoPath);
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
      dependencies: { 'clawd-monitor': '^1.0.0' },
    }));
    const result = findNpmDependency(repoPath, 'clawd-monitor');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('npm');
    expect(result!.detail).toContain('clawd-monitor');
  });

  it('finds devDependency', () => {
    const repoPath = path.join(tmpDir, 'my-app');
    fs.mkdirSync(repoPath);
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
      devDependencies: { 'clawd-monitor': '2.0.0' },
    }));
    const result = findNpmDependency(repoPath, 'clawd-monitor');
    expect(result).not.toBeNull();
  });

  it('returns null when no match', () => {
    const repoPath = path.join(tmpDir, 'my-app');
    fs.mkdirSync(repoPath);
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
      dependencies: { 'express': '^4.0.0' },
    }));
    expect(findNpmDependency(repoPath, 'clawd-monitor')).toBeNull();
  });

  it('returns null when no package.json', () => {
    const repoPath = path.join(tmpDir, 'my-app');
    fs.mkdirSync(repoPath);
    expect(findNpmDependency(repoPath, 'clawd-monitor')).toBeNull();
  });
});

describe('findEntrypointReference', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-entry-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('finds keyword in related_components', () => {
    const repoPath = path.join(tmpDir, 'my-app');
    fs.mkdirSync(repoPath);
    fs.writeFileSync(path.join(repoPath, 'AGENT_ENTRYPOINT.yaml'),
      'related_components:\n  - clawd-monitor\n  - agent-tasks\n');
    const result = findEntrypointReference(repoPath, 'clawd-monitor');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('entrypoint');
    expect(result!.detail).toContain('clawd-monitor');
  });

  it('returns null when no match', () => {
    const repoPath = path.join(tmpDir, 'my-app');
    fs.mkdirSync(repoPath);
    fs.writeFileSync(path.join(repoPath, 'AGENT_ENTRYPOINT.yaml'),
      'related_components:\n  - something-else\n');
    expect(findEntrypointReference(repoPath, 'clawd-monitor')).toBeNull();
  });

  it('returns null when no entrypoint file', () => {
    const repoPath = path.join(tmpDir, 'my-app');
    fs.mkdirSync(repoPath);
    expect(findEntrypointReference(repoPath, 'clawd-monitor')).toBeNull();
  });
});

describe('impact', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-impact-'));
    const repos = ['app-a', 'app-b', 'app-c'];
    for (const name of repos) {
      const p = path.join(tmpDir, name);
      fs.mkdirSync(p);
      fs.mkdirSync(path.join(p, '.git'));
    }
    // app-a depends on clawd-monitor via npm
    fs.writeFileSync(path.join(tmpDir, 'app-a', 'package.json'), JSON.stringify({
      dependencies: { 'clawd-monitor': '^1.0.0' },
    }));
    // app-b references clawd-monitor via entrypoint
    fs.writeFileSync(path.join(tmpDir, 'app-b', 'AGENT_ENTRYPOINT.yaml'),
      'related_components:\n  - clawd-monitor\n');
    // app-c has no relation
    fs.writeFileSync(path.join(tmpDir, 'app-c', 'package.json'), JSON.stringify({
      dependencies: { 'express': '^4.0.0' },
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('finds npm and entrypoint dependents', () => {
    const result = impact('clawd-monitor', tmpDir);
    expect(result.keyword).toBe('clawd-monitor');
    expect(result.dependents.length).toBe(2);
    expect(result.dependents.find(d => d.repo === 'app-a')?.type).toBe('npm');
    expect(result.dependents.find(d => d.repo === 'app-b')?.type).toBe('entrypoint');
  });

  it('returns empty for unknown keyword', () => {
    const result = impact('nonexistent-package', tmpDir);
    expect(result.dependents).toHaveLength(0);
  });

  it('handles empty workspace', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-empty-'));
    const result = impact('clawd-monitor', emptyDir);
    expect(result.dependents).toHaveLength(0);
    fs.rmSync(emptyDir, { recursive: true });
  });
});
