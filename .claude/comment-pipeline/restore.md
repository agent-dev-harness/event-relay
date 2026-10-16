# Restore: third pass over a refined commit

A first agent wrote a commit with comments. A second agent (the refine pass) moved that knowledge into types, guards, tests and names, removed the comments, and wrote a record of what happened to each one. You review that record with fresh eyes and put back the comments the code still needs. You did not write either commit; judge them as a reviewer.

You change comments only. Don't change code, tests or names.

## What you read

- The record: one entry per comment the first commit added, with its disposition.
- The first commit's diff (`<base>..<pass1>`): the comments as written.
- The refine diff (`<pass1>..<refined>`): what replaced them.

## Restore

Review every entry whose disposition is `proposed`, `deleted-restates` or `deleted-wrong`. For each, read the original comment and the code as it is now.

Put a comment back when it carries one of these, and only that part of it:

1. **Interface a caller can't see in the signature**, on something exported: what happens when an option is left out, a format, a unit, an obligation, what a value means ("null when …", "throws if …", "never trusted"). Write it as a docstring (`/** */`) stating what the caller sees, with no reasons, history or vendor facts.
2. **A reason or trade-off whose source can be checked**: the task, the human, the code, a test, or a doc in this repo. Name the source in your output. Write it as a docstring if it is on something exported, otherwise as a line comment, next to the code it explains.
3. **A fact about another system** (a vendor, a runtime, a host) only when the repo already states it somewhere (a doc, a test fixture, a commit message in this range). Otherwise don't restore it; put it in `forHuman` with the text and where it would go.

Don't restore:

- text the code now says itself through a type, guard message, test or name; check the `where` field and confirm it;
- anything the refined code made untrue; if the knowledge still matters, rewrite it to match the code;
- anything recorded as `deleted-wrong` whose reason holds up.

Check `interface-doc-kept` and `kept` entries too: if one carries a reason, a vendor fact or history, trim it to the interface.

## Checks

- Your diff (`<refined>..HEAD`) changes comment lines only. Confirm with `git diff <refined> -U0 -- <code paths>`: every added or removed line is a comment line.
- `ci/check.sh` passes (you may run `npm run lint`, `npm run build` and `npm test` directly).
- Commit on the current branch with a message listing what you restored and why.

## Output

Return, for each comment you restored, its file and line, the text, which rule above it falls under, and its source. Return in `forHuman` each claim you left out because nothing in the repo backs it, with the text and where it would go.
