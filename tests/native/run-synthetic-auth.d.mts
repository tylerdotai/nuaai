export const NORMAL_CASES: readonly string[];
export const FAULT_CASES: readonly string[];
export function hashFile(path: string): string;
export function traceAttempts(trace: string): { pid: string; syscall: string }[];
export function tcpSocketAttempts(
  trace: string,
): { domain: number; type: number; protocol: number }[];
export function decodeEvidence(raw: string): unknown;
export function validateEvidence(data: unknown, name: string, fault?: boolean): unknown;
export function run(argv: string[]): void;
