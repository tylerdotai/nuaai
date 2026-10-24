/** Heights include all borders and chrome. Never round a region up past its owner's budget. */
export function conversationBudget(
  height: number,
  columns: number,
  draftRows: number,
  approval: boolean,
) {
  const rows = Math.max(0, Math.floor(height));
  const minimum = approval ? 10 : 7;
  if (columns < 32 || rows < minimum)
    return { rows, fallback: true, editor: 0, approval: 0, transcript: 0 };
  const approvalRows = approval ? Math.min(10, Math.max(3, Math.floor((rows - 5) / 2))) : 0;
  const editor = Math.min(5, draftRows, rows - approvalRows - 5);
  return {
    rows,
    fallback: false,
    editor,
    approval: approvalRows,
    transcript: rows - approvalRows - editor - 4,
  };
}
