# Own Work

**Tasks, roadmaps, and specs that survive the session.**

Own Work is a local-first CLI for tracking what you build. It exists because the chat scrollback has quietly become a system of record: the task list lives in a conversation, the acceptance criteria live in a prompt, and both evaporate at the next session. Own Work keeps them where they belong — plain files with stable identity, owned by your repo.

```bash
ownwork task create --title "Port the scheduler"      # one durable outcome, one Task
ownwork roadmap create "Pulse-level control"          # an intended outcome, not a work plan
ownwork spec promote --from-task task-0004-...        # keep the contract after the work is gone
ownwork system register ./packages/engine --primary   # what you are actually building
```

> Status: pre-release, not on npm yet. The commands above are the committed surface for the first release, not a mockup.

What makes these four objects worth a CLI instead of a TODO file: every record has a stable id that survives sessions, agents, and context compaction; lifecycle never propagates by accident (finishing a task accepts nothing, linking transfers no authority); and the storage is human-readable files a git repo can own.

## Part of a pair

Own Work is the build half of a two-tool suite: its sibling package `absorb-anything` turns the code you study into durable, reusable evidence, on the same on-disk workspace format. Works alone for projects that only need execution tracking; works beside `absorb` when decisions should trace back to evidence.

**Absorb Anything. Build Your Own.**

## License

MIT.
