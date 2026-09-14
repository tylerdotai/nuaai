interface ScrollGeometry {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isNearScrollBottom(geometry: ScrollGeometry, threshold = 96): boolean {
  return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight <= threshold;
}

export function shouldFollowNewOutput({
  nearBottom,
  forceFollow,
}: {
  nearBottom: boolean;
  forceFollow: boolean;
}): boolean {
  return nearBottom || forceFollow;
}

export function shouldShowNewResponseButton({
  nearBottom,
  hasLiveResponse,
}: {
  nearBottom: boolean;
  hasLiveResponse: boolean;
}): boolean {
  return !nearBottom && hasLiveResponse;
}

export function preserveScrollAnchor({
  previousScrollHeight,
  previousScrollTop,
  nextScrollHeight,
}: {
  previousScrollHeight: number;
  previousScrollTop: number;
  nextScrollHeight: number;
}): number {
  return previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight);
}
