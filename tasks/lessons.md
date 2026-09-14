# Lessons

- When a user says the implementation is overcomplicated, compare the behavior against the reference system before adding another heuristic. Hermes uses a stable session toolset, a provider call → tool dispatch → continuation loop, permission boundaries, and a hard iteration budget; it does not classify ordinary model prose as capability failure.
- Keep verification gates tied to the user request requiring an external action. Do not reject normal conversational output merely because the model mentions missing access or tools.
- Do not publish a final completion report while any asynchronous reviewer is outstanding. Reconcile every late verdict against the exact current tree; stale findings may still contain one unfixed path.
- Clearing a polling interval does not cancel its in-flight request. Abort the request on selection cleanup and generation-check both success and failure handlers before mutating client state.
