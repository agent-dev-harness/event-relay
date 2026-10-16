#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const USAGE = 'usage: check-record.mjs <repo-dir> <base> <pass1> <record.json> [<refined-ref>]';
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const DISPOSITIONS = new Set([
  'type', 'guard', 'structure', 'test', 'name', 'commit-message',
  'interface-doc-kept', 'kept', 'proposed', 'deleted-restates', 'deleted-wrong',
]);

const [repoDir, base, pass1, recordPath, refined = 'HEAD'] = process.argv.slice(2);
if (!recordPath) {
  console.error(USAGE);
  process.exit(2);
}

const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function addedCommentBlocks(from, to) {
  const blocks = [];
  let file = null;
  let line = 0;
  let current = null;
  for (const text of git('diff', '-U0', from, to).split('\n')) {
    if (text.startsWith('+++ ')) {
      file = text.startsWith('+++ b/') ? text.slice(6) : null;
      current = null;
    } else if (text.startsWith('@@')) {
      line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
      current = null;
    } else if (text.startsWith('+') && file && CODE_FILE.test(file)) {
      const body = text.slice(1);
      if (COMMENT_LINE.test(body)) {
        if (current) current.lines.push(body);
        else blocks.push((current = { file, line, lines: [body] }));
      } else {
        current = null;
      }
      line += 1;
    }
  }
  return blocks;
}

const normalize = (text) => text.replace(/^\s*(\/\/+|\/\*+|\*\/|\*)\s?/, '').replace(/\*\/\s*$/, '').replace(/\s+/g, ' ').trim();
const blockText = (lines) => lines.map(normalize).filter(Boolean).join(' ');
const MATCH_CHARS = 40;
const MIN_RECORDED_CHARS = 20;

const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const entries = Array.isArray(record.entries) ? record.entries : [];
const problems = [];

for (const [index, entry] of entries.entries()) {
  if (!DISPOSITIONS.has(entry.disposition)) problems.push(`entry ${index}: unknown disposition "${entry.disposition}"`);
  if (entry.disposition === 'proposed' && !(entry.proposedText && entry.source)) {
    problems.push(`entry ${index}: a proposed entry needs proposedText and source`);
  }
}

const blocks = addedCommentBlocks(base, pass1);
const missing = blocks.filter((block) => {
  const added = blockText(block.lines);
  return added !== '' && !entries.some((entry) => {
    const recorded = blockText([entry.text ?? '']);
    return entry.file === block.file && recorded.length >= Math.min(MIN_RECORDED_CHARS, added.length)
      && (added.includes(recorded.slice(0, MATCH_CHARS)) || recorded.includes(added.slice(0, MATCH_CHARS)));
  });
});
for (const block of missing) problems.push(`not in the record: ${block.file}:${block.line} ${blockText(block.lines).slice(0, 60)}`);

const removedExpectations = git('diff', '-U0', pass1, refined, '--', '*.test.*', '*.spec.*')
  .split('\n')
  .filter((text) => text.startsWith('-') && !text.startsWith('---') && /\bexpect\(/.test(text));

const counts = {};
for (const entry of entries) counts[entry.disposition] = (counts[entry.disposition] ?? 0) + 1;

console.log(JSON.stringify({
  pass1CommentBlocks: blocks.length,
  recordEntries: entries.length,
  dispositions: counts,
  removedTestExpectations: removedExpectations,
  problems,
}, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
