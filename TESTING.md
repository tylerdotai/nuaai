# NUAAI Testing Strategy

This document is the contract for how NUAAI is tested. It defines the risk
profile, the test pyramid, coverage thresholds, mutation policy, and what
every test in this codebase is expected to look like. It is the source of
truth for the `npm run test:*` and `npm run gate` scripts.

If a test does not match this contract, fix it. If a tier is missing, add
it. If a critical path has no test, that is a defect.

## Risk profile

NUAAI is a local-first personal agent harness. The blast radius of a
failure is the operator's local machine, but several paths can still delete
data, exfiltrate secrets, or render the harness unusable. Those paths get
high test density and high mutation pressure. Boilerplate gets less.

### Critical paths (≥80% coverage per file, mutation score ≥80%)

Anything that authenticates a caller, persists data, executes a tool on
the operator's behalf, or talks to the network falls in this tier. Each
file under these globs must satisfy the coverage thresholds declared in
`vitest.config.ts` and the mutation score declared in `stryker.config.mjs`.

| Concern | Source | Why |
|---|---|---|
| Authentication | `src/gateway/token.ts`, `src/server.ts` (auth middleware) | A bypass here exposes every daemon route |
| Authorization | `src/security/permissions.ts`, `src/security/environment.ts` | A bypass here exposes every tool to every caller |
| Persistence | `src/memory/db.ts`, `src/artifacts/registry.ts` | A bug here can corrupt the SQLite store or overwrite workspace files |
| Provider adapters | `src/providers/codex.ts`, `src/providers/codex-responses.ts`, `src/providers/ollama.ts`, `src/providers/registry.ts`, `src/providers/request.ts`, `src/providers/test.ts` | The model-facing boundary must not leak credentials or accept malformed tool calls |
| Model-facing tools | `src/tools/registry.ts` | A bug here can run the wrong tool with the wrong arguments |
| Approvals | `src/core/approvals.ts`, `src/core/events.ts` | A bug here can auto-approve a destructive action or forge a payload hash |
| External integrations | `src/integrations/*.ts` (matrix, mcp, media, search, agents, audio, matrix-reactions) | Each adapter is a process boundary and a trust boundary |
| Secrets | `src/security/encryption.ts`, `src/security/secrets.ts` | A bug here can leak local credentials to disk or logs |
| Network policy | `src/security/outbound-url.ts` | A bug here can send bearer tokens to a private host |
| Output redaction | `src/security/redaction.ts` | A bug here can persist secrets or tool output into durable events |
| Skills / plugins | `src/skills/*.ts`, `src/plugins/*.ts` | A bug here executes arbitrary instructions or imports arbitrary code |
| Workspace containment | `src/workspace/fs.ts` | A bug here can escape the project root or follow a symlink outside it |

### Standard paths (≥80% coverage per file)

Everything else inside `src/` that is not excluded from coverage. This
covers CLI plumbing, daemon lifecycle, runtime orchestration, scheduler,
memory compaction, config, and the HTTP routing surface.

### Low-risk boilerplate (no coverage threshold)

Excluded from `vitest.config.ts` coverage but covered by integration or
E2E suites:

- `src/cli.tsx` — exercised end-to-end via `tests/e2e/`
- `src/onboarding.ts` — exercised end-to-end via `tests/e2e/`
- `src/server.ts` entrypoint — exercised by `tests/server.integration.test.ts`
  and `tests/sse.test.ts`
- `src/daemon.ts` — exercised by `tests/cli.integration.test.ts`
- `src/ui/**` — the Ink TUI, exercised by manual smoke tests and the
  state/reducer unit tests in `tests/tui.*.test.ts`
- `src/web/**` — the React PWA, exercised by `tests/e2e/web.smoke.spec.ts`
- `src/memory/schema.ts` — Drizzle schema, type-only surface
- `src/providers/types.ts` — type-only surface

## Test pyramid

| Tier | Tool | Files | Runs on |
|---|---|---|---|
| Unit | vitest | `tests/**/*.test.ts` excluding `*.integration.test.ts` | Every push |
| Integration | vitest | `tests/**/*.integration.test.ts` | Every PR |
| End-to-end | Playwright | `tests/e2e/*.spec.ts` | Every PR and merge to main |
| Mutation | Stryker (vitest runner) | critical paths only | Every PR and merge to main |

