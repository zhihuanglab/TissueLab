/**
 * Preferences > AI Models: the local (anonymous) session opens Preferences from
 * the sidebar, sees what .env.local configures, saves an override that the
 * service applies at once, and gets a bad endpoint rejected with the reason.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { e2eEnv, expect, test } from './fixtures';
import { bootSession } from './helpers';

const KEY = 'sk-e2e-key-000011112222';
const settingsFile = () => path.join(process.env.TL_E2E_SERVICE_ROOT!, 'storage', 'llm_settings.json');

async function openPreferences(page: Page, idToken: string) {
  await bootSession(page, idToken);
  await page.getByRole('button', { name: 'Preferences', exact: true }).first().click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'AI Models' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Preferences: AI models', () => {
  test.afterEach(async ({ request }) => {
    // Back to .env.local for every other spec.
    const fields = Object.fromEntries(
      ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'LLM_MODEL', 'LLM_API', 'DISCOVERY_BASE_URL', 'DISCOVERY_API_KEY', 'DISCOVERY_MODEL']
        .map((name) => [name, '']),
    );
    await request.put(`${e2eEnv().backendOrigin}/api/agent/v1/model_settings`, { data: { fields } });
  });

  test('shows the .env.local connection, saves an override, applies it at once', async ({ page, guards }) => {
    const dialog = await openPreferences(page, guards.firebase.idToken);
    const status = dialog.getByTestId('model-settings-status');

    // The e2e service runs on the mock LLM from its environment.
    await expect(status).toContainText('Agent: ready');
    await expect(status).toContainText('Chat Completions');
    await expect(status).toContainText('Research: ready (gpt-5.4)');
    await expect(dialog.getByLabel('Agent endpoint')).toHaveAttribute('placeholder', /\(from \.env\.local\)$/);
    await expect(dialog.getByLabel('Agent API key')).toHaveAttribute('placeholder', /^•••• \(from \.env\.local\)$/);

    await dialog.getByLabel('Agent model').fill('e2e-model');
    await dialog.getByLabel('Agent API key').fill(KEY);
    await dialog.getByLabel('Research model').fill('gpt-5.4-mini');
    const saved = page.waitForResponse((r) => r.url().endsWith('/agent/v1/model_settings') && r.request().method() === 'PUT');
    await dialog.getByRole('button', { name: 'Save AI Models' }).click();
    const reply = await saved;
    expect(await reply.text()).not.toContain(KEY);

    await expect(dialog.getByText('Saved — in effect now.')).toBeVisible();
    await expect(status).toContainText('Agent: ready (e2e-model, Chat Completions)');
    await expect(status).toContainText('Research: ready (gpt-5.4-mini)');
    await expect(dialog.getByLabel('Agent API key')).toHaveValue('');
    await expect(dialog.getByLabel('Agent API key')).toHaveAttribute('placeholder', 'Saved ••••2222 — type to replace');
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).toMatchObject({ LLM_MODEL: 'e2e-model', OPENAI_API_KEY: KEY });

    // Reopening shows what the service kept; Remove drops the saved key again.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Preferences', exact: true }).first().click();
    await expect(dialog.getByLabel('Agent model')).toHaveValue('e2e-model');
    await dialog.getByRole('button', { name: 'Remove' }).click();
    await dialog.getByRole('button', { name: 'Save AI Models' }).click();
    await expect(dialog.getByLabel('Agent API key')).toHaveAttribute('placeholder', /\(from \.env\.local\)$/);
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).OPENAI_API_KEY).toBeUndefined();

    expect(guards.pageErrors).toEqual([]);
  });

  test('a bad endpoint is rejected with the reason and nothing changes', async ({ page, guards }) => {
    const dialog = await openPreferences(page, guards.firebase.idToken);
    await dialog.getByLabel('Agent endpoint').fill('localhost:11434');
    await dialog.getByRole('button', { name: 'Save AI Models' }).click();
    await expect(dialog.getByText(/OPENAI_BASE_URL must be an http\(s\) URL/)).toBeVisible();
    await expect(dialog.getByTestId('model-settings-status')).toContainText('Agent: ready');
    expect(guards.pageErrors).toEqual([]);
  });
});
