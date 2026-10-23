# Messages

Durable messages between conversations, standing agents and the user. Built in and on by default.

## Messaging

`message { to, text, reply?: true, steer?, images? }` returns the message id immediately. `images` forwards
images from the sender's own conversation, since a model cannot produce image bytes: `'latest'` takes the newest
entry with images (a pasted input or a tool result such as a screenshot, searching the whole history), a number names
that entry. The reference resolves when the message is admitted (at most
`maxImages`, each at most `maxImageBytes`; unknown entries or entries without images are refused); the log records
`images: { entry, count }`, and delivery attaches that entry's images to the recipient's input, so a replay attaches
the same ones. `branch` takes the same `images` for its first message. Messages to the user carry none.
Address a conversation
as `#123` or `123`, a standing agent as `@name`, or the project's existing lander as `@lander`.
Only the `ultimate` resident's standing conversation may message `user`; other senders must send @ultimate a one-way update to relay.
Self-messages, unknown conversations and tallies are refused; use `note` for a tally. Unknown standing names list
the valid ones. Standing agents are resolved and configured through the `subagents` service at delivery admission.
Each post emits `board.sent` `{ message, from, to, reply, steer }` (`MessageSent`) in the posting commit, never the
text; replies are no posts and emit nothing.

An idle recipient wakes. A busy one receives a follow-up after its current run, or steering during that run with
`steer: true`. `steer` defaults to `true` for @ultimate's messages, to any recipient including `@lander` and other
standing agents, and to `false` for everyone else; an explicit value always wins. The typed `board.message` input identifies its sender and explains where its answer goes. Its `delivery`
field records `steer` or `followUp`.
The answer returns as `board.reply`, steering the sender. An unanswered input produces a failure reply instead.
Answer directly rather than messaging the sender: the tool refuses reply-enabled messages back to a sender whose reply-enabled message is still unanswered, while `reply: false` updates and other recipients remain allowed.
A subagent (a conversation its parent lists in `ultimate.subagents`) may message only that parent, so its work reaches
the user through its coordinator and @ultimate; its prompt says so. Automation runs and top-level conversations may
message any agent; only @ultimate may message the user.
`reply: false` is one-way: it wakes the recipient without returning an answer, and its model text says the
answer is not sent. The log records its answering assistant entry in `answer` while keeping state `delivered`;
no reply is appended. A subagent's one-way update to its parent is instead a `board.message` write with
`delivery: 'note'` and no `input` flag. It starts no run; the parent reads it with its next model request.
The note's delivery decision is saved in the task input for replay.

### Triage for the primary agent

A one-way message or a reply from a conversation to the primary agent (@ultimate)
is triaged, so pure status updates cost no turn. The log records `triage: { verdict, reason? }` on the message:

- **act at once, no model:** a reply-enabled message; text whose last line is a question or numbered options; text
  longer than `TRIAGE_MAX` (24,000 characters), which is never cut for the model; a failed reply; a reply to the
  agent's own message that ended with a question or options (read from the task input, so the log's bound never
  drops it).
- **otherwise:** the message is written into the conversation as context (a `board.message` or `board.reply` write
  with the model text, no run) with verdict `assessing`. The delivery task asks `summaryModel` with
  `TRIAGE_SYSTEM` (`triage.ts`), memoizing the model, the response and the verdict (a failed assessment too), so a
  resumed task asks once, decides the same, and accounts the usage once. `act` (a decision,
  question, landing or result to relay, failure, blocker or request) submits one short `board.wake` input that
  points at the message; `fyi` (progress, queued, still waiting) starts nothing, and the agent reads it with its
  next input. A failed or timed-out (30 s) assessment acts, so the agent wakes as without triage; without a
  summary model nothing is gated. The verdict commits before the wake and emits `board.triaged`
  `{ message, from, to, verdict, reason }` (`Triaged`). Notes and messages from the user are never triaged.

The incoming row shows it after its kind: a spinner and `assessing…`, then `action` in the accent or a muted
`FYI · no action`, with the reason on hover and in the open card. `board.wake` renders nothing.

Sending to `user` writes a message
shown in @ultimate's transcript; it starts no run. The message is @ultimate's answer: a direct `message` call to
`user` returns `terminate`, so the run ends without a final answer that would restate it, when every call of that
tool round does so. It does not while a reply-enabled message to @ultimate is still open, so that reply is still
answered; codemode's nested calls never end the run.
A reply-enabled message to `user` stays open, and its sender shows as awaiting reply, until the user answers that
message: a user Reply with `re` (an answer card, or a typed Reply) marks only that message answered, in the reply's
commit. Plain input, new posts and answers to other questions leave it open. The service's `dismiss` closes it as
`dismissed` instead, with a one-way user note to the sender (`re`, delivered as a note: no run starts) in the same
commit.

While the sender has questions open, the input that starts its next run goes in after a `board.open` entry, placed
by the patched `beforeInput` hook in the input's commit: one user-role line listing each open message's id, first
line and age. It renders nothing in the transcript. It is per input rather than a system-prompt section, so the
prompt stays cached; nothing is added while nothing is open.

