import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readFileIfExists,
  extractPurpose,
  extractComponents,
  extractRequiredConfig,
  extractRuntimeModel,
  resolve,
  DEFAULT_MUST_READ,
} from '../lib';

describe('readFileIfExists', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfr-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns file contents if file exists', () => {
    const file = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(file, 'hello world');
    expect(readFileIfExists(file)).toBe('hello world');
  });

  it('returns null if file does not exist', () => {
    expect(readFileIfExists('/nonexistent/file.txt')).toBeNull();
  });
});

describe('extractPurpose', () => {
  it('extracts description after title', () => {
    const content = '# My Tool\n\nThis tool monitors OpenClaw agents in real-time.\n\n## Usage';
    expect(extractPurpose(content)).toBe('This tool monitors OpenClaw agents in real-time.');
  });

  it('falls back to description pattern', () => {
    const content = 'Description: Manages GitHub issues for agents';
    expect(extractPurpose(content)).toBe('Manages GitHub issues for agents');
  });

  it('returns fallback for empty content', () => {
    expect(extractPurpose('')).toBe('Purpose not documented');
  });
});

describe('extractRequiredConfig', () => {
  it('parses env variable names', () => {
    const env = 'GATEWAY_URL=https://example.com\nTOKEN=secret\nPORT=3000\n# comment=ignored';
    const result = extractRequiredConfig(env);
    expect(result).toContain('GATEWAY_URL');
    expect(result).toContain('TOKEN');
    expect(result).toContain('PORT');
    expect(result).not.toContain('comment');
  });

  it('ignores comment lines', () => {
    const env = '# DB_URL=ignored\nAPI_KEY=real';
    expect(extractRequiredConfig(env)).toEqual(['API_KEY']);
  });
});

describe('extractRuntimeModel', () => {
  it('detects Docker', () => {
    expect(extractRuntimeModel('Run with docker-compose up')).toContain('Docker container deployment');
  });

  it('detects systemd', () => {
    expect(extractRuntimeModel('Install as systemd service')).toContain('systemd service');
  });

  it('returns fallback for empty', () => {
    expect(extractRuntimeModel('No runtime info here')).toContain('Runtime model not documented');
  });
});

describe('resolve', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfr-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('reads files that exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'README.md'),
      '# Clawd Monitor\n\nMonitors OpenClaw agents.\n\n## Components\n- **Frontend**: React UI\n- **Backend**: Node.js'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.env.example'),
      'GATEWAY_URL=http://localhost:3001\nTOKEN=your-token'
    );

    const result = resolve({ repo_path: tmpDir });
    expect(result.sources_read).toContain('README.md');
    expect(result.sources_read).toContain('.env.example');
    expect(result.ready_for_analysis).toBe(true);
    expect(result.system_summary.required_config).toContain('GATEWAY_URL');
  });

  it('marks missing files as missing', () => {
    const result = resolve({ repo_path: tmpDir });
    expect(result.sources_missing).toContain('README.md');
    expect(result.ready_for_analysis).toBe(false);
    expect(result.unknowns.length).toBeGreaterThan(0);
  });

  it('uses custom must_read list', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n\nA test tool.');
    const result = resolve({ repo_path: tmpDir, must_read: ['README.md'] });
    expect(result.sources_read).toEqual(['README.md']);
  });

  it('has default must_read list', () => {
    expect(DEFAULT_MUST_READ).toContain('README.md');
  });
});
