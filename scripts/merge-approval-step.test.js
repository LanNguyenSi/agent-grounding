/**
 * Replays `.github/workflows/merge-approval.yml`'s `id: release_exception`
 * `github-script` step body against stubbed `github`/`context`/`core`
 * objects, so a wiring defect in that inline block (an argument mixed up,
 * a call dropped, the `require()` path broken) fails a committed test
 * instead of surviving because the block sits outside every test suite.
 *
 * Extraction is line-range based, WITHOUT a YAML parser (js-yaml is not
 * resolvable from this worktree; see log.md): find the `- id:
 * release_exception` step, then its `script: |` key, then collect every
 * following line indented deeper than that key, stopping at the first
 * non-blank line indented at or shallower. The extracted text is asserted
 * non-empty and to contain `makeGetContentReader`, so a step that moved or
 * was renamed fails this test loudly instead of silently extracting
 * nothing (or someone else's step).
 *
 * The extracted body is compiled with the `AsyncFunction` constructor and
 * run with `github`, `context`, `core`, and `require` bound the same way
 * `actions/github-script` binds them, save that `require` here resolves
 * './scripts/release-exception.js' to the REAL module (via
 * `GITHUB_WORKSPACE` pointed at the repo root, exactly like the step
 * itself builds its path) rather than a stub, so this exercises the actual
 * classifier and reader together with the wiring around them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'merge-approval.yml');
const REPO_ROOT = path.join(__dirname, '..');

/**
 * Extracts the `script: |` body of the step whose `id:` equals `stepId`
 * from a GitHub Actions workflow YAML file's raw text, without parsing
 * YAML: finds the `id: <stepId>` line, then the next `script: |` line,
 * then every following line indented deeper than that key's own
 * indentation (blank lines included), stopping at the first non-blank
 * line that is not indented deeper. Returned text is de-indented by the
 * minimum indentation among the collected non-blank lines.
 *
 * @param {string} yamlText
 * @param {string} stepId
 * @returns {string}
 */
function extractStepScript(yamlText, stepId) {
  const lines = yamlText.split('\n');
  const idLineRe = new RegExp(`^\\s*id:\\s*${stepId}\\s*$`);
  let idLineIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (idLineRe.test(lines[i])) {
      idLineIndex = i;
      break;
    }
  }
  if (idLineIndex === -1) {
    throw new Error(`no "id: ${stepId}" line found in ${WORKFLOW_PATH}`);
  }

  const scriptKeyRe = /^(\s*)script:\s*\|\s*$/;
  let scriptIndent = -1;
  let scriptLineIndex = -1;
  for (let i = idLineIndex; i < lines.length; i += 1) {
    const m = scriptKeyRe.exec(lines[i]);
    if (m) {
      scriptIndent = m[1].length;
      scriptLineIndex = i;
      break;
    }
    // A blank line, or a line belonging to this step's own mapping (uses:,
    // with:), is expected before `script:`; a new step (a `- name:` at
    // shallower indentation) means this step has no `script:` key.
    if (/^\s*-\s+name:/.test(lines[i]) && i !== idLineIndex) {
      break;
    }
  }
  if (scriptLineIndex === -1) {
    throw new Error(`no "script: |" line found after "id: ${stepId}" in ${WORKFLOW_PATH}`);
  }

  const bodyLines = [];
  for (let i = scriptLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      bodyLines.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= scriptIndent) break;
    bodyLines.push(line);
  }

  const nonBlank = bodyLines.filter((l) => l.trim() !== '');
  if (nonBlank.length === 0) {
    throw new Error(`the "script: |" block for step "${stepId}" was empty`);
  }
  const minIndent = Math.min(...nonBlank.map((l) => l.length - l.trimStart().length));
  return bodyLines.map((l) => (l.trim() === '' ? '' : l.slice(minIndent))).join('\n');
}

/**
 * Compiles `body` (the extracted step script text) as the body of an
 * `async (github, context, core, require) => { ... }` function via the
 * `AsyncFunction` constructor, matching how `actions/github-script`
 * exposes those four bindings to a step's `script:`.
 *
 * @param {string} body
 * @returns {(github: unknown, context: unknown, core: unknown, req: NodeJS.Require) => Promise<void>}
 */
function compileStep(body) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('github', 'context', 'core', 'require', body);
}

// The step itself builds its module path from `process.env.GITHUB_WORKSPACE`
// (`path.join(process.env.GITHUB_WORKSPACE, 'scripts', 'release-exception.js')`),
// exactly the way the real workflow run does after Checkout puts the repo
// at `GITHUB_WORKSPACE`. Pointed at this repo's root, that produces an
// absolute path, so any `require` implementation resolves it the same way;
// `Module.createRequire` rooted at the repo also lets other `require()`
// calls the step body might add resolve node built-ins normally.
process.env.GITHUB_WORKSPACE = REPO_ROOT;

/**
 * A `require` bound the way `actions/github-script` binds it to a step
 * (able to resolve both bare specifiers and the absolute
 * `GITHUB_WORKSPACE`-rooted path the step itself constructs).
 *
 * @returns {NodeJS.Require}
 */
function repoRootRequire() {
  const req = Module.createRequire(path.join(REPO_ROOT, 'noop.js'));
  return (id) => req(id);
}

