// Asserts readPackageVersion() writes one stderr diagnostic naming the
// package and the failure when package.json cannot be read or parsed, or
// is missing its "version" field, instead of silently falling back to
// '0.0.0'. A mutant that drops the stderr write (in the catch block or the
// missing-version branch) must fail these tests.

import { describe, expect, it, vi } from 'vitest';

import { readPackageVersion } from '../src/server.js';

describe('readPackageVersion diagnostics', () => {
  it('reports 0.0.0 and writes a stderr line naming the package on a read failure (ENOENT)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const read = vi.fn(() => {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      });
      const result = readPackageVersion(new URL('file:///nonexistent/package.json'), read);
      expect(result).toBe('0.0.0');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain('grounding-mcp');
      expect(line).toContain('ENOENT');
      expect(line).toContain('0.0.0');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('reports 0.0.0 and writes a stderr line naming the package on invalid JSON', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const read = vi.fn(() => '{not valid json');
      const result = readPackageVersion(new URL('file:///nonexistent/package.json'), read);
      expect(result).toBe('0.0.0');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain('grounding-mcp');
      expect(line).toContain('0.0.0');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('reports 0.0.0 and writes a stderr line naming the package when "version" is missing', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const read = vi.fn(() => JSON.stringify({ name: 'grounding-mcp' }));
      const result = readPackageVersion(new URL('file:///nonexistent/package.json'), read);
      expect(result).toBe('0.0.0');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain('grounding-mcp');
      expect(line).toContain('version');
      expect(line).toContain('0.0.0');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns the real version and writes nothing to stderr on success', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const read = vi.fn(() => JSON.stringify({ version: '9.9.9' }));
      const result = readPackageVersion(new URL('file:///fake/package.json'), read);
      expect(result).toBe('9.9.9');
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('reports 0.0.0 and never throws when process.stderr.write itself throws (bad fd)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('EBADF: bad file descriptor');
    });
    try {
      const read = vi.fn(() => {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      });
      let result: string | undefined;
      expect(() => {
        result = readPackageVersion(new URL('file:///nonexistent/package.json'), read);
      }).not.toThrow();
      expect(result).toBe('0.0.0');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('reports 0.0.0 and writes a stderr line naming the package when "version" is not a string', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const read = vi.fn(() => JSON.stringify({ version: 1 }));
      const result = readPackageVersion(new URL('file:///nonexistent/package.json'), read);
      expect(result).toBe('0.0.0');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain('grounding-mcp');
      expect(line).toContain('version');
      expect(line).toContain('0.0.0');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
