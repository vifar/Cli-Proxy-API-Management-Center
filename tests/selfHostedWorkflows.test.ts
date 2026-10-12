import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';

// Workflow YAML is the GitHub Actions scheduling contract. The owner's rule
// requires every job to use this project's King server pool, without hosted fallback.
const workflowDir = resolve(import.meta.dir, '../.github/workflows');
const workflows = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));

interface WorkflowContract {
  on: Record<string, unknown>;
  jobs: Record<
    string,
    {
      'runs-on': string[];
      steps: { uses?: string; run?: string; with?: Record<string, unknown> }[];
    }
  >;
}

const contracts = Object.fromEntries(
  workflows.map((name) => [
    name,
    parseDocument(readFileSync(resolve(workflowDir, name), 'utf8')).toJS() as WorkflowContract,
  ])
);

test('workflow scheduling retains one PR suite and only the original tag release trigger', () => {
  expect(Object.keys(contracts).sort()).toEqual([
    'ci.yml',
    'no-mistakes-required.yml',
    'release.yml',
    'upstream-sync.yml',
  ]);
  expect(contracts['release.yml'].on).toEqual({ push: { tags: ['v*'] } });
  expect(Object.keys(contracts['ci.yml'].jobs)).toEqual(['verify']);
  expect(contracts['ci.yml'].on.pull_request).toBeNull();
  const steps = contracts['ci.yml'].jobs.verify.steps;
  expect(
    steps
      .filter((step) => step.uses?.startsWith('actions/setup-node@'))
      .map((step) => step.with?.['node-version'])
  ).toEqual(['24']);
  expect(
    steps
      .filter((step) => step.uses?.startsWith('oven-sh/setup-bun@'))
      .map((step) => step.with?.['bun-version'])
  ).toEqual(['1.3.14']);
  expect(steps.filter((step) => step.run).map((step) => step.run)).toEqual([
    'bun install --frozen-lockfile',
    'bun run verify',
  ]);
});

test('the required PR check consumes only the approved immutable vifar action', () => {
  const check = contracts['no-mistakes-required.yml'];
  expect(check.on.pull_request).toEqual({
    types: ['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review'],
    branches: ['main'],
  });
  expect(check.jobs.check.steps.map((step) => step.uses)).toEqual([
    'vifar/no-mistakes/.github/actions/require-no-mistakes@43617132cf4d0fb1ced04cc7eda6b0b2bb9d25eb',
  ]);
});

test.each(workflows)('%s schedules every job on the King server pool', (name) => {
  const document = parseDocument(readFileSync(resolve(workflowDir, name), 'utf8'));
  expect(document.errors).toEqual([]);
  const workflow = document.toJS() as {
    jobs: Record<string, { 'runs-on': unknown }>;
  };
  expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0);
  for (const job of Object.values(workflow.jobs)) {
    const selector = job['runs-on'];
    expect(selector).toEqual(['self-hosted', 'Linux', 'X64', 'king-server', 'cpamc']);
    expect(Array.isArray(selector)).toBe(true);
    expect(selector).toContain('self-hosted');
    expect(selector).toContain('king-server');
    expect(selector).toContain('cpamc');
    expect((selector as string[]).some((label) => /^(ubuntu|windows|macos)-/.test(label))).toBe(
      false
    );
  }
});
