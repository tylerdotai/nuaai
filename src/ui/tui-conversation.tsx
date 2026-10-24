import { Box, Text } from 'ink';
import { Fragment } from 'react';
import { TuiApprovalCard, TuiToolList } from './tui-activity.js';
import { TuiEditor, layoutDraft } from './tui-editor.js';
import { conversationBudget } from './tui-layout.js';
import { TuiMarkdown } from './tui-markdown.js';
import {
  type TuiApproval,
  type TuiConversationMessage,
  type TuiToolActivity,
  tuiArtifactLines,
} from './tui-state.js';
import { TuiViewport } from './tui-viewport.js';

export function TuiConversation({
  title,
  messages,
  stream,
  input,
  attachments = [],
  historyOffset,
  tools,
  cursor = input.length,
  compact = false,
  toolDetails = false,
  height = 24,
  columns = 80,
  onHistoryExtent,
  focus,
  onFocus,
  activeRunId,
  approvals = [],
  selectedApprovalId,
  approvalDetailOffset = 0,
  onApprovalDetailExtent,
}: {
  cursor?: number;
  height?: number;
  columns?: number;
  onHistoryExtent?: (maximum: number) => void;
  focus?: { index: number; revision: number };
  onFocus?: (offset: number) => void;
  compact?: boolean;
  toolDetails?: boolean;
  title: string;
  messages: TuiConversationMessage[];
  stream: string;
  input: string;
  attachments?: string[];
  historyOffset: number;
  tools: TuiToolActivity[];
  activeRunId?: string | null;
  approvals?: TuiApproval[];
  selectedApprovalId?: string;
  approvalDetailOffset?: number;
  onApprovalDetailExtent?: (maximum: number) => void;
}): React.JSX.Element {
  const selectedApproval =
    approvals.find((approval) => approval.id === selectedApprovalId) ?? approvals[0];
  const budget = conversationBudget(
    height - Number(attachments.length > 0),
    columns,
    layoutDraft(input, Math.max(1, columns - 6)).length,
    Boolean(selectedApproval),
  );
  if (budget.fallback)
    return (
      <Box height={budget.rows} width={columns} overflow="hidden" flexDirection="column">
        {budget.rows > 0 && (
          <Text wrap="truncate-end">
            Resize terminal to 32×{selectedApproval ? 10 : 7} · Ctrl-C exit
          </Text>
        )}
      </Box>
    );
  const snapshot = messages.find(
    (message) => message.role === 'assistant' && message.runId === activeRunId,
  );
  const liveTools = tools.length ? tools : (snapshot?.tools ?? []);
  const liveText = stream || snapshot?.content || '';
  const showLive = Boolean(
    stream ||
      (activeRunId &&
        (liveTools.length || approvals.some((approval) => approval.runId === activeRunId))),
  );
  const visibleMessages = messages.filter(
    (message) =>
      !(showLive && activeRunId && message.role === 'assistant' && message.runId === activeRunId),
  );
  const liveAfter = visibleMessages.findIndex(
    (message) => message.role === 'user' && message.runId === activeRunId,
  );
  const liveMessage = (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>NUAAI</Text>
      <TuiToolList tools={liveTools} expanded={toolDetails} />
      {liveText && <TuiMarkdown content={liveText} />}
    </Box>
  );
  return (
    <Box
      flexDirection="column"
      height={budget.rows + Number(attachments.length > 0)}
      width={columns}
      overflow="hidden"
      flexShrink={0}
    >
      <Text dimColor wrap="truncate-end">
        {title}
      </Text>
      <TuiViewport
        height={budget.transcript}
        offset={historyOffset}
        onExtent={onHistoryExtent}
        focus={focus}
        onFocus={onFocus}
        readingAnchor={messages[0]?.id}
      >
        {messages.length === 0 && !showLive && approvals.length === 0 && (
          <Box marginY={1}>
            <Text dimColor>What are we working on?</Text>
          </Box>
        )}
        {visibleMessages.map((message, index) => (
          <Fragment key={message.id ?? `${index}-${message.role}`}>
            <Box flexDirection="column" marginTop={compact ? 0 : 1}>
              <Text bold color={message.role === 'user' ? 'blue' : undefined}>
                {message.role === 'user' ? 'You' : 'NUAAI'}
              </Text>
              {message.role === 'assistant' && (
                <TuiToolList tools={message.tools ?? []} expanded={toolDetails} />
              )}
              {message.content &&
                (message.role === 'assistant' ? (
                  <TuiMarkdown content={message.content} />
                ) : (
                  <Text>{message.content}</Text>
                ))}
              {tuiArtifactLines(message).map((line, lineIndex) => (
                <Text color="blue" key={`${lineIndex}:${line}`}>
                  {line}
                </Text>
              ))}
            </Box>
            {showLive && index === liveAfter && liveMessage}
          </Fragment>
        ))}
        {showLive && liveAfter === -1 && liveMessage}
      </TuiViewport>
      {selectedApproval && (
        <TuiApprovalCard
          approval={selectedApproval}
          height={budget.approval}
          detailOffset={approvalDetailOffset}
          onDetailExtent={onApprovalDetailExtent}
        />
      )}
      {attachments.length > 0 && (
        <Text color="blue" wrap="truncate-end">
          Files: {attachments.join(' · ')} · Alt-E manage
        </Text>
      )}
      <TuiEditor input={input} cursor={cursor} columns={columns} maxRows={budget.editor} />
      <Text dimColor wrap="truncate-end">
        {historyOffset
          ? 'Reading earlier · Up/Down or PgUp/PgDn scroll · Ctrl-End live'
          : '/ commands · Enter send · Alt-Enter newline · PgUp/PgDn chat'}
        {historyOffset ? ` · ${historyOffset} rows above latest` : ''}
      </Text>
    </Box>
  );
}
