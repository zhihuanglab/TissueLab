import { e2eEnv, expect, test } from './fixtures';
import { openAgentChat, openSlide, sendChat } from './helpers';

/** Whatever the chat calls after the entrance agent has classified the prompt. */
const AGENT_ACTION = /\/agent\/v1\/(chat|get_steps|process_script)(\?|$)/;

test.describe('agent chat in the viewer (mock LLM)', () => {
  test.beforeEach(async ({ page }) => {
    const { slideName } = e2eEnv();
    test.skip(!slideName, 'no test slide available (set TL_TEST_SLIDE)');
    await openSlide(page, slideName!);
    await openAgentChat(page);
  });

  test('"hello" is routed to /agent/v1/chat and the mock LLM reply is rendered', async ({ page, guards }) => {
    const { backendOrigin } = e2eEnv();

    const action = await sendChat(page, 'hello', AGENT_ACTION);
    expect(new URL(action.url()).origin).toBe(backendOrigin);
    // The entrance agent answered label "1" (general chat) — see the mock LLM.
    expect(guards.requests.some((u) => u.includes('/agent/v1/entrance_agent'))).toBe(true);
    expect(new URL(action.url()).pathname, 'a greeting must go to the QA endpoint, not workflow planning').toMatch(/\/agent\/v1\/chat$/);

    expect(action.status()).toBe(200);
    const body = await action.json();
    expect(body.code).toBe(0);
    expect(String(body.data?.response ?? '')).toMatch(/^mock reply/);

    // The user turn and the model's answer are both on screen.
    await expect(page.getByText('hello', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/mock reply/).first()).toBeVisible();
    expect(guards.pageErrors).toEqual([]);
  });

  test('"count tumor cells" produces a workflow card with the planned steps', async ({ page, guards }) => {
    const reply = await sendChat(page, 'count tumor cells', '/agent/v1/get_steps');
    expect(reply.status()).toBe(200);
    const body = await reply.json();
    expect(body.code).toBe(0);
    const steps: Array<{ step: number; model: string; impl?: string }> = body.data;
    expect(Array.isArray(steps) && steps.length > 0).toBe(true);

    // The chat renders "Here is the pipeline…" followed by a Workflow card
    // listing "<n>. <model>" for every step.
    await expect(page.getByText('Here is the pipeline I designed for you:')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Workflow' }).first()).toBeVisible();
    for (const step of steps) {
      await expect(page.getByText(`${step.step}. ${step.model}`, { exact: false }).first()).toBeVisible();
    }
    expect(steps.map((s) => s.model)).toContain('NucleiSeg');
    // The plan went through the entrance agent and reached the mock LLM via the local service.
    expect(guards.requests.some((u) => u.includes('/agent/v1/entrance_agent'))).toBe(true);
    expect(guards.pageErrors).toEqual([]);
  });
});
