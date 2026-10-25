import { describe, expect, it } from 'vitest';
import {
  FAULT_CASES,
  NORMAL_CASES,
  decodeEvidence,
  run,
  tcpSocketAttempts,
  traceAttempts,
  validateEvidence,
} from './run-synthetic-auth.mjs';

function managed() {
  return {
    version: 1,
    case: 'managed_same_owner',
    upstream_pin: '6aaac694803004a63c6f393d153c96d22521a6b9',
    storage: 'file',
    auth_policy_before: 'unavailable',
    auth_policy_after: 'unavailable',
    measurement: 'normal_snapshot',
    auth_factory_guarded: true,
    stageA: 'managed',
    stageB: 'managed',
    owner_checks: { a_current: true, b_current: true, after_drift: null },
    header_checks: {
      bearer_present: true,
      account_present: true,
      account_matches_B: true,
      token_matches_B: true,
      unchanged_after_store_drift: null,
    },
    manager_watch_changed_after_drift: null,
    drift_measurement: null,
    bootstrap_witness_A: null,
    result: 'eligible_frozen_snapshot',
    content_constructed: false,
    refresh_invoked: false,
    freshness: 'not_validated',
  };
}

describe('portable synthetic auth evidence contracts without I/O', () => {
  it('requires explicit options and has exactly 23 normal and two distinct fault cases', () => {
    expect(() => run([])).toThrow('Supply exactly the seven explicit runner options');
    expect(new Set(NORMAL_CASES).size).toBe(23);
    expect(new Set(FAULT_CASES).size).toBe(2);
    expect(FAULT_CASES.every((name) => !NORMAL_CASES.includes(name))).toBe(true);
  });

  it('accepts only the actual complete bound eligible snapshot shape', () => {
    const data = managed();
    expect(validateEvidence(data, data.case)).toBe(data);
    for (const change of [
      { content_constructed: true },
      { refresh_invoked: true },
      { freshness: 'validated' },
      { auth_factory_guarded: false },
      { result: 'rejected' },
    ]) {
      expect(() => validateEvidence({ ...data, ...change }, data.case)).toThrow();
    }
  });

  it('rejects missing owner or header binding even when result says eligible', () => {
    const data = managed();
    expect(() =>
      validateEvidence(
        { ...data, owner_checks: { ...data.owner_checks, a_current: false } },
        data.case,
      ),
    ).toThrow('Eligible pair lacks current owners');
    expect(() =>
      validateEvidence(
        { ...data, header_checks: { ...data.header_checks, token_matches_B: false } },
        data.case,
      ),
    ).toThrow('Eligible pair lacks actual bound B headers');
  });

  it('does not disclose unexpected sensitive fields or malformed raw output in diagnostics', () => {
    const data = managed();
    const sentinel = 'never-return-this-payload';
    for (const invoke of [
      () => validateEvidence({ ...data, authorization: sentinel }, data.case),
      () => validateEvidence({ ...data, stageA: sentinel }, data.case),
      () => decodeEvidence(`invalid ${sentinel}`),
    ]) {
      let message = '';
      try {
        invoke();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(sentinel);
    }
  });

  it('does not treat agent parse rejection as an actual bootstrap policy witness', () => {
    const data = {
      ...managed(),
      case: 'stored_agent_jwt',
      stageA: 'native_error',
      stageB: 'none',
      result: 'rejected',
      bootstrap_witness_A: 'unclassified_native_error',
    };
    expect(() => validateEvidence(data, data.case)).toThrow(
      'Missing/wrong actual bootstrap witness',
    );
    expect(() =>
      validateEvidence({ ...data, bootstrap_witness_A: 'typed_unavailable' }, data.case),
    ).not.toThrow();
  });

  it('requires explicit manual drift metadata and cache-watch non-notification', () => {
    const data = {
      ...managed(),
      case: 'managed_idle_owner_switch',
      result: 'rejected',
      drift_measurement: 'manual_persisted_owner_recheck',
      owner_checks: { a_current: true, b_current: true, after_drift: false },
      header_checks: { ...managed().header_checks, unchanged_after_store_drift: true },
      manager_watch_changed_after_drift: false,
    };
    expect(() => validateEvidence(data, data.case)).not.toThrow();
    expect(() =>
      validateEvidence({ ...data, manager_watch_changed_after_drift: true }, data.case),
    ).toThrow('Manual owner/cache-watch/frozen-header observation differs');
  });

  it('requires a real INET stream socket for fault evidence, not unrelated network setup', () => {
    const trace = [
      '11 socketpair(0x1, 0x80801, 0, 0x4) = -1 EPERM (INJECTED)',
      '11 socket(0x1, 0x1, 0) = -1 EPERM (INJECTED)',
      '11 socket(0x2, 0x2, 0x11) = -1 EPERM (INJECTED)',
      '11 socket(0xa, 0x80001, 0x6) = -1 EPERM (INJECTED)',
      '11 socket(0x2, 0x80801, 0) = -1 EPERM (INJECTED)',
    ].join('\n');
    expect(tcpSocketAttempts(trace)).toEqual([
      { domain: 10, type: 0x80001, protocol: 6 },
      { domain: 2, type: 0x80801, protocol: 0 },
    ]);
    expect(tcpSocketAttempts('11 socketpair(0x1, 0x80801, 0, 0x4) = -1 EPERM (INJECTED)')).toEqual(
      [],
    );
  });

  it('counts socketpair, uring, unfamiliar and unfinished calls as attempts, without an AF_UNIX exemption', () => {
    const trace = [
      '11 execve(0x1, 0x2, 0x3) = 0',
      '11 close_range(0x3, 0xffffffff, 0) = 0',
      '11 socketpair(0x1, 0x80801, 0, 0x4) = -1 EPERM (INJECTED)',
      '12 io_uring_setup(0, 0) = -1 EPERM (INJECTED)',
      '12 future_network_call(0 <unfinished ...>',
      '12 <... future_network_call resumed>) = -1 EPERM (INJECTED)',
    ].join('\n');
    expect(traceAttempts(trace)).toEqual([
      { pid: '11', syscall: 'socketpair' },
      { pid: '12', syscall: 'io_uring_setup' },
      { pid: '12', syscall: 'future_network_call' },
    ]);
  });
});
