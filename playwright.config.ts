import { defineConfig } from '@playwright/test'

const externalBaseURL = process.env.VIBESEQ_E2E_BASE_URL?.replace(/\/$/, '')
const realMediumEnabled = process.env.VIBESEQ_REAL_MEDIUM_E2E === '1'
const backendPort = realMediumEnabled ? 8790 : 8791
const frontendPort = 4181

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: externalBaseURL ?? `http://127.0.0.1:${frontendPort}`,
    browserName: 'chromium',
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
  },
  webServer: externalBaseURL ? undefined : [
    {
      command: realMediumEnabled
        ? `VIBESEQ_PORT=${backendPort} VIBESEQ_INSTALL_MODELS=1 VIBESEQ_GENERATION_PROVIDER=stable-audio-3 VIBESEQ_TRANSCRIPTION_PROVIDER=muscriptor VIBESEQ_TARGET=local ./scripts/run-inference.sh`
        : `VIBESEQ_PORT=${backendPort} VIBESEQ_GENERATION_PROVIDER=procedural-demo VIBESEQ_TRANSCRIPTION_PROVIDER=signal-demo ./scripts/run-inference.sh`,
      url: `http://127.0.0.1:${backendPort}/api/health`,
      // A reused fixture port can silently attach the suite to a slow real
      // model process. Only an explicit real-Medium run may reuse port 8790.
      reuseExistingServer: realMediumEnabled,
      timeout: realMediumEnabled ? 180_000 : 30_000,
    },
    {
      command: `VIBESEQ_INFERENCE_URL=http://127.0.0.1:${backendPort} npm run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
