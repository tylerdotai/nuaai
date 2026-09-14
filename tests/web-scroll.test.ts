import { describe, expect, it } from 'vitest';

import {
  isNearScrollBottom,
  preserveScrollAnchor,
  shouldFollowNewOutput,
  shouldShowNewResponseButton,
} from '../src/web/scroll.js';

describe('conversation scroll policy', () => {
  it('treats only the final threshold as near the bottom', () => {
    expect(isNearScrollBottom({ scrollHeight: 2_000, scrollTop: 1_120, clientHeight: 800 })).toBe(
      true,
    );
    expect(isNearScrollBottom({ scrollHeight: 2_000, scrollTop: 1_000, clientHeight: 800 })).toBe(
      false,
    );
  });

  it('follows output only near the bottom unless the user just sent a message', () => {
    expect(shouldFollowNewOutput({ nearBottom: true, forceFollow: false })).toBe(true);
    expect(shouldFollowNewOutput({ nearBottom: false, forceFollow: false })).toBe(false);
    expect(shouldFollowNewOutput({ nearBottom: false, forceFollow: true })).toBe(true);
  });

  it('shows the jump control immediately when the reader leaves a live response', () => {
    expect(shouldShowNewResponseButton({ nearBottom: false, hasLiveResponse: true })).toBe(true);
    expect(shouldShowNewResponseButton({ nearBottom: true, hasLiveResponse: true })).toBe(false);
    expect(shouldShowNewResponseButton({ nearBottom: false, hasLiveResponse: false })).toBe(false);
  });

  it('preserves the visible anchor when older messages increase scroll height', () => {
    expect(
      preserveScrollAnchor({
        previousScrollHeight: 2_000,
        previousScrollTop: 320,
        nextScrollHeight: 2_840,
      }),
    ).toBe(1_160);
    expect(
      preserveScrollAnchor({
        previousScrollHeight: 2_000,
        previousScrollTop: 320,
        nextScrollHeight: 1_800,
      }),
    ).toBe(320);
  });
});