### Unit tier

`npm run test:unit` — runs `vitest run` with the integration pattern
excluded. Unit tests must:

- Touch no I/O beyond `node:os.tmpdir()`
- Never spawn a subprocess or open a network socket
- Be deterministic — no `Date.now()`, `Math.random()`, or wall-clock
  comparisons. Use injected clocks and seeded RNGs
- Run in under 200 ms per `it` block on the CI runner

Pure logic, edge cases, and boundary conditions live here: validators,
canonicalizers, hashers, encoders, reducers, projection functions, and
contracts.

### Integration tier

`npm run test:integration` — runs `vitest run` restricted to
`tests/**/*.integration.test.ts`. Integration tests may:

- Open real SQLite databases in `node:os.tmpdir()` via `mkdtemp`
- Start real HTTP servers via `node:http` or `Hono.fetch()`
- Spawn local subprocesses for media probing and Codex responses
- Use the deterministic provider as a stand-in for Ollama and Codex

Integration tests must never reach a remote service. They are the floor
under everything that would otherwise be mocked into meaninglessness.

### End-to-end tier

`npm run test:e2e` — runs Playwright against a real daemon started with
`NUAAI_TEST_MODE=1`. The deterministic provider removes flake from model
output; the rest of the system is the production code path. E2E covers
the top user journeys only — every test in this tier must map to a
journey in the manifest, and a regression in this tier is a release blocker.

### Mutation tier

`npm run test:mutate` — runs Stryker against the critical-path glob
defined in `stryker.config.mjs`. Stryker mutates arithmetic, comparison,
boolean, and control-flow mutants (excluding string-literal and
unary-operator mutants, which are usually killed by accident). The test
suite must kill at least 60% of mutants per file (`thresholds.low` and
`thresholds.break`); 80% is the bar for the suite overall
(`thresholds.high`).

The mutation suite is slow and runs on every PR; it is not a gate on
every commit. A regression in the mutation score is treated as a
critical-path defect, not a flake.

## What a test must look like

These rules apply to every tier.

### Behavior, not implementation

Assert on public contracts and observable state. If the only way to test
the behaviour is to inspect a private symbol, the test is wrong; expose
the contract or refactor.

### Independent and deterministic

- No shared mutable state between tests. Use `beforeEach`/`afterEach`
  to create and dispose fixtures.
- No wall-clock dependencies. Inject `Date.now()` and `Math.random()`
  seams; assert against a fixed clock in the test.
- No network calls. If you need a remote service, replace it with a
  recorded fixture or a local container.

### Meaningful assertions

A test that calls a function and asserts `true` is a failure. Assert
specific expected values: the return shape, the side effect, the error
class, the rejection message.

```ts
// Bad: executed code, asserted nothing
it('runs', () => {
  registry.execute('workspace.read', { path: 'README.md' });
});

// Bad: tautological
expect(typeof result).toBe('object');

// Good: specific contract
await expect(
  registry.execute('workspace.read', { path: '../../etc/passwd' }, context),
).rejects.toThrow(/escapes workspace root/);
```

### No skip, no ignore, no commented-out assertions

There are no `@skip`, `it.skip`, or `xit` in this codebase. There are no
`/* istanbul ignore next */` comments. If a test fails, fix or delete it.
A flaky test that is quarantined instead of fixed is treated as a
defect and a release blocker.

## Coverage thresholds

Declared in `vitest.config.ts`. The build fails if any in-scope file
falls below 80% lines/functions/branches/statements. Excluded files are
not measured; they are covered by integration or E2E suites instead.

To check coverage locally:

```sh
npm run test:coverage
```

## Mutation testing

Declared in `stryker.config.mjs`. Stryker injects mutants into the
critical-path glob and re-runs the unit suite against each one. A
mutant is "killed" when at least one unit test fails; a "survived"
mutant means the test suite did not detect the injected fault.

To run mutation testing locally:

