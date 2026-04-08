import * as fs from 'fs';
import * as path from 'path';

export interface ReadmeFirstInput {
  repo_path: string;
  must_read?: string[];
}

export interface SystemSummary {
  purpose: string;
  main_components: string[];
  runtime_model: string[];
  required_config: string[];
}

export interface ReadmeFirstOutput {
  system_summary: SystemSummary;
  unknowns: string[];
  sources_read: string[];
  sources_missing: string[];
  ready_for_analysis: boolean;
}

export const DEFAULT_MUST_READ = ['README.md', 'AGENT_ENTRYPOINT.yaml', '.env.example'];

/** Read a file if it exists, return null otherwise */
export function readFileIfExists(filePath: string): string | null {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return null;
}

/** Extract purpose from README content */
export function extractPurpose(content: string): string {
  const lines = content.split('\n');

  // Find first non-empty line after the title
  let foundTitle = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      foundTitle = true;
      continue;
    }

    if (foundTitle && trimmed.length > 10) {
      return trimmed.replace(/^[>*_]+|[>*_]+$/g, '').trim();
    }
  }

  // Fallback: look for description-like content
  const descMatch = content.match(/(?:Description|About|What is|Purpose)[:\s]+([^\n]+)/i);
  if (descMatch) return descMatch[1].trim();

  return 'Purpose not documented';
}

/** Extract component names from README */
export function extractComponents(content: string): string[] {
  const components: string[] = [];

  // Look for component/service mentions in headers and lists
  const patterns = [
    /#+\s+(?:Components?|Services?|Architecture)/i,
    /[-*]\s+`([^`]+)`/g,
    /\*\*([^*]+)\*\*:/g,
  ];

  // Find component sections
  const sectionMatch = content.match(/#+\s+(?:components?|services?|architecture|structure)[^\n]*\n([\s\S]*?)(?=\n#+|\z)/i);
  if (sectionMatch) {
    const items = sectionMatch[1].match(/[-*]\s+([^\n]+)/g) || [];
    components.push(...items.slice(0, 5).map(i => i.replace(/^[-*]\s+/, '').split(' ')[0]));
  }

  // Look for bold labels
  const boldMatches = content.matchAll(/\*\*([^*]{3,30})\*\*/g);
  for (const m of boldMatches) {
    if (!m[1].includes(' ') || m[1].split(' ').length <= 3) {
      components.push(m[1]);
    }
  }

  // Deduplicate and limit
  return [...new Set(components)].slice(0, 6);
}

/** Extract config requirements from .env.example */
export function extractRequiredConfig(envContent: string): string[] {
  return envContent
    .split('\n')
    .filter(line => line.match(/^[A-Z_]+=/) && !line.startsWith('#'))
    .map(line => line.split('=')[0].trim())
    .slice(0, 10);
}

/** Extract runtime model hints from README */
export function extractRuntimeModel(content: string): string[] {
  const hints: string[] = [];

  if (content.match(/docker|container/i)) hints.push('Docker container deployment');
  if (content.match(/systemd|service file/i)) hints.push('systemd service');
  if (content.match(/npm start|node .*/i)) hints.push('Node.js process');
  if (content.match(/agent.*run|run.*agent/i)) hints.push('Agent process on host');
  if (content.match(/gateway/i)) hints.push('OpenClaw Gateway integration');
  if (content.match(/websocket|ws:\/\//i)) hints.push('WebSocket connection');

  if (hints.length === 0) hints.push('Runtime model not documented');

  return hints;
}

/** Main resolver function */
export function resolve(input: ReadmeFirstInput): ReadmeFirstOutput {
  const mustRead = input.must_read ?? DEFAULT_MUST_READ;
  const sourcesRead: string[] = [];
  const sourcesMissing: string[] = [];

  let readmeContent = '';
  let envContent = '';

  for (const file of mustRead) {
    const fullPath = path.join(input.repo_path, file);
    const content = readFileIfExists(fullPath);

    if (content !== null) {
      sourcesRead.push(file);
      if (file.toLowerCase().includes('readme')) readmeContent = content;
      if (file.includes('.env')) envContent = content;
    } else {
      sourcesMissing.push(file);
    }
  }

  const unknowns: string[] = [];
  if (sourcesMissing.includes('README.md')) {
    unknowns.push('No README found — system purpose unclear');
  }
  if (sourcesMissing.includes('.env.example')) {
    unknowns.push('No .env.example — required config unknown');
  }
  if (sourcesMissing.includes('docs/architecture.md')) {
    unknowns.push('No architecture docs found');
  }

  const purpose = readmeContent ? extractPurpose(readmeContent) : 'Purpose not documented';
  const components = readmeContent ? extractComponents(readmeContent) : [];
  const runtimeModel = readmeContent ? extractRuntimeModel(readmeContent) : ['Runtime model not documented'];
  const requiredConfig = envContent ? extractRequiredConfig(envContent) : [];

  // Ready if we at least read the README
  const ready_for_analysis = sourcesRead.includes('README.md');

  return {
    system_summary: {
      purpose,
      main_components: components.length > 0 ? components : ['Components not listed'],
      runtime_model: runtimeModel,
      required_config: requiredConfig,
    },
    unknowns,
    sources_read: sourcesRead,
    sources_missing: sourcesMissing,
    ready_for_analysis,
  };
}
