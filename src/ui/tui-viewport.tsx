import { Box, type DOMElement, measureElement } from 'ink';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

/** Clip by measured terminal rows, not message count, so long replies remain navigable. */
export function TuiViewport({
  children,
  height,
  offset,
  anchor = 'end',
  onExtent,
  focus,
  onFocus,
  readingAnchor,
}: {
  children: ReactNode;
  height: number;
  offset: number;
  anchor?: 'start' | 'end';
  onExtent?: (maximum: number) => void;
  focus?: { index: number; revision: number };
  onFocus?: (offset: number) => void;
  readingAnchor?: string;
}): React.JSX.Element {
  const ref = useRef<DOMElement>(null);
  const focused = useRef<typeof focus>(undefined);
  const previousLayout = useRef<{ anchor?: string; measured: number; height: number }>(undefined);
  const [contentHeight, setContentHeight] = useState(0);
  const maximum = Math.max(0, contentHeight - height);
  const top =
    anchor === 'start'
      ? Math.min(offset, maximum)
      : Math.max(0, maximum - Math.min(offset, maximum));
  useLayoutEffect(() => {
    if (ref.current) {
      const measured = measureElement(ref.current).height;
      const previous = previousLayout.current;
      previousLayout.current = { anchor: readingAnchor, measured, height };
      setContentHeight(measured);
      if (
        anchor === 'end' &&
        readingAnchor &&
        previous?.anchor === readingAnchor &&
        offset > 0 &&
        (!focus || focused.current === focus)
      ) {
        const growth = measured - previous.measured - (height - previous.height);
        if (growth) onFocus?.(Math.max(0, Math.min(measured - height, offset + growth)));
      }
      if (focus && focused.current !== focus) {
        const target = ref.current.childNodes[focus.index]?.yogaNode;
        if (target) {
          focused.current = focus;
          onFocus?.(Math.max(0, measured - height - target.getComputedTop()));
        }
      }
      onExtent?.(Math.max(0, measured - height));
    }
  });
  return (
    <Box height={height} overflowY="hidden" flexDirection="column">
      <Box ref={ref} flexDirection="column" flexShrink={0} marginTop={-top}>
        {children}
      </Box>
    </Box>
  );
}
