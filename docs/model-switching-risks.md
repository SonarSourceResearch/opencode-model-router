# Model Switching Risks

The router evaluates each human prompt with the judge model, then changes the
current user message's model metadata before OpenCode starts the target model.
The plugin does not copy, transform, or delete the session history itself;
OpenCode remains responsible for assembling the context sent to the selected
provider.

## What Is Preserved

- Completed user messages, assistant messages, and recorded tool results remain
  in the OpenCode session.
- A switch happens before generation for the current turn. The router does not
  replace a response that has already completed.
- Tool-loop continuations within a routed turn remain on the selected model and
  are not judged again.

These properties preserve the visible conversation, but they do not guarantee
that two providers will interpret or process that conversation identically.

## Context Continuity

The selected model receives the context that OpenCode constructs for the
session. Models can have different context limits, tokenizers, system-prompt
handling, tool capabilities, and message-format support. Switching can
therefore cause:

- earlier content to be compacted or omitted when the new model has a smaller
  effective context window;
- different interpretation of the same history or tool results;
- loss of continuity when a model depended on provider-specific metadata that
  is not represented in persisted messages.

Hidden reasoning is not portable conversation state. Reasoning tokens or
provider-internal chain-of-thought from one model should not be assumed to be
available to the next model. Only content persisted by OpenCode can contribute
to a later model's context.

## Output Loss And Recovery

The router does not intentionally discard completed output. However, it does
not provide cross-provider recovery for an interrupted generation. If the
selected provider fails after producing partial streamed output, retry and
partial-output behavior is controlled by OpenCode and that provider. The router
does not transfer an in-progress generation to another model or reconstruct
missing output.

Judge failures are handled differently: if judging fails before target
generation starts, the router selects the configured fallback tier. This does
not recover failures that occur later in the target model request.

## Cache Reuse

Provider prompt caches and prefix caches are generally scoped to a provider,
model, account, and exact serialized prompt. Switching provider, model, variant,
or message representation can cause a cache miss even when the visible session
history is unchanged. Consequences can include:

- higher input-token charges;
- increased time to first token;
- repeated processing of a long conversation prefix.

The router does not copy cache entries or cache identifiers between providers.
Routing successive turns to different tiers should therefore be treated as
potentially losing provider-side cache reuse, not as losing the OpenCode session
history.

## Data Exposure

Each routed target receives the context OpenCode sends for that turn. A session
that switches tiers may therefore send conversation content to more than one
provider. The judge also receives up to 4,000 characters of the current human
prompt. Provider access, retention, residency, and compliance requirements must
be evaluated for every configured judge and target.

## Latency And Cost

Every routed human prompt adds a judge request before target generation. Total
latency and usage include both requests. Target output limits and reasoning
effort are controlled by the target provider configuration; the router neither
normalizes reasoning-token budgets across models nor aggregates token usage.

## Mitigations

- Configure tiers with compatible context limits and tool support.
- Keep sensitive sessions on providers approved for the same data classification.
- Avoid frequent cross-provider switching for long sessions that depend on
  provider-side prefix caching.
- Persist important conclusions in visible messages or files rather than
  relying on hidden model reasoning.
- Treat partial target failures as non-recoverable unless OpenCode or the target
  provider explicitly supports safe retries.
- Use diagnostics to verify the selected tier and investigate fallback events.
