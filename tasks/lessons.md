# Lessons

- When a user says the implementation is overcomplicated, compare the behavior against the reference system before adding another heuristic. Hermes uses a stable session toolset, a provider call → tool dispatch → continuation loop, permission boundaries, and a hard iteration budget; it does not classify ordinary model prose as capability failure.
- Keep verification gates tied to the user request requiring an external action. Do not reject normal conversational output merely because the model mentions missing access or tools.
- Do not publish a final completion report while any asynchronous reviewer is outstanding. Reconcile every late verdict against the exact current tree; stale findings may still contain one unfixed path.
- Clearing a polling interval does not cancel its in-flight request. Abort the request on selection cleanup and generation-check both success and failure handlers before mutating client state.
- Never reject a substantive model response because a broad regex finds a future-tense phrase. Restrict unfinished-promise detection to short standalone responses and use typed tool evidence for completion truth.
- Do not persist token-sized deltas as lifecycle truth. Batch deltas, reset visible output at model-attempt boundaries, and persist the current attempt as the authoritative reconnect snapshot.
- Extend the executable registry rather than adding a parallel policy catalog. Permission, input validation, cost reservation, side-effect policy, and per-tool limits must converge at one pre-action admission boundary.
- Keep one stable permission-filtered tool catalog per run. Per-step top-k mutation saves prompt tokens at the cost of prompt-cache churn and capabilities disappearing mid-workflow; use registry budgets and typed MCP mediation instead.
- Do not expose a public second-stage `executeAuthorized` API with a caller-constructible admission object. Keep permission, input, and budget admission inside the single public `execute` boundary and emit lifecycle state through an internal post-admission callback.
