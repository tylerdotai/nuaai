# Scheduler Contract

A schedule is a durable instruction; it is not evidence that the resulting agent run completed. Creation returns an identifier. Later execution must be checked through the scheduler/task/run result.

Mutating operations must preserve the exact target ID and requested expression. Do not invent timezone behavior or execution results when the tool does not return them.
