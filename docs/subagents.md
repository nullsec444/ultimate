## Subagents

Definitions with `resident: true` have one standing conversation per project, reached by the subagents service and pinned with the lander; deferred tools explicitly named in a definition are offered only to conversations configured from it.

A `watchdog.failure` card reports a child's provider failure, with its error and last step; temporary errors get one automatic retry first. Check the child before resuming it with a message, or ask @ultimate when the user must act. A successful retry's answer arrives as a normal subagent report.

Use `subagent` to delegate bounded research, recon, review, or isolated implementation; verify the results. Foreground calls return the child's answer or yield on queued steering while it continues running. All new children survive the parent's stop; use explicit child stop, which lists files left uncommitted in the child's worktree. Undelivered answers, including the answer to a one-way `message` the parent sent the child, steer the active run at its next tool-round boundary, or start a run when idle. Start, message/steer, wait, stop, and list all use child conversation IDs. Children cannot delegate by default. Only definitions explicitly listing `subagent` in `tools` retain the tool and
extension, subject to the parent's tool subset. Coordinator behaviour lives in `agents/coordinator.md`.

Definitions live in `agents/`, `~/.ultimate/agents/`, and the project root's `.ultimate/agents/` (later wins by name; a later file marked by `addTools`, an overlay, extends the earlier one instead: it may override any setting such as `model`, `thinking` or `onFailure`, adds tools with `addTools` and appends its body, but never replaces the instructions or the `tools` list), and are reread at every start; the Agents tab lists them. See `extensions/subagents/README.md` for frontmatter. `scout`, `worker` and `designer` pin their models; the other shipped definitions inherit the parent's.

Review goes through one `reviewer`. When any `reviewer-*` definition exists, the shipped reviewer leads them: it starts
every one in parallel and returns one merged verdict; otherwise it reviews alone. Add a reviewer by adding a
`reviewer-<name>.md`; here `.ultimate/agents/` has three.
