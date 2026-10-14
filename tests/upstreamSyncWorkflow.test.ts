import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';

interface WorkflowStep {
  name: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps: WorkflowStep[];
    }
  >;
}

const root = resolve(import.meta.dir, '..');
const document = parseDocument(
  readFileSync(resolve(root, '.github/workflows/upstream-sync.yml'), 'utf8')
);
const workflow = document.toJS() as Workflow;
const steps = workflow.jobs.sync.steps;

test('remote setup supports fresh and reused checkouts and fetches intended upstream', () => {
  const cwd = mkdtempSync(resolve(root, '.upstream-sync-test-'));
  const upstreamUrl = 'https://github.com/router-for-me/Cli-Proxy-API-Management-Center.git';
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const run = (directory: string, command: string, args: string[]): string => {
    const result = spawnSync(command, args, { cwd: directory, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const git = (...args: string[]) => run(cwd, 'git', args);
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Workflow Test');
    git('config', 'user.email', 'workflow-test@example.invalid');
    writeFileSync(resolve(cwd, 'upstream.txt'), 'intended upstream');
    git('add', 'upstream.txt');
    git('commit', '-m', 'upstream');
    const upstreamHead = git('rev-parse', 'HEAD');
    const checkout = resolve(cwd, 'checkout');
    git('init', '-b', 'main', checkout);
    const checkoutGit = (...args: string[]) => run(checkout, 'git', args);
    checkoutGit('config', `url.${cwd}.insteadOf`, upstreamUrl);
    const setup = steps.find((step) => step.name === 'Add upstream remote')!;
    const fetch = steps.find((step) => step.name === 'Fetch upstream')!;
    for (const state of ['absent', 'correct', 'stale']) {
      if (state === 'stale') {
        checkoutGit('remote', 'set-url', 'upstream', resolve(cwd, 'missing-repository'));
      }
      run(checkout, 'bash', ['-e', '-o', 'pipefail', '-c', setup.run!]);
      expect(checkoutGit('config', '--get', 'remote.upstream.url')).toBe(upstreamUrl);
      run(checkout, 'bash', ['-e', '-o', 'pipefail', '-c', fetch.run!]);
      expect(checkoutGit('rev-parse', 'upstream/main')).toBe(upstreamHead);
      expect(checkoutGit('show', 'upstream/main:upstream.txt')).toBe('intended upstream');
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

test('maintenance token cannot publish repository refs or modify contributor PRs', () => {
  expect(document.errors).toEqual([]);
  expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write' });
  for (const job of Object.values(workflow.jobs)) {
    expect(job.permissions).toBeUndefined();
  }
  expect(workflow.on.workflow_dispatch).toBeNull();
  expect(steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with?.ref).toBe('main');
});

test('only clean, verified integration history is eligible for artifact handoff', () => {
  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))!;
  expect(upload.with?.['if-no-files-found']).toBe('error');
  expect(upload.with?.path).toBe('upstream-sync.bundle');
  const eligible = new Function('steps', `return (${upload.if});`) as (
    context: Record<string, { outputs: Record<string, string> }>
  ) => boolean;
  for (const hasChanges of ['true', 'false']) {
    for (const merged of ['true', 'false']) {
      for (const verified of ['true', 'false']) {
        expect(
          eligible({
            check: { outputs: { has_changes: hasChanges } },
            merge: { outputs: { passed: merged } },
            gate: { outputs: { passed: verified } },
          })
        ).toBe(hasChanges === 'true' && merged === 'true' && verified === 'true');
      }
    }
  }
});

test('handoff bundle imports both merge parents without changing existing refs', () => {
  const cwd = mkdtempSync(resolve(root, '.upstream-sync-test-'));
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_OUTPUT: resolve(cwd, 'outputs'),
  };
  const run = (
    command: string,
    args: string[],
    env: Record<string, string | undefined> = environment
  ): string => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const git = (...args: string[]) => run('git', args);
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Workflow Test');
    git('config', 'user.email', 'workflow-test@example.invalid');
    writeFileSync(resolve(cwd, 'shared.txt'), 'base');
    git('add', '.');
    git('commit', '-m', 'base');
    git('checkout', '-b', 'upstream');
    writeFileSync(resolve(cwd, 'upstream.txt'), 'upstream feature');
    git('add', 'upstream.txt');
    git('commit', '-m', 'upstream');
    const upstreamHead = git('rev-parse', 'HEAD');
    git('checkout', 'main');
    writeFileSync(resolve(cwd, 'fork.txt'), 'fork feature');
    git('add', 'fork.txt');
    git('commit', '-m', 'fork');
    const baseHead = git('rev-parse', 'HEAD');
    git('branch', 'archive/ccs-main');
    const createBranch = steps.find((step) => step.id === 'branch')!;
    run('bash', ['-e', '-o', 'pipefail', '-c', createBranch.run!]);
    git('merge', '--no-edit', 'upstream');
    const mergedHead = git('rev-parse', 'HEAD');
    const handoff = steps.find((step) => step.name === 'Prepare pipeline handoff')!;
    run('bash', ['-e', '-o', 'pipefail', '-c', handoff.run!], {
      ...environment,
      BASE_HEAD: baseHead,
    });
    git('bundle', 'verify', 'upstream-sync.bundle');
    git('fetch', './upstream-sync.bundle', 'HEAD:imported');
    expect(git('rev-parse', 'imported')).toBe(mergedHead);
    expect(git('show', 'imported:fork.txt')).toBe('fork feature');
    expect(git('show', 'imported:upstream.txt')).toBe('upstream feature');
    expect(git('rev-parse', 'imported^1')).toBe(baseHead);
    expect(git('rev-parse', 'imported^2')).toBe(upstreamHead);
    expect(git('rev-parse', 'main')).toBe(baseHead);
    expect(git('rev-parse', 'archive/ccs-main')).toBe(baseHead);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