Reply-expected agent messages to `user` also request question extraction in the append transaction through the
optional questions service. The sender's outgoing `message` card in its transcript shows extracted decisions
under the message body while it is open: Yes/No or choice buttons with a recommended marker, plus Something
else. The user-only questions `answer` action posts
a normal user reply with `re` and Q/A text, waking the sender. Its admission atomically checks that the
original message is still open, preventing duplicate replies.
One-way messages and user replies never request extraction; see [Questions](../questions/README.md).

In the sender's transcript a `message` call renders as an outgoing card: recipient, one-way or expects reply, and
the message's live state from the messages log (sending, delivered, awaiting reply, awaiting your reply, answered,
failed), with an Open link to the recipient's entry. A `branch` call renders as a branch-start card: the branch's
feature and title, its root, isolated or shared, working or reported back, an Open link to its first input, and
the prompt. Failed calls of either tool keep the generic tool card with their error.

The message tool is replay-safe: it memoizes the sent id. A task-scoped `board.sent` receipt commits with the
message and delivery task, preventing a duplicate even if interrupted before the memo is saved.
Delivery is a background durable task owned by the root conversation. Stable request ids (`board:<id>` and
`board-reply:<reply-id>`) deduplicate submissions across reopen. Recording the answer, appending its reply and
advancing the task checkpoint happen in one transaction. A reopened task resumes that checkpoint, so both a
placed input awaiting an answer and a recorded answer awaiting delivery survive without duplicate replies.
One-way input deliveries also wait for the answer; recording it and completing the task commit together.
Note deliveries complete after placement, without waiting for an answer.

## Ultimate and branches

Talk to `@ultimate` in its own conversation to start and steer work, using the top-bar @ultimate button or first sidebar row. It is the built-in standing orchestrator, not a coding worker.
Model-facing messages identify standing senders as `#12 (@ultimate)` and the lander as `#40 (@lander)`; ordinary
conversations stay `#id`, and user replies say `user`. Before delivery, standing recipients are refreshed from their
current definitions, including numeric-address messages and automatic replies.

The deferred `branch { prompt, root?, isolated?: true }` tool is offered only to definitions that name it.
It chooses the explicit root, otherwise the caller's tree root, otherwise the only root. Ambiguous or missing roots
produce an error listing the available ids. It forks the root's tally tip through lineage, attributes the tally's branch
line to the caller, and sends the first input as a message with replies enabled. It returns the branch id and message id.
The branch's answer therefore wakes its caller as a normal `board.reply`.
The tool records the caller in the branch's `board.started` document, so later answers reach it too. A later run, woken
by a subagent, a notify, a lander report or steering, ends with a final answer nobody receives. After each such run, a
background `board.route` task (one per generation, from an `onYield` hook) sends that answer to the starter as a one-way
message from the branch, with the usual outgoing and incoming cards. It skips the answer when the run answered the
starter's reply-enabled message (board.delivery replies to it), when the run itself called `message` to the starter, when only the starter's own replies woke it (the starter already knows what it answered), and when the answer is empty, failed or aborted. An answer whose last line is a question or a
numbered option asks for a decision and wakes the starter as a follow-up; any other answer is a note, which wakes nothing.
An answer to the starter's one-way message is routed like any other: it gets no reply, and may carry a decision.
This cannot loop: routing goes only from a branch to its starter, which existed before it, and a routed message is
one-way, so the starter's answer to it goes nowhere.
The reply assessment is not used: it arrives later, from the summary model, and only when one is configured. Request id
`route:<answer entry>` deduplicates delivery in the branch's `board.requests`, so a restart never sends an answer twice.
Before sending its first input, the tool rereads the `coordinator` definition (built-in, user, then trusted project override), applies only its instructions, and marks `ultimate.metadata.label = 'coordinator'`. The branch keeps its inherited model and tools. Coordinators report decisions to @ultimate and send it one-way landing or failure updates with the sha and divergence.
The tool gives lineage its task and call ids for a task-scoped receipt, recorded atomically with the fork, so replay cannot
create another branch even before the branch-id memo is saved. Pi retires that receipt when the originating task completes.
It deduplicates message admission with the same task-scoped `board.sent-calls` receipt as `message`, indexed by call id
so nested codemode calls stay distinct.

Ultimate answers the user's typed input directly in its conversation. To relay a branch result, decision or landing
to the user, Ultimate sends one consolidated `message {to: 'user', text}` when the needed replies have arrived.
It appears there as a bubble with an answer card for questions. Decisions use a reply-expected message, ending with
a `Decisions:` block (see [Questions](../questions/README.md)); reports that need no answer use `reply: false`.

## Other projects' Ultimates

One @ultimate can message another project's @ultimate, on this machine or over the tailnet, so it can drive that
instance end to end. Nothing else crosses: the sender cannot address any other conversation there, and the message is
never the user's.

- **Sender:** codemode `ultimate.tell({ project, text, reply? })` (@ultimate only) logs a message `to: 'remote'` with
  `remote: { project, machine, key }`, a fresh random key, then posts the target's `messages.remote` action, located as
  codemode's `{ project }` reads are (`lib/remote.ts`: loopback, else the tailnet address from the cloud register; the
  target's own `Origin`, admitted by `tailscale.allow` on the tailnet). A failed post marks the message failed and the
  call throws a sentence naming the project and machine. Telling an Ultimate whose reply-expected message to you is
  still open is refused: answer it instead.
