import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

interface Violation {
  file: string;
  line: number;
  lineContent: string;
  reason: string;
}

function checkFileForViolations(filePath: string): Violation[] {
  const violations: Violation[] = [];

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const fileLines = content.split('\n');

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  function getLineNumber(pos: number): number {
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  }

  for (let i = 0; i < fileLines.length; i++) {
    const lineText = fileLines[i] || '';
    const lineNum = i + 1;
    if (/@ts-(?:ignore|expect-error)\b/.test(lineText)) {
      violations.push({
        file: filePath,
        line: lineNum,
        lineContent: lineText.trim(),
        reason: 'Usage of @ts-ignore or @ts-expect-error is forbidden by the type discipline guide.'
      });
    }
  }

  function visitAny(node: ts.Node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const startPos = node.getStart(sourceFile);
      const line = getLineNumber(startPos);

      violations.push({
        file: filePath,
        line,
        lineContent: fileLines[line - 1]?.trim() || '',
        reason: 'Explicit "any" type usage is forbidden in src.'
      });
    }
    ts.forEachChild(node, visitAny);
  }

  visitAny(sourceFile);

  return violations;
}

function walkDir(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walkDir(filePath));
    } else if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      results.push(filePath);
    }
  }
  return results;
}

function main() {
  console.log('=== Checking for explicit "any", @ts-ignore, or @ts-expect-error in src ===');

  const targetDirs = [
    path.join(process.cwd(), 'src')
  ];

  const missingDirs = targetDirs.filter((dir) => !fs.existsSync(dir));
  if (missingDirs.length > 0) {
    console.error('\n❌ ERROR: Expected target directory does not exist:\n');
    for (const dir of missingDirs) {
      console.error(`  ${path.relative(process.cwd(), dir)}`);
    }
    console.error(
      '\nThis usually means the source tree has been reorganized and this script\'s ' +
      'targetDirs are stale. Update scripts/check-explicit-any.ts to match, ' +
      'rather than letting this check silently no-op.\n'
    );
    process.exit(1);
  }

  const filesToCheck: string[] = [];
  for (const dir of targetDirs) {
    filesToCheck.push(...walkDir(dir));
  }

  if (filesToCheck.length === 0) {
    console.error(
      '\n❌ ERROR: Target directories exist but contain no .ts/.tsx files to check. ' +
      'Refusing to silently pass.\n'
    );
    process.exit(1);
  }

  const violations: Violation[] = [];

  for (const file of filesToCheck) {
    const fileViolations = checkFileForViolations(file);
    violations.push(...fileViolations);
  }

  if (violations.length > 0) {
    console.error('\n❌ ERROR: Type discipline violations found in src:\n');
    for (const violation of violations) {
      const relPath = path.relative(process.cwd(), violation.file);
      console.error(`  File: ${relPath}`);
      console.error(`  Line ${violation.line}: ${violation.lineContent}`);
      console.error(`  Reason: ${violation.reason}\n`);
    }
    console.error('Please specify a more specific type instead of "any", or use "unknown". No escape hatches allowed.\n');
    process.exit(1);
  }

  console.log('✅ No explicit "any" or banned TS comments detected in target paths.');
  process.exit(0);
}

main();
