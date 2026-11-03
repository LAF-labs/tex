# Bugbot review rules (pstack)

Review this pull request the way pstack (github.com/cursor/plugins/tree/main/pstack) reviews code: less code, higher quality, every claim backed by a concrete failure. The goal is not to maximize the number of findings. A short list of real defects beats a long list of opinions.

## How to report

- Every finding states a concrete failure scenario: the input or state, what the code does, and what goes wrong. If you cannot write that scenario, do not report the finding.
- When a finding comes from one of the principles below, name the principle in the finding title or first line (for example "Fix Root Causes: ..."), and say which decision in the diff it changes.
- Point at the exact line that owns the fault, not the line where the symptom shows up.
- Suggest the smallest fix that removes the cause. Prefer a fix that deletes code over one that adds a guard.
- Do not restate what the diff does. Do not praise. Do not report formatting or naming taste that a linter or formatter would own.

## Severity order

Look for these first and rate them highest:

1. Correctness bugs in shipped behavior.
2. Security, privacy, auth, permission boundaries, secrets in code or logs.
3. Data loss, corruption, migrations and schema changes that cannot be rolled back.
4. Billing or anything that moves money.
5. Concurrency: races, shared mutable state, ordering assumptions across async boundaries.
6. Idempotency: operations that break when retried, re-run, or resumed after a crash.

The principle checks below come after these. Never let a structure finding crowd out a correctness finding.

## Principle checks

### Fix Root Causes

Flag a change that patches a symptom instead of the fault.

- A new guard, null check, `try/catch` that swallows, retry, clamp, default value, or early return added where a wrong state surfaced. Ask whether that state is legitimate. If the state should never exist, the guard hides a bug upstream: say where the state is produced.
- A fix applied to one instance when the same fault exists in sibling code touched by or adjacent to this diff.
- A workaround whose justification needs a paragraph-long comment. The code is wrong, not the comment.

### Subtract Before You Add / Laziness Protocol

Flag code that adds surface the problem did not need.

- New abstraction, layer, option, or parameter with one caller and no second use in this PR.
- Speculative validators, parsers, feature flags, or config for cases the spec does not require.
- The same decision repeated in several places instead of one source of truth.
- Old code left in place next to the new path when the new path replaces it (dead branches, unused exports, compatibility shims with no external user).
- A diff that is much larger than the change it delivers.

### Boundary Discipline

- Validation, parsing and error handling belong at system boundaries: HTTP handlers, IPC, CLI args, env vars, config files, DB rows, third-party API responses, user input. Flag external data that is used without being parsed at the boundary.
- Flag re-validation and defensive nil checks deep inside internal code whose inputs are already typed and validated.
- Flag business logic tangled into framework wiring (route handlers, components, ORM hooks) when it could be a pure function the shell calls.
- Flag transport, storage or wire types leaking through a module's public surface.

### Type System Discipline

- Flag states the types allow but the domain forbids: two booleans that must stay in sync, optional fields that are only valid together, stringly typed status values.
- Flag `any`, unchecked casts (`as`), non-null assertions (`!`), `@ts-ignore` / `@ts-expect-error`, `# type: ignore`, and lint suppressions that silence a check protecting correctness.
- Flag a hand-written type that duplicates a shape owned by a schema (OpenAPI, GraphQL, protobuf, DB migration, generated client).
- Flag a `switch` / `if` chain over a union with no exhaustiveness check.

### Model the Domain

- Flag a feature that grows an existing if/else chain by one more branch when a map, registry, discriminated union, or state machine would remove the chain.
- Flag lifecycle tracked by scattered booleans or phase flags instead of one explicit state.
- Do not demand an abstraction when the current code is clear, local, and unlikely to grow.

### Make Operations Idempotent

For every state-mutating operation in the diff (writes, jobs, webhooks, migrations, file operations, external calls):

- What happens if it runs twice in a row?
- What happens if the previous run crashed halfway?
- Does a re-run converge to the same end state?

Flag it when the answer depends on leftover state: non-atomic writes, locks or claims with no staleness check, inserts without a uniqueness key, webhook handlers without dedupe, counters incremented on retry.

### Separate Before Serializing Shared State

- Flag mutable state shared across concurrent actors (requests, workers, tabs, processes) when the actors could each own their own state.
- When sharing is real, flag coordination that relies on convention or timing instead of structure (lock, single writer, transaction, compare-and-swap).

### Migrate Callers Then Delete Legacy APIs

- Flag a new API introduced next to the old one when both stay in use after this PR and no external consumer needs the old one.
- Flag tests that only protect the pre-refactor implementation.

### Minimize Reader Load

- Flag pass-through wrappers and adapters with one implementation that add a layer without hiding a decision.
- Flag widened mutable scope: module or global state where a local or a return value works, state that is synced by hand where it could be derived.
- Apply the 30-second test: can a new reader answer "where does X come from?" and "what can change X?" quickly? If not, name the layer or state to cut.

### Test Behavior, Not Implementation

For tests added or changed in the diff:

- Flag a test that would still pass if the behavior broke: assertions looser than the contract, expected values computed by the code under test, assertions on data the test built itself, restated constants that never exercise the code.
- Flag a test pinned to internals: asserting calls to private helpers, internal call order, or exact error messages no caller reads.
- Flag behavior changes in the diff that ship with no test exercising them through the public interface, when the repo already has tests for that area.

### Comments (no-comments)

Comments should be rare. Flag:

- Comments that narrate what the code does.
- Commented-out code.
- Banner or section-divider comments.
- `TODO` / `FIXME` / `HACK` / "fine for now" / "temporary" without an issue link.
- Long justifications for a workaround in our own code. The fix is to rename, extract, type, or restructure so the behavior is obvious, not to keep the comment.

Keep, and do not flag:

- License headers.
- Non-obvious behavior forced by an external dependency, platform, vendor, or protocol we cannot change.
- Doc comments that define a public API contract.
- Issue or RFC links that explain a constraint code cannot express.
- `prettier-ignore` and suppressions of style-only lint rules.

## Do not report

- Exports or helpers flagged as unused when the PR description or branch name shows a stacked PR, unless you can see they are unused everywhere.
- Visual or design changes the PR description says are intentional, unless they break accessibility (focus, keyboard, contrast) or a component API contract.
- Small, intentional duplication that keeps a new path parallel to an old path the PR description says is being deleted, unless it touches security, billing, data access, or API behavior.
- A concern already guaranteed by a framework contract, shared component, or type invariant visible in the code.
- Style preferences with no failure scenario.
