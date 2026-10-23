## Borrowed from Pi

- `server/http.ts` — adapted HTTP dispatcher, not exported; prevents early provider stream termination. undici in package.json exists only for this file. Drop when Pi exports configureHttpDispatcher and applyHttpProxySettings; keep the MIT notice until then.
- `pnpm-workspace.yaml` — registers patches/@earendil-works__chord@1.4.0.patch, patching sanitizeOutput to remove whole CSI/OSC/control strings while keeping numeric SGR, patches/@earendil-works__pi-durable@1.4.0.patch, adding transactional input-placement hooks, marking entries placed from input submissions (input: true) so extensions can distinguish requests from user-role writes, recording the requested thinkingLevel on each response as pi-agent-core does, and adding Harness.hold()/release(), which keep the scheduler from starting task runs whatever resume() says (a held invocation parks as pending at its next phase boundary; abort handlers still run), and patches/@earendil-works__pi-claude-code@0.1.0.patch, rebuilding replay cache markers to stay within Claude's four-block limit and wording an incomplete response without stderr ("stream ended without …") so pi-ai's isRetryableAssistantError retries it, accepting the bare-string first user message Claude Code sends when replaying a history that starts with "/", and naming the relay's underlying error (class and message) in its failure. Drop each patch when upstream ships the corresponding fix; pnpm errors when a versioned patch no longer matches.
- `test/claude-code-cache.test.ts` — internal imports exercise the pi-claude-code replay cache patch registered in pnpm-workspace.yaml. Drop this coupling and the patch when upstream rebuilds cache breakpoints within Claude's four-block limit.
- `test/claude-code-incomplete.test.ts` — imports pi-claude-code's patched incompleteResponseError and normalizeError and pi-ai's isRetryableAssistantError. Drop with the patch when upstream makes an incomplete response without a reason retryable.
- `test/claude-code-slash-replay.test.ts` — imports pi-claude-code's patched rewriteInitialRequest and TurnRelay. Drop with the patch when upstream accepts a string first user message on replay and reports the relay error's message.
- `extensions/lineage/server.ts` — inlines Pi's unexported createCompaction so tally checks and manual compaction creation share one transaction. Drop when Pi exposes atomic compaction admission.
- `extensions/lineage/rewind.ts` — copies pi-durable's unexported normalizeToolPath (unicode spaces, a leading @) so going back resolves edit and write paths exactly as those tools do, then resolves them with the exported NodeExecutionEnv.absolutePath (home directory and file URLs). Drop when Pi exports resolveToolPath's normalization.
- `extensions/lineage/catchup.ts` — uses the patched transactional beforeInput hook to place catch-up notes before inputs. Drop the patch when Pi ships input-placement hooks.
- `extensions/messages/server.ts` — uses the same hook to place the line listing an agent's open questions to the user before the input that starts its run.
- `extensions/prompt/server.ts` — uses the same hook to place a "Build changed" note before the input that starts a run, keeping the build out of the cached system prompt.
- `extensions/conversations/server.ts` — uses the same hook to resume a concluded conversation in the commit that places its input.
- `extensions/plan/server.ts` — uses the same hook to empty a new branch's inherited plan in the commit that places its first input.
- `extensions/setup/server.ts` — uses the same hook to place changed setup warnings before the primary agent's input, recording the note and its deduplication state in one commit.
- `extensions/todos/server.ts` — uses the same hook to place a changed to-do list before @ultimate's input, recording the note and its deduplication state in one commit. Drop the coupling when Pi ships input-placement hooks.
- `extensions/pause/server.ts` — uses the patched Harness.hold()/release() for the user's soft pause. Drop the patch when Pi Durable ships a scheduler hold.
- `extensions/coding-tools/diff.tsx` — internal untyped details.patch/details.diff formats drive the diff renderer. Drop when Pi exports structured diff rows for rendering.
- `extensions/prompt/server.ts` — tool guidance adapted from unexported prompt contributions, not Ultimate's personality. Drop when Pi exports buildSystemPromptSections and the per-tool system prompt contributions.
- `web/src/app/model.ts` — internal trailing <harness> text block duplicates diagnostics and is stripped for display. Drop when Pi exports a diagnostic-free tool-result content accessor.
- `web/src/sdk/format.ts` — copied formatTokens helper, not exported. Drop when Pi exports formatTokens.
- `web/src/sdk/events.ts` — adapted Pi event bus using browser-safe sets instead of node:events, with Pi's exported EventBus type and handler-error semantics. Drop when Pi ships a browser-safe bus.
- `extensions/coding-tools/web.tsx` — internal bash exit_code diagnostic message drives exitOf and untyped details.patch/details.diff drive Edit. Drop when Pi exports structured bash outcomes and structured diff rows for rendering.
- `extensions/context/breakdown.ts` — internal remove-all pi.system entry immediately precedes a reordered re-add, folded into the re-add's diff here. Drop when Pi exposes prompt reorder metadata instead of requiring entry-sequence inference.
- `extensions/fast/server.ts` — sets service_tier through onPayload because pi-ai's simple stream options drop serviceTier. Drop when buildBaseOptions forwards serviceTier and Pi Durable stream settings accept it.
- `server/tool-arguments.ts` — ends degenerate tool-call argument streams with an error worded to match pi-ai's retryable error pattern, so the generation retries it. Drop the wording when Pi Durable lets a stream mark its error retryable.
- `extensions/subagents/server.ts` — internal ToolTaskInput.assistant locates the calling assistant for history forks. Drop when ToolExecutionApi exposes the calling assistant entry ID.

On a Pi upgrade, run `rg "Pi upstream:"` and recheck each marked item against the new version; test/e2e/pi-upstream.test.ts checks that every tracked marker matches the installed package version and its path appears in this list, and every backticked path in this list is tracked and contains a marker.
Delete copies and patches that Pi now exports or fixes, then update the remaining markers and this list after verification.

## Reference

- Pi Durable README and examples: `node_modules/@earendil-works/pi-durable/README.md`, upstream
  https://github.com/earendil-works/pi/tree/main/packages/durable
- The durable coding agent this host follows: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/experimental/durable