```sh
npm run test:mutate
```

Reports are written to `reports/mutation/`. Upload the JSON file to
`https://dashboard.stryker-mutator.io/` for trend tracking.

The mutation job is gated on every PR and merge to main. A drop of more
than 5% in the overall killed rate blocks the merge.

## How to run each tier

```sh
npm run test            # all suites (unit + integration)
npm run test:unit       # unit only — runs in seconds, run on every commit
npm run test:integration # integration only — runs in under a minute
npm run test:e2e         # Playwright against a real daemon
npm run test:coverage   # unit + integration with v8 coverage gate
npm run test:mutate      # Stryker against critical paths
npm run gate             # full release gate (version, lint, coverage, e2e, package smoke, audit)
```

## CI wiring

`.github/workflows/ci.yml` runs the tiers as separate jobs:

| Job | Trigger | Purpose |
|---|---|---|
| `lint` | every push | Biome + TypeScript |
| `unit` | every push | Unit suite + coverage gate |
| `integration` | PR + main | Integration suite |
| `e2e` | PR + main | Playwright against the production bundle |
| `mutation` | PR + main | Stryker against critical paths |
| `quality` | PR + main | Release gate (version, gate, diff hygiene, npm pack on tags) |

Jobs are wired with `needs:` so a failure in any earlier stage blocks
the downstream gate. `concurrency.cancel-in-progress: true` aborts
in-flight runs when a new commit lands.

## Policy on flaky tests

A test is flaky if it produces different results across repeated runs
without any code change. Flakiness is a defect, not a fact of life:

1. **Stop the bleeding.** Re-run the suite ten times locally. If the
   test fails once, file a defect and add the test to the next sprint.
2. **Quarantine is forbidden.** A `flaky` label is not a status; it is
   a deadline. The flaky test must be fixed or deleted before the
   next release.
3. **No retries on CI.** Vitest's `retry` is set to zero. Playwright
   `retries` is set to zero. Retries hide the bug.
4. **No sleep-based waits.** Use deterministic signals: events with
   IDs, ports that return when ready, response streams that close.

## Adding a new test

1. Identify the tier. Default to unit. Move to integration if the test
   needs real I/O. Move to E2E if the test must cover a user journey
   across the daemon and a browser.
2. Place the file under `tests/` using the naming convention
   `<module>.test.ts` for unit, `<module>.integration.test.ts` for
   integration, `<journey>.spec.ts` for E2E.
3. Use `mkdtemp(join(tmpdir(), 'nuaai-<scope>-'))` for any temp file
   or database. Add a `roots.push(root)` and `afterEach` cleanup so
   tests are independent.
4. Write the failing assertion first. If the test passes on the
   first run, you have not tested anything.
5. Run `npm run test:unit` and confirm the suite still passes.
6. If the new test is on a critical path, run `npm run test:mutate`
   locally and confirm the mutation score holds.

## Policy on new source files

For every new `src/` file:

1. Add a unit test under `tests/` in the same commit.
2. The test must assert at least one behaviour that is unique to the
   file. A test that exercises a file but only asserts on a higher
   level does not count.
3. If the file falls in the critical-path glob, the test must push
   the file's mutation score above 60%.
4. No `// coverage: ignore-next-line` and no skipping. If a branch is
   unreachable, delete the branch.

This is TDD for critical paths and BDD-style acceptance tests for
user-facing behaviour.

## What "remove diff noise" means here

Anything that survives in the working tree without an owner is noise.
Specifically:

- Untracked files not referenced by the build (`src/core/tool-errors.ts`
  with no importers, `artifacts/baseline-report.*` from a one-shot
  audit) are deleted on sight.
- Dead exports with no consumers (`webSocketCloseDisposition`,
  `EventReplayBuffer`, `EventReplayCursor`) are deleted in the
  commit that retires them.
- Excluded-from-coverage entries in `vitest.config.ts` exist only for
  files exercised by integration or E2E. A file that is neither
  tested nor excluded is a defect.
- `.gitignore` covers `coverage/`, `test-results/`, `playwright-report/`,
  and `reports/`. Generated artifacts never enter the source tree.
