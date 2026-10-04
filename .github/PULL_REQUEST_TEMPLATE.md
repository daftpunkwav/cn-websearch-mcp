<!--
The PR title becomes the subject of the squashed merge commit:
  <type>(<scope>): <subject> — imperative, lowercase, ≤ 72 chars, no trailing period.

One PR does one thing; merge requirements live in the branch ruleset
(2 approvals, threads resolved, up to date with main).
-->

## What

<!-- A few sentences: what changes? Lead with the behavior, not the file list. -->

## Why

<!-- The problem or motivation. Link the issue (`Closes #123`), or state why
     there is no issue: bug fixes and behavior changes need one; typos and
     doc corrections may skip it. -->

## How

<!-- What a reviewer should know: key decisions, alternatives considered and
     rejected, boundaries touched (tool surface, protocol handling). Delete
     this section if the diff is self-explanatory. -->

## Verification

<!-- How you proved it works and did not break anything else. CI runs the
     same gates (Node 18/20/22 matrix); local runs catch failures before the
     push. -->
- [ ] Tests added or updated — a bug fix ships a regression test that fails
      before the fix and passes after it
- [ ] `npm ci`
- [ ] `npm run build`
- [ ] `npm run typecheck`
- [ ] `npm run test:coverage`
- [ ] Anything the tests cannot reach was verified manually (describe below)

<!-- Manual steps, before/after output. Delete if empty. -->

## Compatibility impact

<!-- Breaking changes to the tool surface, config, or output formats?
     "None" is a valid answer — state it explicitly. If breaking: what
     breaks, who is affected, and the migration path. -->

## Security and supply chain

<!-- Does the change touch authentication or trust boundaries, web search
     inputs, package.json/package-lock.json, or GitHub workflows? security.yml
     audits the lockfile on every PR regardless of paths — use this section to
     give the reviewer context the audit cannot infer. Otherwise write "N/A". -->

## Reviewer notes

<!-- Non-obvious trade-offs, known follow-ups, areas that deserve extra
     scrutiny. Delete if empty. -->
