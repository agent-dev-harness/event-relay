// Fails if anything under src/, test/ or scripts/ imports from outside the package, or if
// the contract or core imports a source. Keeping core free of sources is what lets a
// source move to its own package later without rewriting the core.
import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_ROOTS: readonly string[] = ['src', 'test', 'scripts'];
const ALLOWED_BARE_SPECS: ReadonlySet<string> = new Set(['vitest', 'typescript']);
const SOURCE_FREE: readonly string[] = ['src/contract.ts', 'src/core'];
const SOURCES_DIR = path.join(REPO_ROOT, 'src', 'sources');

interface FoundImport {
  file: string;
  line: number;
  spec: string;
}

function isInside(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function collectImports(absFile: string): FoundImport[] {
  const sourceFile = ts.createSourceFile(absFile, fs.readFileSync(absFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: FoundImport[] = [];
  const record = (node: ts.Node, spec: string): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    found.push({ file: absFile, line, spec });
  };
  const literal = (node: ts.Node | undefined): string => (node && ts.isStringLiteral(node) ? node.text : '<non-literal>');

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      record(node, literal(node.moduleSpecifier));
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      record(node, literal(ts.isLiteralTypeNode(arg) ? arg.literal : arg));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isMock = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'vi' && (callee.name.text === 'mock' || callee.name.text === 'doMock');
      if (isImport || isRequire || isMock) record(node, literal(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function walkTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTsFiles(file);
    return entry.name.endsWith('.ts') ? [file] : [];
  });
}

function problemWith({ file, spec }: FoundImport): string | null {
  const relative = spec.startsWith('./') || spec.startsWith('../');
  if (!relative) {
    return isBuiltin(spec) || ALLOWED_BARE_SPECS.has(spec) ? null : 'imports a package not on the allowed list';
  }
  const target = path.resolve(path.dirname(file), spec);
  if (!isInside(target, REPO_ROOT)) return 'imports from outside the package';
  const sourceFree = SOURCE_FREE.some((entry) => isInside(file, path.join(REPO_ROOT, entry)));
  if (sourceFree && isInside(target, SOURCES_DIR)) return 'the contract and core must not import a source';
  return null;
}

function main(): void {
  console.log('=== event-relay boundary guard ===');
  const files: string[] = [];
  for (const root of TARGET_ROOTS) {
    const rootAbs = path.join(REPO_ROOT, root);
    const rootFiles = fs.existsSync(rootAbs) ? walkTsFiles(rootAbs) : [];
    if (rootFiles.length === 0) {
      console.error(`\n❌ ERROR: "${root}" is missing or has no .ts files. Update TARGET_ROOTS rather than letting this check silently pass.\n`);
      process.exit(1);
    }
    files.push(...rootFiles);
  }
  const missing = SOURCE_FREE.filter((entry) => !fs.existsSync(path.join(REPO_ROOT, entry)));
  if (missing.length > 0) {
    console.error(`\n❌ ERROR: ${missing.join(', ')} not found. Update SOURCE_FREE rather than letting this check silently pass.\n`);
    process.exit(1);
  }

  const violations = files.flatMap(collectImports).flatMap((imp) => {
    const problem = problemWith(imp);
    return problem ? [`  ${path.relative(REPO_ROOT, imp.file)}:${imp.line}  "${imp.spec}"  ${problem}`] : [];
  });
  if (violations.length > 0) {
    console.error('\n❌ Boundary violation(s):');
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  console.log(`✅ Boundary clean: ${files.length} file(s) scanned.`);
}

main();
