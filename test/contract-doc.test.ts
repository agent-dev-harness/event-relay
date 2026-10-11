import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GAP_KIND, type KindSpec } from '../src/contract';
import * as kinds from '../src/kinds/index';

const doc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'contract.md'), 'utf8');

const isKindSpec = (value: unknown): value is KindSpec =>
  typeof value === 'object' && value !== null && 'kind' in value && 'coalesceKey' in value;

const exportedKinds = [...Object.values(kinds).filter(isKindSpec).map((spec) => spec.kind), GAP_KIND];

describe('docs/contract.md', () => {
  it('finds the kinds it checks', () => {
    expect(exportedKinds.length).toBeGreaterThan(1);
  });

  it.each(exportedKinds)('documents %s in its own section', (kind) => {
    expect(doc).toContain(`### \`${kind}\``);
  });
});
