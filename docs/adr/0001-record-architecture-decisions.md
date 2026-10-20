# ADR-0001: Record architecture decisions as ADRs

**Date**: 2026-10-19
**Status**: proposed
**Deciders**: Simon Klimaszyk (owner and sole decider, D-01)
**Related**: all ADRs ([index](README.md)); ADR 0005 (version changes), 0009 (versioned config); D-01, D-37

## Context

- The plan lists 16 decisions but no format, location or approver. Catalogue: 0001 to 0033.
- Why an option was rejected (e.g. the 30-day sold-price ledger, BullMQ, Next.js, magic links) matters as much as the choice and gets asked again.
- Claude Code agents write code and draft records; Simon directs, reviews and decides (D-01). Agent sessions start without history; records keep them consistent.
- Repository: Simon's personal GitHub, Free plan, no branch protection. By convention: CI green and a fresh-context Claude Code review before merge, Simon's go before production deploys (D-37).
- A proposed record waits only on Simon's review.
- Reference formats: [MADR 4.0.0](https://adr.github.io/madr/), [Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

## Decision

We keep architecture decisions as numbered Markdown files `docs/adr/NNNN-slug.md`, one decision per record, using the project template [template.md](template.md) (derived from MADR 4.0 and Nygard, not MADR-conforming). [README.md](README.md) is the index and the only place that says which record is needed before which phase or slice.

### Rules

| Topic | Rule |
|---|---|
| Header | Bold lines Date, Status, Deciders, Related |
| Sections | Context, Decision, Alternatives considered, Consequences (positive, negative, risks), How we check it, Revisit when; optional Changes |
| Status values | proposed, accepted, rejected, deprecated, superseded by ADR-NNNN |
| Numbers | Four digits, assigned in pull request (PR) order, never reused |
| Acceptance | Simon merges the PR that sets Status to accepted, after green CI and a fresh-context Claude Code review (not by the writing session). Simon reads the `docs/adr/` diff himself. An agent-drafted record is Simon's decision once merged |
| Proposed records | Edited freely until accepted |
| Accepted records | Decision and How we check it never change. A changed decision gets a new record; the old one becomes "superseded by ADR-NNNN" |
| Errata | Spelling, formatting, links, a link to a later record: allowed outside those two sections, with a dated line under Changes naming the PR. Anything that changes meaning needs a new record |
| Dependency major version | New record superseding ADR 0005's version line |
| Config values | Thresholds, rubric points, budgets change through config PRs (ADR 0009); a new record only when the rule using them changes |
| How we check it | Every record names the test, lint rule, CI job or review step that keeps it true. A rule no check can cover is a policy, not an ADR |

ADR-0001 itself is accepted by Simon's merge of the PR that adds it.

### Index

One row per record: number, title, status, owner (Simon for all), and the phase or slice that needs it (0 to 5, or "none"). A record must be at least proposed before the work it governs starts and accepted before that phase's exit review. Phase plans cite the index ([Phase 0](../planning/phases/phase-0.md) section 3).

## Alternatives considered

- **Short Nygard records without alternatives**: loses the rejected options and reasons, which get questioned later. Minor records may keep them to two lines.
- **Unmodified MADR 4.0 in `docs/decisions` with log4brains**: Confirmation is optional and there are no revisit or risk sections. Moving header lines to front matter later is mechanical.
- **Wiki or Notion**: not reviewed with the code, no commit history, silent edits possible.

## Consequences

**Positive**
- One place lists every decision and the phase it blocks.
- A new agent session or colleague learns the design's reasons in about an hour.
- Changes in sensitive areas (retention, Claude data flow, call budget) leave a reviewed trail.

**Negative**
- Writing and reviewing records costs time: Phase 0 task S9, estimated 1.5 to 2.5 days of Simon's reading and reviews (unmeasured, recalibrated after Phase 0; [roadmap](../planning/03-roadmap.md)).
- Supersede-only changes mean more files to read to find the current rule.
- No second reviewer: CI and the fresh-context review catch format errors, contradictions and gaps, not a wrong judgement by the sole decider.

**Risks**
- Records drift from the code. Mitigation: automated checks where possible; the PR template asks "Does this change contradict an accepted ADR? If so, link the new record."
- Agent-drafted records are merged without real review, or an agent weakens the ADR check in the same PR. Nothing technical stops this; the only controls are the fresh-context review and Simon reading every `docs/adr/` and `scripts/` diff.

## How we check it

- A small script runs in CI on every PR and fails when:
  - a file name does not match `NNNN-slug.md` or a number is duplicated;
  - a record lacks a header line or section from `template.md`, or has a status outside the list;
  - a record is missing from the index, or its index status differs from its Status line;
  - an accepted record (on `main`) has a changed Decision or How we check it, or another section changed without a new Changes line.
- The fresh-context review and Simon confirm a Changes edit is a real erratum.
- Simon reviews the proposed list at each phase exit review.

## Revisit when

- Another Intra AI person starts writing or deciding records: decide on a second approver and branch protection (revisits D-37).
- Records are skipped in practice (decisions only in PR threads): consider the shorter Nygard format.
- Simon wants a rendered decision log: move header lines to MADR front matter and evaluate log4brains.
- Docs move to a docs site or another repo.
