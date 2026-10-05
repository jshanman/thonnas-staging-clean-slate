import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const FORBIDDEN = [
  'ObserveSignoz',
  'ColumnarClickHouse',
  'observe-signoz',
  'collectorSignozBoot',
  'dashboardSignozBoot',
  'ColumnarStack',
  'columnar-store',
  'infra.db.columnar',
  'THONNAS_COLUMNAR_',
  'ColumnarStore',
];

// @intent Fail if vendor/legacy columnar construct names reappear in production surfaces
describe('vendor-agnostic naming', () => {
  it('rejects banned vendor strings under stacks, bindings, mapping, runtime, stack-status', () => {
    const roots = [
      path.join(__dirname, '..', 'stacks'),
      path.join(__dirname, '..', 'release', 'bindings.ts'),
      path.join(__dirname, '..', 'release', 'ecs-fargate.ts'),
      path.join(__dirname, 'strategy-mapping.ts'),
      path.join(__dirname, '..', 'cdk', 'runtime.ts'),
      path.join(__dirname, '..', 'planner', 'stack-status.ts'),
    ];
    const files: string[] = [];
    for (const root of roots) {
      const stat = fs.statSync(root);
      if (stat.isFile()) {
        files.push(root);
        continue;
      }
      for (const name of fs.readdirSync(root)) {
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
        files.push(path.join(root, name));
      }
    }
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const token of FORBIDDEN) {
        if (text.includes(token)) hits.push(`${path.relative(path.join(__dirname, '..'), file)}:${token}`);
      }
    }
    expect(hits).toEqual([]);
  });
});



