import { createOpenCodeServerClient } from '@/modules/providers/list/opencode/opencode-server.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

const PROVIDER = 'opencode';

/** One `{ info, parts }` row the SDK returns from `session.messages`. */
type OpenCodeMessageRow = {
  info: Record<string, unknown> | null;
  parts: Record<string, unknown>[];
};

type OpenCodeTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') {
    return unwrapJsonStringLiteral(value);
  }

  const record = readObjectRecord(value);
  const text = readOptionalString(record?.text)
    ?? readOptionalString(record?.content)
    ?? '';
  return unwrapJsonStringLiteral(text);
};

const buildTokenUsage = (totals: OpenCodeTokenTotals | undefined): AnyRecord | undefined => {
  if (!totals) {
    return undefined;
  }

  const inputTokens = totals.inputTokens;
  const displayInputTokens = inputTokens + totals.cacheReadTokens;
  const outputTokens = totals.outputTokens;
  const used = inputTokens
    + outputTokens
    + totals.reasoningTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens;

  if (used <= 0) {
    return undefined;
  }

  return {
    used,
    inputTokens: displayInputTokens,
    outputTokens,
    breakdown: {
      input: displayInputTokens,
      output: outputTokens,
    },
  };
};

/**
 * Sums the per-message token counters OpenCode stores on assistant messages
 * into the single budget the frontend renders. Session aggregates live on the
 * session record, but the message-level counters are what the history payload
 * already carries, so no extra request is needed.
 */
const aggregateTokenUsage = (rows: OpenCodeMessageRow[]): AnyRecord | undefined => {
  const totals: OpenCodeTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  for (const row of rows) {
    if (readOptionalString(row.info?.role) !== 'assistant') {
      continue;
    }

    const tokens = readObjectRecord(row.info?.tokens);
    if (!tokens) {
      continue;
    }

    totals.inputTokens += Number(tokens.input ?? 0);
    totals.outputTokens += Number(tokens.output ?? 0);
    totals.reasoningTokens += Number(tokens.reasoning ?? 0);
    const cache = readObjectRecord(tokens.cache);
    totals.cacheReadTokens += Number(cache?.read ?? 0);
    totals.cacheWriteTokens += Number(cache?.write ?? 0);
  }

  return buildTokenUsage(totals);
};

