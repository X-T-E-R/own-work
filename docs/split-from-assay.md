# Split contract: extracting Build Your Own from Assay v0.14.0

This repo is the build half of the three-product split of [Assay](https://github.com/X-T-E-R/assay). It owns Task, Roadmap, Spec, and the System registry, copy-ported from the Assay repo at tag `v0.14.0` (local checkout: `../assay`), plus this product's `prime`/semantics texts. CLI bin is `byo`, keeping the `byo task/roadmap/spec/system` command groups.

It depends on the `absorb-anything-core` package (workspace envelope, locks, event ledger, atomic writes, migration runner, Project identity) from [`absorb-anything`](../../absorb-anything) — use a file:/git dependency until that package is published.

The full boundary contract, the non-negotiable on-disk compatibility rules, and the ownership rules for README copy are in [`../absorb-anything/docs/split-from-assay.md`](../../absorb-anything/docs/split-from-assay.md) and the task PRD at `../../.trellis/tasks/08-28-absorb-anything-split/prd.md`. Everything there applies to this repo, including: `.assay/` envelope 0.14 unchanged, three-tool mixed-workspace compatibility tests, no push/publish without user authorization, README positioning copy owned by the planning session.
