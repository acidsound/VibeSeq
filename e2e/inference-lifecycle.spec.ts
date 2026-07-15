import { expect, test, type Page, type Route } from '@playwright/test'

type MockJobOptions = {
  id: string
  cancelStatus?: number
  cancelDelayMs?: number
}

async function installRunningGeneration(page: Page, options: MockJobOptions) {
  let polls = 0
  let deletes = 0
  let shouldComplete = false

  const recoveredAssetUrl = `/api/assets/${options.id}-recovered.wav`
  await page.route(`**${recoveredAssetUrl}`, async (route) => {
    await route.fulfill({
      contentType: 'audio/wav',
      body: Buffer.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69]),
    })
  })

  await page.route('**/api/generate', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: options.id,
        kind: 'generate',
        status: 'queued',
        progress: 0,
      }),
    })
  })

  await page.route(`**/api/jobs/${options.id}`, async (route: Route) => {
    if (route.request().method() === 'DELETE') {
      deletes += 1
      if (options.cancelDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.cancelDelayMs))
      }
      const status = options.cancelStatus ?? 200
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: status >= 400
          ? JSON.stringify({ detail: 'injected cancellation failure' })
          : JSON.stringify({ id: options.id, status: 'cancelled' }),
      })
      return
    }

    polls += 1
    if (shouldComplete) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: options.id,
          kind: 'generate',
          status: 'completed',
          progress: 1,
          result: {
            assetId: `${options.id}-asset`,
            assetUrl: recoveredAssetUrl,
            duration: 4,
            sampleRate: 44_100,
            provider: 'procedural-demo',
            device: 'cpu',
          },
        }),
      })
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: options.id,
        kind: 'generate',
        status: 'running',
        progress: Math.min(0.9, 0.1 + polls * 0.05),
      }),
    })
  })

  return {
    pollCount: () => polls,
    deleteCount: () => deletes,
    complete: () => { shouldComplete = true },
  }
}

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible()
}

async function startGeneration(page: Page) {
  await page.getByLabel(/PROMPT/).fill('durable inference lifecycle test')
  await page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  await expect(page.getByRole('progressbar', { name: 'Generating a local variation' })).toBeVisible()
}

test('submitted job identity is durable before progress can starve autosave', async ({ page }) => {
  const job = await installRunningGeneration(page, { id: 'durable-running-job' })
  await openStudio(page)
  await startGeneration(page)

  // The polling loop begins only after the explicit submission checkpoint.
  // Multiple 350 ms updates would otherwise keep resetting the 450 ms save.
  await expect.poll(job.pollCount).toBeGreaterThanOrEqual(3)
  await page.reload()

  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('progressbar', { name: 'Reconnecting to generation' })).toBeVisible()
  await expect.poll(job.pollCount).toBeGreaterThanOrEqual(4)
})

test('a recovered candidate keeps the exact seed stored with its submitted job', async ({ page }) => {
  const job = await installRunningGeneration(page, { id: 'seed-recovery-job' })
  await openStudio(page)
  const seed = page.getByRole('spinbutton', { name: 'Generation seed', exact: true })
  await seed.fill('68309')
  await seed.press('Enter')
  await startGeneration(page)
  await expect.poll(job.pollCount).toBeGreaterThanOrEqual(1)

  await page.reload()
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('progressbar', { name: 'Reconnecting to generation' })).toBeVisible()
  job.complete()

  const recovered = page.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(recovered).toBeVisible()
  await expect(recovered).toContainText('Seed 68309')
})

test('failed cancellation stays active, records the error, and reconnects after reload', async ({ page }) => {
  const job = await installRunningGeneration(page, {
    id: 'cancel-failure-job',
    cancelStatus: 503,
  })
  await openStudio(page)
  await startGeneration(page)
  await expect.poll(job.pollCount).toBeGreaterThanOrEqual(1)
  const pollsBeforeCancel = job.pollCount()

  await page.getByRole('button', { name: 'Cancel job' }).click()

  await expect.poll(job.deleteCount).toBe(1)
  await expect(page.getByText(/Cancellation was not confirmed · reconnecting:/)).toBeVisible()
  await expect(page.locator('.job-strip')).toBeVisible()
  await expect(page.getByRole('progressbar', { name: 'Reconnecting to generation' })).toBeVisible()
  await expect.poll(job.pollCount).toBeGreaterThan(pollsBeforeCancel)

  await page.reload()
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('progressbar', { name: 'Reconnecting to generation' })).toBeVisible()
})

test('successful cancellation keeps the job visible until DELETE confirms it', async ({ page }) => {
  const job = await installRunningGeneration(page, {
    id: 'delayed-cancel-job',
    cancelDelayMs: 600,
  })
  await openStudio(page)
  await startGeneration(page)

  await page.getByRole('button', { name: 'Cancel job' }).click()

  await expect(page.getByRole('progressbar', { name: 'Cancelling inference job…' })).toBeVisible()
  await expect.poll(job.deleteCount).toBe(1)
  await expect(page.locator('.job-strip')).toHaveCount(0)
  await expect(page.getByText('Inference job cancelled')).toBeVisible()
})
