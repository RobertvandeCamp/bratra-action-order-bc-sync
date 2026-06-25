# Review instructions

Review against the Codaeva coding principles. This codebase is AI-first:
optimize for an agent that must understand, modify, and **verify** a single unit
in isolation, with a fault staying **local**. Maximize signal per token.

Write findings in English. No emoji. Do not merge the PR and do not push changes;
review only.

## Principles (the frame)

1. Single Responsibility — one reason to change; small enough to fit in context.
2. Locality of Behaviour over premature DRY — Rule of Three before abstracting.
3. Explicit over implicit or clever — no magic, no multi-hop reasoning.
4. Types and schemas as contract — validate every I/O boundary; derive types.
5. Tests are the guardrail — every change ships a runnable check; never weaken a test.
6. Deterministic core, side effects at the edges — pure core, idempotent handlers.
7. Fail-fast with high-signal errors — no silent fallbacks; structured logging.
8. One consistent pattern per service type — converge on the canonical example.
9. Backward-compatible and reversible by default — additive, with rollback.
10. Navigable structure, descriptive names, intent where needed.

## What "Important" means here (fix before merge)

- **Correctness:** incorrect logic, unhandled edge cases, broken error
  propagation, off-by-one, race conditions in async/concurrent code.
- **Contracts:** an external I/O boundary (DB, S3, SFTP, network, queue) without
  schema validation (Zod/Pydantic), or types that aren't derived from the schema.
  `any` or unsafe casts that silence the type checker at a boundary.
- **Determinism:** side effects leaking into otherwise-pure core logic;
  non-idempotent handlers where retries occur (SQS/Lambda).
- **Failure modes:** silent fallbacks that hide faults; errors without context;
  bare stack traces returned to a caller instead of actionable, structured errors.
- **Security:** unsanitized user input reaching a sink; SSRF (server-side
  requests built from user input); `eval` or dynamic code execution; open
  redirects; commands built from user input; secrets hardcoded instead of in a
  secret store.
- **Data scope:** database queries not scoped to the caller's tenant/company;
  PII (emails, user IDs, request bodies) in logs or error messages.
- **Reversibility:** a non-backward-compatible change without a migration or
  rollback path (rename instead of additive column; hard delete instead of
  disable-with-audit); a database migration with locking operations or downtime
  risk.
- **Consistency:** a second way to do something that already has a canonical
  pattern in the repo.

## Nit at most — cap at 5, then say "plus N similar items"

- Naming, file structure, docstrings.
- Duplication that is not genuine shared business logic. Apply the Rule of Three
  before flagging duplication; prefer duplication over the wrong abstraction.
- Files drifting well past ~200-400 lines, or a handler mixing parsing/validation
  with business logic instead of a thin handler + a pure function.

## Do not report

- Formatting, style, lint, and type errors — these are owned by the
  linter/formatter and CI, not the review.
- Generated files (e.g. generated DB types), lockfiles, and vendored code.
- Test code that intentionally violates production rules (fixtures, fakes).

## Always check

- A behavioral change ships with a runnable test; tests are the executable spec.
  A test must never be weakened to pass — the implementation is fixed instead.
- Unit tests use fakes/mocks, never live network or database calls.
- New API routes / handlers have an integration test.
- Log lines exclude emails, user IDs, and request bodies.
- Secrets resolve from a secret store, never from hardcoded values or committed
  config.

## Verification bar

Behavior claims need a `file:line` citation in the source, not an inference from
naming. Lead the summary with a tally (e.g. "2 important, 3 nits") and lead with
"no blocking issues" when that is true. After the first review, suppress new nits
and post Important findings only.
