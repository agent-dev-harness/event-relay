import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    test: {
        environment: 'node',
        root,
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    },
});
