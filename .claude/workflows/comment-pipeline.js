export const meta = {
  name: 'comment-pipeline',
  description: 'Implement freely, refine comments into code with a record, then restore the comments the code still needs',
  whenToUse: 'Writing or finishing a change where comments should be distilled into types, guards, tests and names. Pass {task} to implement first, or {base, pass1} to refine an existing commit.',
  phases: [
    { title: 'Implement', detail: 'write the change with comments as usual' },
    { title: 'Refine', detail: 'move comment knowledge into code; record every comment' },
    { title: 'Check', detail: 'record covers every comment; ci/check.sh passes' },
    { title: 'Restore', detail: 'fresh reviewer puts back the comments the code still needs' },
  ],
}

const repoDir = args?.repoDir ?? '.'
const pipelineDir = args?.pipelineDir ?? '.claude/comment-pipeline'
const MAX_REFINE_ATTEMPTS = 2

const IMPLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string', description: 'full sha of HEAD before you started' },
    pass1: { type: 'string', description: 'full sha of your commit' },
    summary: { type: 'string' },
  },
  required: ['base', 'pass1', 'summary'],
}

const REFINE_SCHEMA = {
  type: 'object',
  properties: {
    refined: { type: 'string', description: 'full sha of your commit' },
    recordPath: { type: 'string', description: 'absolute path of the record file' },
    summary: { type: 'string' },
  },
  required: ['refined', 'recordPath', 'summary'],
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    recordOk: { type: 'boolean' },
    ciPassed: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
    removedTestExpectations: { type: 'array', items: { type: 'string' } },
    dispositions: { type: 'object' },
  },
  required: ['recordOk', 'ciPassed', 'problems', 'removedTestExpectations'],
}

const RESTORE_SCHEMA = {
  type: 'object',
  properties: {
    commit: { type: 'string', description: 'full sha of your commit, or empty if nothing was restored' },
    ciPassed: { type: 'boolean' },
    restored: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          text: { type: 'string' },
          rule: { type: 'string', enum: ['interface', 'sourced-reason', 'documented-external-fact'] },
          source: { type: 'string' },
        },
        required: ['file', 'text', 'rule', 'source'],
      },
    },
    forHuman: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          text: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['file', 'text', 'why'],
      },
    },
  },
  required: ['commit', 'ciPassed', 'restored', 'forHuman'],
}

const commonRules = `Work in the git repository at ${repoDir}. Commit on its current branch; do not push, and do not touch other branches.
\`ci/check.sh\` is the merge gate if the repository has one; you may run its steps directly.`

let base = args?.base
let pass1 = args?.pass1
let implemented = null

if (args?.task) {
  phase('Implement')
  implemented = await agent(
    `${commonRules}

Record the full sha of HEAD before you change anything; that is the base.

Implement this task fully, as you would for a real pull request (code, tests, docs):

${args.task}

Write comments and docstrings as you normally would. They are the record of what you know while writing: workarounds, reasons, facts about other systems, what a caller must know. A later pass decides where each one belongs, so don't hold back and don't load the before-writing-comments skill.

Make the checks pass, then commit your work as one commit.`,
    { label: 'implement', phase: 'Implement', schema: IMPLEMENT_SCHEMA },
  )
  if (!implemented) throw new Error('the implement pass did not finish')
  base = implemented.base
  pass1 = implemented.pass1
} else if (!base || !pass1) {
  throw new Error('pass {task} to implement first, or {base, pass1} to refine an existing commit')
}

log(`refining ${base.slice(0, 7)}..${pass1.slice(0, 7)} in ${repoDir}`)

const refinePrompt = (feedback) => `${commonRules}

Read ${pipelineDir}/refine.md and follow it. It replaces the installed before-writing-comments skill; don't load that skill.

The commit to refine is ${pass1}; its parent range is ${base}..${pass1} (see \`git -C ${repoDir} diff ${base} ${pass1}\`). Make sure ${pass1} is checked out at HEAD of the current branch before you start, and commit your work on top of it.

Write the record to the file \`comment-pipeline/record.json\` inside the repository's git directory (\`git -C ${repoDir} rev-parse --absolute-git-dir\`), creating the folder if needed, and return its absolute path. Before you finish, run \`node ${pipelineDir}/check-record.mjs ${repoDir} ${base} ${pass1} <record path> HEAD\` and fix every problem it lists.${feedback}`

const checkPrompt = (refined, recordPath) => `Run these in ${repoDir} and report the results; change nothing.

1. \`node ${pipelineDir}/check-record.mjs ${repoDir} ${base} ${pass1} ${recordPath} ${refined}\`. It prints JSON. recordOk is its exit status being 0; copy its problems, removedTestExpectations and dispositions.
2. \`ci/check.sh\` if it exists (or its lint, build and test steps if a step needs the network). ciPassed is whether they all passed; add each failure to problems.`

phase('Refine')
let refinedResult = await agent(refinePrompt(''), { label: 'refine', phase: 'Refine', schema: REFINE_SCHEMA })
if (!refinedResult) throw new Error('the refine pass did not finish')

let check = null
for (let attempt = 1; attempt <= MAX_REFINE_ATTEMPTS; attempt++) {
  check = await agent(checkPrompt(refinedResult.refined, refinedResult.recordPath), {
    label: `check ${attempt}`,
    phase: 'Check',
    schema: CHECK_SCHEMA,
    effort: 'low',
  })
  if (!check) throw new Error('the check did not finish')
  if (check.recordOk && check.ciPassed) break
  log(`check ${attempt}: ${check.problems.length} problem(s)`)
  if (attempt === MAX_REFINE_ATTEMPTS) break
  const retried = await agent(
    refinePrompt(`

This is a second attempt. Your previous commit is ${refinedResult.refined} and your record is at ${refinedResult.recordPath}. Fix these and commit again on top:
${check.problems.map((problem) => `- ${problem}`).join('\n')}`),
    { label: `refine ${attempt + 1}`, phase: 'Refine', schema: REFINE_SCHEMA },
  )
  if (!retried) throw new Error('the refine retry did not finish')
  refinedResult = retried
}

if (check.removedTestExpectations.length > 0) {
  log(`${check.removedTestExpectations.length} test expectation line(s) changed in refine; listed in the result for review`)
}
if (!(check.recordOk && check.ciPassed)) {
  log('the refined commit still fails its checks; skipping restore')
  return { base, pass1, implemented, refined: refinedResult, check, restore: null }
}

phase('Restore')
const restore = await agent(
  `${commonRules}

Read ${pipelineDir}/restore.md and follow it.

- The record: ${refinedResult.recordPath}
- The first commit's diff: \`git -C ${repoDir} diff ${base} ${pass1}\`
- The refine diff: \`git -C ${repoDir} diff ${pass1} ${refinedResult.refined}\`

HEAD is ${refinedResult.refined}. Commit your changes on top of it.`,
  { label: 'restore', phase: 'Restore', schema: RESTORE_SCHEMA },
)

return { base, pass1, implemented, refined: refinedResult, check, restore }
