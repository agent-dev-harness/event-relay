import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const entryPoints = [
    'src/index.ts',
    'src/contract.ts',
    'src/kinds/index.ts',
    'src/sources/github/index.ts',
];

rmSync('dist', { recursive: true, force: true });

// splitting keeps one copy of each module shared by the entrypoints (the
// GitHub source uses core helpers) instead of bundling it into each of them.
await build({
    entryPoints,
    outbase: 'src',
    outdir: 'dist',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    sourcemap: true,
    tsconfig: 'tsconfig.json',
});

execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });

// tsc keeps the sources' extensionless relative imports in the declarations, which consumers on
// moduleResolution node16/nodenext can't resolve, so every type would silently become `any`.
// Point each one at the emitted file.
function addDeclarationExtensions(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            addDeclarationExtensions(file);
            continue;
        }
        if (!entry.name.endsWith('.d.ts')) continue;
        const source = readFileSync(file, 'utf8');
        const rewritten = source.replace(/(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]*?)\2/g, (match, lead, quote, spec) => {
            const target = path.resolve(dir, spec);
            if (existsSync(`${target}.d.ts`)) return `${lead}${quote}${spec}.js${quote}`;
            if (existsSync(path.join(target, 'index.d.ts'))) return `${lead}${quote}${spec}/index.js${quote}`;
            return match;
        });
        if (rewritten !== source) writeFileSync(file, rewritten);
    }
}

addDeclarationExtensions('dist');
