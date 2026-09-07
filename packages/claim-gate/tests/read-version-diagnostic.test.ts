// Asserts readVersion() writes one stderr diagnostic naming the package and
// the failure when package.json cannot be read or parsed, or has a missing,
// empty, or non-string "version" field, instead of silently falling back to
// "0.0.0". A mutant that drops the stderr write (in the catch block or the
// missing-version branch) must fail these tests. Also asserts the
// diagnostic write itself never throws (a throwing process.stderr.write, a
// throwing Error#message getter, or a throwing String(err) on a non-Error
// value) and that a multi-line error message is collapsed to a single
// stderr line.

import { describe, expect, it, vi } from "vitest";

import { readVersion } from "../src/cli.js";

describe("readVersion diagnostics", () => {
  it("reports 0.0.0 and writes a stderr line naming the package on a read failure (ENOENT)", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const read = vi.fn(() => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      });
      const result = readVersion(new URL("file:///nonexistent/package.json"), read);
      expect(result).toBe("0.0.0");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain("claim-gate");
      expect(line).toContain("could not read version from package.json");
      expect(line).toContain("ENOENT");
      expect(line).toContain("0.0.0");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("reports 0.0.0 and writes a stderr line naming the package on invalid JSON", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const read = vi.fn(() => "{not valid json");
      const result = readVersion(new URL("file:///nonexistent/package.json"), read);
      expect(result).toBe("0.0.0");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain("claim-gate");
      expect(line).toContain("could not read version from package.json");
      expect(line).toContain("0.0.0");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('reports 0.0.0 and writes a stderr line naming the package when "version" is missing', () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const read = vi.fn(() => JSON.stringify({ name: "claim-gate" }));
      const result = readVersion(new URL("file:///nonexistent/package.json"), read);
      expect(result).toBe("0.0.0");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain("claim-gate");
      expect(line).toContain('has no "version" field');
      expect(line).toContain("0.0.0");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('reports 0.0.0 and writes a stderr line naming the package when "version" is an empty string', () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const read = vi.fn(() => JSON.stringify({ version: "" }));
      const result = readVersion(new URL("file:///nonexistent/package.json"), read);
      expect(result).toBe("0.0.0");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain("claim-gate");
      expect(line).toContain('has no "version" field');
      expect(line).toContain("0.0.0");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("returns the real version and writes nothing to stderr on success", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const read = vi.fn(() => JSON.stringify({ version: "9.9.9" }));
      const result = readVersion(new URL("file:///fake/package.json"), read);
      expect(result).toBe("9.9.9");
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("reports 0.0.0 and never throws when process.stderr.write itself throws (bad fd)", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("EBADF: bad file descriptor");
    });
    try {
      const read = vi.fn(() => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      });
      let result: string | undefined;
      expect(() => {
        result = readVersion(new URL("file:///nonexistent/package.json"), read);
      }).not.toThrow();
      expect(result).toBe("0.0.0");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('reports 0.0.0 and writes a stderr line naming the package when "version" is not a string', () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const read = vi.fn(() => JSON.stringify({ version: 1 }));
      const result = readVersion(new URL("file:///nonexistent/package.json"), read);
      expect(result).toBe("0.0.0");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain("claim-gate");
      expect(line).toContain('has no "version" field');
      expect(line).toContain("0.0.0");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("reports 0.0.0 and never throws when the thrown value is not an Error and String() on it throws", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const read = vi.fn(() => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw {
          toString() {
            throw new Error("toString exploded");
          },
          [Symbol.toPrimitive]() {
            throw new Error("toPrimitive exploded");
          },
        };
      });
      let result: string | undefined;
      expect(() => {
        result = readVersion(new URL("file:///nonexistent/package.json"), read);
      }).not.toThrow();
      expect(result).toBe("0.0.0");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("collapses a multi-line error message to exactly one stderr line", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const read = vi.fn(() => {
        throw new Error("line one\nline two\nline three");
      });
      const result = readVersion(new URL("file:///nonexistent/package.json"), read);
      expect(result).toBe("0.0.0");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      const newlineCount = (line.match(/\n/g) ?? []).length;
      expect(newlineCount).toBe(1);
      expect(line.endsWith("\n")).toBe(true);
      expect(line).toContain("line one line two line three");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