function makeCoreStub(outputs, summaryLines) {
  return {
    setOutput(name, value) {
      outputs[name] = value;
    },
    summary: {
      addHeading(text) {
        summaryLines.push(`# ${text}`);
        return this;
      },
      addRaw(text) {
        summaryLines.push(text);
        return this;
      },
      addList(items) {
        summaryLines.push(...items.map((i) => `- ${i}`));
        return this;
      },
      async write() {
        return this;
      },
    },
  };
}

function makeContext({ number = 1, baseSha = 'base-sha', headSha = 'head-sha' } = {}) {
  return {
    repo: { owner: 'o', repo: 'r' },
    payload: {
      pull_request: {
        number,
        changed_files: 1,
        base: { sha: baseSha },
        head: { sha: headSha },
      },
    },
  };
}

let cachedBody;
function stepBody() {
  if (!cachedBody) {
    const yamlText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    cachedBody = extractStepScript(yamlText, 'release_exception');
  }
  return cachedBody;
}

test('extractStepScript(): the release_exception step body is non-empty and names makeGetContentReader', () => {
  const body = stepBody();
  assert.ok(body.length > 0);
  assert.match(body, /makeGetContentReader/);
  assert.match(body, /classifyPullFiles/);
});

test('extractStepScript(): a workflow missing the requested step id throws', () => {
  assert.throws(() => extractStepScript('name: x\non: push\n', 'release_exception'), /no "id: release_exception" line/);
});

test('release_exception step replay: a pure version bump (both refs real files) sets pure_release=true', async () => {
  const files = [{ filename: 'package.json', status: 'modified' }];
  const getContentCalls = [];
  const github = {
    paginate: async (_fn, _opts) => files,
    rest: {
      pulls: { listFiles: async () => files },
      repos: {
        compareCommits: async () => ({ data: { merge_base_commit: { sha: 'merge-base-sha' } } }),
        getContent: async (params) => {
          getContentCalls.push(params);
          const versionAt = params.ref === 'merge-base-sha' ? '1.0.0' : '1.0.1';
          const content = Buffer.from(JSON.stringify({ version: versionAt }), 'utf8').toString('base64');
          return { data: { type: 'file', encoding: 'base64', content } };
        },
      },
    },
  };
  const outputs = {};
  const summaryLines = [];
  const core = makeCoreStub(outputs, summaryLines);
  const context = makeContext();

  const fn = compileStep(stepBody());
  await fn(github, context, core, repoRootRequire());

  assert.equal(outputs.pure_release, 'true');
  assert.ok(getContentCalls.length > 0);
  for (const call of getContentCalls) {
    assert.equal(call.owner, 'o');
    assert.equal(call.repo, 'r');
    assert.equal(call.path, 'package.json');
  }
  assert.ok(getContentCalls.some((c) => c.ref === 'merge-base-sha'));
  assert.ok(getContentCalls.some((c) => c.ref === 'head-sha'));
});

test('release_exception step replay: a submodule at head sets pure_release=false and names not-a-file-head in the summary', async () => {
  const files = [{ filename: 'package.json', status: 'modified' }];
  const github = {
    paginate: async () => files,
    rest: {
      pulls: { listFiles: async () => files },
      repos: {
        compareCommits: async () => ({ data: { merge_base_commit: { sha: 'merge-base-sha' } } }),
        getContent: async (params) => {
          if (params.ref === 'head-sha') {
            return { data: { type: 'submodule', submodule_git_url: 'https://example.com/x.git' } };
          }
          const content = Buffer.from(JSON.stringify({ version: '1.0.0' }), 'utf8').toString('base64');
          return { data: { type: 'file', encoding: 'base64', content } };
        },
      },
    },
  };
  const outputs = {};
  const summaryLines = [];
  const core = makeCoreStub(outputs, summaryLines);
  const context = makeContext();

  const fn = compileStep(stepBody());
  await fn(github, context, core, repoRootRequire());

  assert.equal(outputs.pure_release, 'false');
  assert.ok(summaryLines.some((l) => l.includes('not-a-file-head')));
});

test('release_exception step replay: an unresolved symlink at base sets pure_release=false and names not-a-file-base in the summary', async () => {
  const files = [{ filename: 'package.json', status: 'modified' }];
  const github = {
    paginate: async () => files,
    rest: {
      pulls: { listFiles: async () => files },
      repos: {
        compareCommits: async () => ({ data: { merge_base_commit: { sha: 'merge-base-sha' } } }),
        getContent: async (params) => {
          if (params.ref === 'merge-base-sha') {
            return { data: { type: 'symlink', target: '../outside-repo/version.json' } };
          }
          const content = Buffer.from(JSON.stringify({ version: '1.0.1' }), 'utf8').toString('base64');
          return { data: { type: 'file', encoding: 'base64', content } };
        },
      },
    },
  };
  const outputs = {};
  const summaryLines = [];
  const core = makeCoreStub(outputs, summaryLines);
  const context = makeContext();

  const fn = compileStep(stepBody());
  await fn(github, context, core, repoRootRequire());

  assert.equal(outputs.pure_release, 'false');
  assert.ok(summaryLines.some((l) => l.includes('not-a-file-base')));
});

module.exports = { extractStepScript };
