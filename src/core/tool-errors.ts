export type ToolExecutionState = 'not_executed' | 'uncertain';
export type ToolRecovery =
  | 'repair_arguments'
  | 'change_approach'
  | 'discover_executable'
  | 'inspect_destination'
  | 'change_setting';

export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly executionState: ToolExecutionState,
    readonly recovery: ToolRecovery,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export function isRepairableToolRejection(error: unknown): error is ToolExecutionError {
  return (
    error instanceof ToolExecutionError &&
    error.executionState === 'not_executed' &&
    !['inspect_destination', 'change_setting'].includes(error.recovery)
  );
}