export class OpenCodeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live `opencode run --format json` events into frontend messages.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const type = readOptionalString(raw.type) ?? readOptionalString(raw.event);
    const eventSessionId = readOptionalString(raw.sessionID) ?? readOptionalString(raw.sessionId) ?? sessionId;
    const timestamp = normalizeProviderTimestamp(raw.time ?? raw.timestamp);
    const baseId = readOptionalString(raw.id)
      ?? readOptionalString(raw.messageID)
      ?? generateMessageId('opencode');

    if (type === 'text') {
      // The client already renders an optimistic user bubble, so provider user
      // echoes must not be streamed back as assistant text.
      if (isUserTextEcho(raw)) {
        return [];
      }

      const content = extractText(raw.text ?? raw.delta ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        content,
      })];
    }

    if (type === 'reasoning') {
      const content = extractText(raw.text ?? raw.delta ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        content,
      })];
    }

    if (type === 'tool_use') {
      const toolName = readOptionalString(raw.tool) ?? readOptionalString(raw.name) ?? 'Tool';
      const toolId = readOptionalString(raw.callID) ?? readOptionalString(raw.toolCallId) ?? baseId;
      const toolMessage = createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName,
        toolInput: raw.input ?? raw.arguments ?? {},
        toolId,
      });

      if (raw.output !== undefined || raw.error !== undefined) {
        toolMessage.toolResult = {
          content: formatToolContent(raw.output ?? raw.error),
          isError: raw.error !== undefined,
        };
      }

      return [toolMessage];
    }

    if (type === 'error') {
      const error = readObjectRecord(raw.error);
      const data = readObjectRecord(error?.data);
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        content: readOptionalString(raw.error)
          ?? readOptionalString(data?.message)
          ?? readOptionalString(error?.message)
          ?? readOptionalString(raw.message)
          ?? 'Unknown OpenCode error',
      })];
    }

    if (type === 'step_finish') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    return [];
  }

  /**
   * Loads OpenCode history through the server SDK.
   *
   * The server returns the session's messages and parts in the same shape the
   * CLI persists, so live history and a reload agree. Fails closed to an empty
   * page when no server is reachable, matching the previous disk reader.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // The server keys history by its own session id, not the app-facing one;
    // the caller translates an app id through `providerSessionId`.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const directory = options.projectPath;

    let rows: OpenCodeMessageRow[];
    try {
      const client = createOpenCodeServerClient();
      const result = await client.session.messages(
        { sessionID: providerSessionId, directory },
        { throwOnError: true },
      );
      const data = Array.isArray(result.data) ? result.data : [];
      rows = data.map((entry) => ({
        info: readObjectRecord(entry?.info),
        parts: Array.isArray(entry?.parts)
          ? entry.parts.map(readObjectRecord).filter((part): part is Record<string, unknown> => part !== null)
          : [],
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const normalized = this.normalizeHistoryMessages(rows, sessionId);
    const tokenUsage = aggregateTokenUsage(rows);

    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const total = normalized.length;
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage,
    };
  }

  private normalizeHistoryMessages(rows: OpenCodeMessageRow[], sessionId: string): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    const emittedMessageErrors = new Set<string>();

    for (const row of rows) {
      const messageInfo = row.info;
      const messageId = readOptionalString(messageInfo?.id) ?? generateMessageId('opencode');
      const messageRole = readOptionalString(messageInfo?.role);
      const timestamp = normalizeProviderTimestamp(readObjectRecord(messageInfo?.time)?.created);

      if (
        messageInfo
        && messageRole === 'assistant'
        && messageInfo.error != null
        && !emittedMessageErrors.has(messageId)
      ) {
        emittedMessageErrors.add(messageId);
        normalized.push(createNormalizedMessage({
          id: `${messageId}_error`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'error',
          content: formatToolContent(messageInfo.error),
        }));
      }

      row.parts.forEach((partData, partIndex) => {
        const partId = readOptionalString(partData.id) ?? String(partIndex);
        const baseId = `${messageId}_${partId}`;
        const partType = readOptionalString(partData.type);
        if (!partType) {
          return;
        }

        if (partType === 'text') {
          const rawContent = extractText(partData);
          // User prompts sent with attachments carry an <images_input> path
          // list; strip it for display and surface the paths as images.
          const parsedImages = messageRole === 'user'
            ? parseImagesInputTag(rawContent)
            : { text: rawContent, attachments: [] };
          const parsedFiles = messageRole === 'user'
            ? parseFilesInputTag(parsedImages.text)
            : { text: rawContent, attachments: [] };
          if (
            parsedFiles.text.trim()
            || parsedImages.attachments.length > 0
            || parsedFiles.attachments.length > 0
          ) {
            normalized.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp,
              provider: PROVIDER,
              kind: 'text',
              role: messageRole === 'user' ? 'user' : 'assistant',
              content: parsedFiles.text,
              images: parsedImages.attachments.length > 0 ? parsedImages.attachments : undefined,
              files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
            }));
          }
          return;
        }

        if (partType === 'reasoning') {
          const content = extractText(partData);
          if (content.trim()) {
            normalized.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp,
              provider: PROVIDER,
              kind: 'thinking',
              content,
            }));
          }
          return;
        }

        if (partType === 'tool') {
          const state = readObjectRecord(partData.state) ?? {};
          const status = readOptionalString(state.status);
          const toolMessage = createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: readOptionalString(partData.tool) ?? 'Tool',
            toolInput: state.input ?? partData.input ?? {},
            toolId: readOptionalString(partData.callID) ?? partId,
          });

          if (status === 'completed' || status === 'error') {
            toolMessage.toolResult = {
              content: formatToolContent(state.output ?? state.error),
              isError: status === 'error',
            };
          }

          normalized.push(toolMessage);
          return;
        }

        if (partType === 'step-finish') {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'stream_end',
          }));
          return;
        }

        if (partType === 'patch' || partType === 'agent') {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: partType === 'patch' ? 'Patch' : 'Agent',
            toolInput: partData,
            toolId: partId,
          }));
        }
      });
    }

    return normalized;
  }
}

const hasUserRole = (value: unknown): boolean => {
  const record = readObjectRecord(value);
  return readOptionalString(record?.role) === 'user';
};

const isUserTextEcho = (raw: AnyRecord): boolean => {
  return readOptionalString(raw.role) === 'user'
    || hasUserRole(raw.message)
    || hasUserRole(raw.part);
};
