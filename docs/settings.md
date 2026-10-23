## Discovery and settings

Discovery is clone built-ins, then `~/.ultimate/`, then `<project>/.ultimate/`; later names replace earlier ones.
Skills load from clone `skills/`, then the project's `.pi/skills/`, then `~/.ultimate/skills/`, then
`<project>/.ultimate/skills/`, with later names winning. Personal instructions load from `~/.ultimate/AGENTS.md`
(or `CLAUDE.md`) ahead of the project's. Pi's own `~/.pi/agent/skills/` and `~/.pi/agent/AGENTS.md` are not read: they
belong to Pi, so link a skill into `~/.ultimate/skills/` to use it here.
Every built-in is on by default, including `messages` (durable agent messages and @ultimate's messages to you), `questions` (answer cards for @ultimate's questions to the user), `faux` (inert unless `ULTIMATE_FAUX=1`), `lineage` (conversation trees: roots, branches, notes), `parallel` (web tools; reads `secrets`), `classify` (Jev typed judgments; reads `secrets`), `cloud` (cloud backups and Join; inert until configured in user settings and Secrets), `health` (provider health from real calls), `phase` (working phases; requires `classify`), and `tailscale` (remote access; inert on faux servers except previews, and only user settings can turn it off for good). Settings layer defaults, `~/.ultimate/settings.json`, then `<project>/.ultimate/settings.json`:
`extensions.enable` and `extensions.disable` are name arrays, later layers win, and changes apply live without a
restart. User/project extension folders are on by default too; `disable` turns off any extension. Unknown names
produce a notice. `summaryModel` (`"provider/id[:thinking]"`, default `openai-codex/gpt-6-luna:medium`; project over user)
picks the model for automatic titles, summaries, reply summaries, question extraction, tree abstracts and the
triage that decides whether an agent's update wakes @ultimate;
in faux mode the unset default is `faux/faux-1:off`. Set it in either file or with
the "Summary model…" command, and it applies to the next request. `fastModels` (`["openai-codex/<id>", …]`, or `openai/`; project over
user) runs those models on the priority tier through the `fast` extension, at a higher usage rate.
Compaction thresholds come from Pi's settings (`~/.pi/agent/settings.json`, then `<project>/.pi/settings.json`,
key `compaction`: `enabled`, `reserveTokens`, `keepRecentTokens`) over Pi Durable's defaults (reserve 16k, keep 20k,
background compaction 32k below the blocking threshold), which suit a ~200k window. `server/harness.ts`
(`compactionOverrides`) sets per-model values by context window: `faux/faux-1` (128k), `openai-codex/gpt-6.1-sol`
(500k) and the 1M-window Claude Code models, which keep more recent context and start compacting in the background
earlier. `compaction.modelOverrides` in those settings files, keyed by exact `"provider/modelId"` (fields
`reserveTokens`, `keepRecentTokens`, `backgroundTokens`, `enabled`), replaces them field by field. Pi's settings files
are read when the server starts.
User config is independent of `ULTIMATE_HOME`. This repository's `.ultimate/settings.json` holds only its isolate setup
and lander checks.

A project's `.ultimate/` applies only once it is chosen: its `extensions/`, the project `extensions` settings layer,
`agents/`, and `skills/` load only when the project decision is local. Decisions are kept per project path with Pi's
`ProjectTrustStore` in `~/.ultimate/trust.json`, and a linked git worktree shares its main checkout's; undecided behaves like global and is reported in system info
(`project.decision`). Every `.ultimate/settings.json` key (`defaultSurface`, `isolates`, …) goes through the gated
`host.projectSettings()`; onboarding reads the file only to show what choosing the project would bring. The `onboarding` extension asks once and its Extensions panel changes the choice live. Resources you add to a
project's `.ultimate/` stay unloaded until that project is local; tests seed the decision in their temporary home.
