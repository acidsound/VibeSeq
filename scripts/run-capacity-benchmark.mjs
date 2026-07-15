import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync(
  process.execPath,
  ['--expose-gc', 'node_modules/vitest/vitest.mjs', 'run', 'tests/benchmarks/capacity.benchmark.test.ts', '--reporter=verbose'],
  {
    cwd: process.cwd(),
    env: { ...process.env, VIBESEQ_CAPACITY_BENCHMARK: '1' },
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
