import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';

// Workflow YAML is the GitHub Actions scheduling contract. The owner's rule
// requires every job to use this project's King server pool, without hosted fallback.
const workflowDir = resolve(import.meta.dir, '../.github/workflows');
const workflows = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));

test.each(workflows)('%s schedules every job on the King server pool', (name) => {
  const document = parseDocument(readFileSync(resolve(workflowDir, name), 'utf8'));
  expect(document.errors).toEqual([]);
  const workflow = document.toJS() as {
    jobs: Record<string, { 'runs-on': unknown }>;
  };
  expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0);
  for (const job of Object.values(workflow.jobs)) {
    const selector = job['runs-on'];
    expect(Array.isArray(selector)).toBe(true);
    expect(selector).toContain('self-hosted');
    expect(selector).toContain('king-server');
    expect(selector).toContain('cpamc');
    expect((selector as string[]).some((label) => /^(ubuntu|windows|macos)-/.test(label))).toBe(
      false
    );
  }
});
