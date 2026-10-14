import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
      steps: {
        uses?: string;
        run?: string;
        if?: string | boolean;
        'continue-on-error'?: boolean | string;
        with?: Record<string, unknown>;
      }[];
    }
  >;
}

const contracts = Object.fromEntries(
  workflows.map((name) => [
    name,
    parseDocument(readFileSync(resolve(workflowDir, name), 'utf8')).toJS() as WorkflowContract,
  ])
);

test('workflow scheduling retains one PR suite without release automation', () => {
  expect(Object.keys(contracts).sort()).toEqual([
    'ci.yml',
    'no-mistakes-required.yml',
    'upstream-sync.yml',
  ]);
  for (const workflow of Object.values(contracts)) {
    expect(workflow.on).not.toHaveProperty('release');
    if (workflow.on.push !== undefined) {
      expect(workflow.on.push).toEqual({ branches: ['main', 'dev'] });
    }
  }
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
});

test('CI performs frozen installation before verification and propagates failures', () => {
  const steps = contracts['ci.yml'].jobs.verify.steps.filter((step) => step.run !== undefined);
  for (const step of steps) {
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error'] ?? false).toBe(false);
  }
  const cwd = mkdtempSync(resolve(import.meta.dir, '../.ci-workflow-test-'));
  const log = resolve(cwd, 'invocations');
  writeFileSync(
    resolve(cwd, 'bun'),
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$INVOCATION_LOG"\n' +
      'if [ "$1" = "$FAIL_COMMAND" ]; then exit 23; fi\n',
    { mode: 0o755 }
  );
  try {
    for (const failCommand of ['', 'install', 'run']) {
      writeFileSync(log, '');
      let status = 0;
      for (const step of steps) {
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run!], {
          cwd,
          env: {
            ...process.env,
            PATH: `${cwd}:${process.env.PATH}`,
            INVOCATION_LOG: log,
            FAIL_COMMAND: failCommand,
          },
          encoding: 'utf8',
        });
        if (result.error) throw result.error;
        expect(result.signal).toBeNull();
        status = result.status!;
        if (status !== 0) break;
      }
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(
        failCommand === 'install'
          ? ['install --frozen-lockfile']
          : ['install --frozen-lockfile', 'run verify']
      );
      expect(status).toBe(failCommand ? 23 : 0);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