- **Target:** `messages.remote { key, text, reply, from: { project, machine } }` logs a message `from: 'remote'` to its
  own primary agent, the only recipient it can reach, and delivers it like any other: as a steer, triaged, with
  receipts. The model reads `Message from @ultimate@<project> on <machine> (another project's Ultimate, not the
user)`. The `board.remote` document maps each key to its message in the same commit, so a repeated post (a retry,
  a replay) returns the first id and delivers nothing new.
- **One hop back:** with `reply`, the delivery's answer phase posts it to the sender's `messages.remoteReply { key, text,
failed }` instead of a local conversation. The sender records it as a reply `from: 'remote'` with `re` and
  `reply: false`, delivered by the usual reply phase, so its answer goes nowhere. The sender keeps each reply-enabled
  tell in `board.remote` until its answer arrives (the log drops old messages), so a late answer still lands;
  `remoteReply` refuses any other key, including a one-way tell's, and a second answer returns the first one's id.
  Two Ultimates therefore exchange at most a message and its answer per `tell`; continuing is a new `tell`.
- **Not durable on the sender:** `tell` runs inside codemode, which is not replayed. A crash between logging and
  posting leaves the message `sent`, never posted; telling again uses a new key.

`remote` and `remoteReply` are user-only actions: only another instance's HTTP call reaches them, never an agent's
`ultimate.action`. In compact mode a remote sender is named `@ultimate@<project> on <machine>` with a globe mark and a
violet accent no conversation uses.

## Document and typed inputs

`Messages` (kind `board`, version 1) is exported on `ROOT_CONVERSATION_ID`:

```ts
{ messages: Message[]; next: number }
```

`next` starts at 1. The log keeps the newest 300 items; transcripts retain delivered inputs.
Version 1 remains loadable: Pi documents do not validate object fields, so existing logs' unused `readUpTo` field needs no migration.

```ts
type Message = {
  id: number
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  text: string
  at: number // Unix milliseconds
  reply: boolean
  re?: number
  state: 'sent' | 'delivered' | 'answered' | 'dismissed' | 'failed'
  entry?: EntryId
  answer?: EntryId
  error?: string
  remote?: { project: string; machine: string; key: string; id?: number } // the other Ultimate
}
```

`board.message` data: `{ id, from, text, reply, delivery: 'steer' | 'followUp' | 'note', images?, remote? }`, where `images` counts the forwarded images in its model content; the card shows them as thumbnails.
`board.reply` data: `{ id, re, from, text, failed }`. A reply has its own id and `re` points to the original message.
The reply's `answer` links to the recipient's assistant entry; the original also stores its input `entry`.

## Actions

- `addresses({}) → { agents, lander?, conversations }`: resident names/descriptions with an id if already created,
  the existing project lander id, and up to 50 recent top-level conversation summaries (including title and label).

Users type in @ultimate's conversation or answer a question card; there is no user posting action.
Agents use the `message` tool. The prompt section is stable and lists resident names and descriptions.

## Service

`host.want(MessagesApi)` exposes `send`, a one-way message from a conversation (the lander's deploy
handoff), and `answer`, the user's reply to an open message (the questions answer card). Landings and submissions
append no log items. `MessagesApi`, `Message` and the `Messages` document live in `api.ts`.

## UI

There is no Messages surface: the extension is plumbing, and everything it carries renders in transcripts. You talk to
@ultimate in its own conversation (the title bar's `@ultimate` button and the sidebar's top row, both in
[conversations](../conversations/README.md), open it). Every sender has a stable accent (`accent.tsx`: you the
brand colour, others a small palette by id) shown as a stripe, a faint fill and the sender name. Typed
messages and replies render as compact transcript cards with Source / Return navigation, in the sender's accent.
Incoming messages show whether they expect a reply or are one-way, plus their delivery mode (steered, follow-up or note) when recorded. Final answers name their reply
destination, or say “not sent” for a one-way message. Answers that cover several messages list each
destination; unrelated answers show no messaging label.

@ultimate's own conversation uses compact mode (the `compact` contribution): each run of tool calls and thinking folds into
one “worked · N steps” row, while messages, branch starts, workspace outcomes, onboarding setup cards and answers stay. Its messages to you
are bubbles on the left in its accent, their footer saying awaiting your reply, answered or one-way; an answer card
mounts beneath the text (`Bubble` children). Each log message records the tool call that sent it (`call`: the
`message` call's id, or `<script>/<n>` for a nested codemode call), so a message @ultimate sent from a `codemode`
script is a bubble too, bound to that exact message, beneath a quiet “sent with codemode” line that opens the script.
The script shows as soon as the log holds a message it sent, while it runs or after it was interrupted; messages from
before the log recorded calls, or that the bounded log dropped, leave it folded. Once the bounded log has dropped a
direct message, its bubble shows no state. An answer that went back to the branches that asked folds to “replied to
#id”.
