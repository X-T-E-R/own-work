# Build Your Own

**The build half of the Absorb Anything suite: tasks, roadmaps, specs, and systems on a plain-files workspace.**

`byo` manages what you build after studying the prior art — the bounded tasks, intended outcomes, normative specs, and system registrations of your own project. It operates on the same on-disk workspace format as [Absorb Anything](../absorb-anything), so evidence and execution live side by side without either tool requiring the other.

```bash
byo task create --title "Port the scheduler"     # one durable outcome, one Task
byo roadmap create "Pulse-level control"          # an intended outcome, not a work plan
byo spec promote --from-task task-0004-...        # keep the contract after the work is gone
byo system register ./packages/engine --primary   # what you are actually building
```

> Status: being extracted from [Assay v0.14.0](https://github.com/X-T-E-R/assay); not on npm yet. These objects exist in Assay today under the same names.

What makes these four objects worth a CLI instead of a TODO file: every record has a stable id that survives sessions, agents, and context compaction; lifecycle never propagates by accident (finishing a task accepts nothing, linking transfers no authority); and the storage is human-readable files a git repo can own.

Works alone for projects that only need execution tracking. Works beside `absorb` when decisions should trace back to evidence. [Assay](https://github.com/X-T-E-R/assay) remains the integrated workbench and will become the layer that ties the two halves together — adoption records that map studied sources into built systems.

**Absorb Anything. Build Your Own.**

## License

MIT.
