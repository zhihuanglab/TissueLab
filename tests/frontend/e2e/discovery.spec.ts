/**
 * The Research panel (discovery) end to end: browser -> renderer -> service ->
 * Docker sandbox, with the scripted Responses server standing in for the model
 * (tests/smoke/mock_discovery_llm.py). The data is a synthetic cohort written
 * next to the test slide, so the panel's workspace (the open slide's folder)
 * holds it.
 *
 * Needs Docker (every proposer / worker step runs in a container); skipped otherwise.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Page, Response } from '@playwright/test';

import { e2eEnv, expect, test } from './fixtures';
import { openAgentChat, openSlide } from './helpers';

// The program the first test types, and the problem.md the panel writes from it.
const PROGRAM = 'Which cell-composition measurements predict the score? Adjust for age and sex.';
const PROBLEM = `---
outcome: score
covariates: [age, sex]
cohort_file: cases.csv
id_column: case
slide_column: slide
---
${PROGRAM}
`;
const QUESTION = 'The fraction of Alpha cells inside the Inner region tracks the score';

const workspace = () => path.join(process.env.TL_E2E_SERVICE_ROOT!, 'storage', 'uploads', 'users', 'local');
const runsDir = () => path.join(workspace(), 'autoresearch_runs');

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function openResearchPanel(page: Page): Promise<void> {
  await openSlide(page, e2eEnv().slideName!);
  await openAgentChat(page);
  await page.getByRole('combobox').filter({ hasText: /^Agent$/ }).click();
  await page.getByRole('option', { name: 'Research' }).click();
  await expect(programBox(page)).toBeVisible();
}

const programBox = (page: Page) => page.getByLabel('Research Program');
const summary = (page: Page) => page.getByTestId('program-summary');

async function startRun(page: Page, rounds: number): Promise<Response> {
  await page.locator('input[type="number"]').first().fill(String(rounds));
  const started = page.waitForResponse((r) => r.url().endsWith('/agent/v1/discovery/runs') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start Research' }).click();
  return started;
}

const findings = (page: Page) => page.getByText('Research Findings');
// The first test's run: the later ones reuse its dataset guide.
let firstRunId = '';

function resultsRows(runId: string): string[] {
  const file = path.join(runsDir(), runId, 'results.tsv');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').slice(1) : [];
}

test.describe.configure({ mode: 'serial' });

test.describe('Research panel (discovery, scripted model, real sandbox)', () => {
  test.beforeAll(() => {
    test.skip(!e2eEnv().slideName, 'no test slide available (set TL_TEST_SLIDE)');
    test.skip(!dockerAvailable(), 'Docker is not available');
    const python = process.env.TL_PYTHON || 'python3';
    execFileSync(python, [path.join(__dirname, 'make_discovery_dataset.py'), workspace()], { stdio: 'inherit' });
  });

  test.afterAll(() => {
    for (const name of ['discovery_slides', 'autoresearch_runs', 'cases.csv', 'problem.md']) {
      fs.rmSync(path.join(workspace(), name), { recursive: true, force: true });
    }
  });

  test('a one-round run: plain-text program, live progress, findings, and its folder', async ({ page, guards }) => {
    test.setTimeout(420_000);
    await openResearchPanel(page);

    // No problem.md yet: an empty program, and the cohort table already found.
    await expect(programBox(page)).toHaveValue('');
    await expect(summary(page)).toContainText('cases.csv · 14 patients · 14 slides found');
    await expect(page.getByRole('switch', { name: 'Dataset scout' })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Start Research' })).toBeDisabled();

    // Plain words: the outcome and covariates are read off the column names it mentions.
    await programBox(page).fill(PROGRAM);
    await expect(summary(page)).toContainText(/Predict score · adjust for age, sex\s*\(named in your text\)/);
    await expect(page.getByRole('button', { name: 'Start Research' })).toBeEnabled();

    const started = await startRun(page, 1);
    const body = await started.json();
    expect(body.code, JSON.stringify(body)).toBe(0);
    const runId: string = body.data.run_id;
    firstRunId = runId;

    // Live progress: the hypothesis the proposer committed to, both agents, the journal.
    await expect(page.getByText(QUESTION).first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('Proposer & Worker')).toBeVisible();
    await expect(findings(page)).toBeVisible({ timeout: 360_000 });
    await expect(page.getByText('Research Journal')).toBeVisible();
    await expect(page.getByText(/Outcome: score/)).toBeVisible();
    await expect(page.getByText(/Accepted panel members: [1-5]/)).toBeVisible();
    await expect(page.getByText('Round 1', { exact: true })).toBeVisible();

    // The run folder: the judged round, the findings, the problem it ran.
    const rows = resultsRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('alpha_inner_fraction');
    expect(rows[0]).toContain('\tkeep\t');
    expect(fs.readFileSync(path.join(runsDir(), runId, 'research_findings.md'), 'utf8')).toContain('Outcome: score');
    expect(fs.readFileSync(path.join(workspace(), 'problem.md'), 'utf8')).toBe(PROBLEM);
    // The sandbox saw the id-only cohort: the proposer's probe printed no outcome column.
    const probe = fs.readFileSync(path.join(runsDir(), runId, 'round_0001', 'proposer', 'sandbox', 'logs', 'turn_01.stdout.txt'), 'utf8');
    expect(probe).toContain('case,slide,mpp');
    expect(probe).not.toContain('score');
    // The dataset scout ran first, as outcome-blind as the proposer, and its guide is shared.
    const scoutProbe = fs.readFileSync(path.join(runsDir(), runId, 'scout', 'sandbox', 'logs', 'turn_01.stdout.txt'), 'utf8');
    expect(scoutProbe).toContain('case,slide,mpp');
    expect(scoutProbe).not.toContain('score');
    expect(fs.readFileSync(path.join(runsDir(), runId, 'shared', 'dataset_guide.md'), 'utf8')).toContain('# Dataset guide');

    expect(guards.pageErrors).toEqual([]);
  });

  test('stop mid-run, find it in the history, and resume it to completion', async ({ page, guards }) => {
    test.setTimeout(420_000);
    await openResearchPanel(page);

    // The previous run saved problem.md: its text is back, and what it predicts.
    await expect(programBox(page)).toHaveValue(PROGRAM);
    await expect(summary(page)).toContainText('Predict score · adjust for age, sex');
    // Its dataset guide is offered, and reused by default: no second scout.
    await expect(page.getByLabel('Dataset guide')).toContainText(`Reuse the guide from ${firstRunId}`);

    const started = await startRun(page, 1);
    const runId: string = (await started.json()).data.run_id;
    const guide = (id: string) => fs.readFileSync(path.join(runsDir(), id, 'shared', 'dataset_guide.md'), 'utf8');
    expect(guide(runId)).toBe(guide(firstRunId));
    expect(fs.existsSync(path.join(runsDir(), runId, 'scout'))).toBe(false);
    await expect(page.getByText(QUESTION).first()).toBeVisible({ timeout: 120_000 });

    const cancel = page.waitForResponse((r) => r.url().endsWith(`/runs/${runId}/cancel`));
    await page.getByRole('button', { name: 'Stop' }).click();
    expect((await (await cancel).json()).code).toBe(0);
    await expect(page.getByRole('button', { name: 'New Research Task', exact: true })).toBeVisible();
    // Stopping is not an error: no red box (e.g. the aborted stream's message).
    await expect(page.locator('.bg-red-50')).toHaveCount(0);

    // History lists the stopped run as incomplete; opening it offers to resume.
    await page.getByRole('button', { name: 'Run history' }).click();
    const entry = page.getByRole('button').filter({ hasText: runId });
    await expect(entry).toContainText(/incomplete/i);
    await entry.click();
    await expect(page.getByText('Incomplete run detected')).toBeVisible();

    // The stopped run's threads may still be winding down: the service refuses
    // to resume until the folder is quiet, so retry for a while.
    await expect(async () => {
      const resumed = page.waitForResponse((r) => r.url().endsWith('/agent/v1/discovery/runs/resume'));
      await page.getByRole('button', { name: 'Resume Run' }).click();
      const reply = await (await resumed).json();
      if (reply.code !== 0) {
        await page.getByRole('button', { name: 'Run history' }).click();
        await page.getByRole('button').filter({ hasText: runId }).click();
      }
      expect(reply.code, JSON.stringify(reply)).toBe(0);
    }).toPass({ timeout: 90_000, intervals: [3_000] });

    await expect(findings(page)).toBeVisible({ timeout: 360_000 });
    expect(resultsRows(runId)).toHaveLength(1);

    await page.getByRole('button', { name: 'Run history' }).click();
    await expect(page.getByRole('button').filter({ hasText: runId })).toContainText(/completed/i);
    expect(guards.pageErrors).toEqual([]);
  });

  test('a problem that does not match the data is rejected with the reason', async ({ page, guards }) => {
    await openResearchPanel(page);
    // "New research task" starts over from the workspace's problem.md.
    await programBox(page).fill('');
    await page.getByRole('button', { name: 'New research task', exact: true }).click();
    await expect(programBox(page)).toHaveValue(PROGRAM);

    // A program that names no column, as in the first panel: the model chooses from the column names.
    await programBox(page).fill('# Program\nIterative biomarker discovery on these slides.\n## Goal\nFind robust tissue features.');
    await expect(summary(page)).toContainText(/Predict score · adjust for age, sex\s*\(chosen by AI\)/, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Start Research' })).toBeEnabled();
    // "Change" overrides it.
    await summary(page).getByRole('button', { name: 'Change' }).click();
    await page.getByLabel('Outcome').click();
    await page.getByRole('option', { name: /^age/ }).click();
    await expect(summary(page)).toContainText(/Predict age · adjust for sex\s*\(your choice\)/);

    // "Explore the folder anew" is one choice away.
    await page.getByLabel('Dataset guide').click();
    await page.getByRole('option', { name: 'Explore the folder anew' }).click();
    await expect(page.getByLabel('Dataset guide')).toContainText('Explore the folder anew');

    // A full problem.md goes as written; a column the cohort lacks is refused.
    await programBox(page).fill(PROBLEM.replace('outcome: score', 'outcome: survival'));
    await expect(summary(page)).toContainText('Using the problem.md header as written: predict survival');
    const before = fs.readdirSync(runsDir()).length;
    const started = await startRun(page, 1);
    expect((await started.json()).code).toBe(400);
    await expect(page.getByText(/cases\.csv lacks column\(s\) \['survival'\]/)).toBeVisible();
    expect(fs.readdirSync(runsDir()).length).toBe(before);
    expect(guards.pageErrors).toEqual([]);
  });
});
