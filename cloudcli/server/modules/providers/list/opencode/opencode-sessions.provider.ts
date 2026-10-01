import {
  createOpenCodeServerClients,
  type OpenCodeServer,
} from '@/modules/providers/list/opencode/opencode-server.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  AppError,
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

const PROVIDER = 'opencode';

/**
 * Page size requested from the v2 messages endpoint.
 *
 * 200 is the server's hard cap (larger values are rejected), so it minimizes
 * the number of round trips needed to page through a long transcript.
 */
const V2_MESSAGES_PAGE_SIZE = 200;
/** Safety bound so a broken or repeating cursor cannot loop forever. */
const MAX_V2_MESSAGE_PAGES = 200;
/** Per-request timeout for the raw v2 history reads. */
const V2_MESSAGES_TIMEOUT_MS = 30_000;

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

/**
 * True when an assistant message's error is only the abort OpenCode emits
 * after its own `question` call was dismissed.
 *
 * Dismissing a question is a deliberate user action; surfacing the resulting
 * step abort as an error row would make the phone look like something failed.
 */
function hasDismissedQuestionError(parts: Record<string, unknown>[]): boolean {
  return parts.some((part) => {
    if (readOptionalString(part.type) !== 'tool') {
      return false;
    }
    const toolName = readOptionalString(part.tool) ?? readOptionalString(part.name);
    if (toolName !== 'question') {
      return false;
    }
    const state = readObjectRecord(part.state) ?? {};
    if (readOptionalString(state.status) !== 'error') {
      return false;
    }
    const error = readObjectRecord(state.error);
    const message = readOptionalString(error?.message) ?? readOptionalString(state.error) ?? '';
    return /dismissed/i.test(message);
  });
}

/**
 * Folds a completed question call's `metadata.answers` into its input, keyed
 * by the question text.
 *
 * OpenCode stores the chosen labels in the tool's metadata as an ordered
 * array of arrays; the transcript's question card reads answers from the input.
 */
function foldQuestionAnswers(input: unknown, metadata: Record<string, unknown> | null): unknown {
  const inputRecord = readObjectRecord(input);
  const answers = metadata?.answers;
  if (!inputRecord || !Array.isArray(answers)) {
    return inputRecord ?? {};
  }

  const questions = Array.isArray(inputRecord.questions) ? inputRecord.questions : [];
  const byQuestion: Record<string, string> = {};
  questions.forEach((entry, index) => {
    const question = readObjectRecord(entry);
    const text = readOptionalString(question?.question);
    const value = answers[index];
    const labels = Array.isArray(value)
      ? value.filter((label): label is string => typeof label === 'string')
      : [];
    if (text && labels.length > 0) {
      byQuestion[text] = labels.join(', ');
    }
  });

  return Object.keys(byQuestion).length > 0 ? { ...inputRecord, answers: byQuestion } : inputRecord;
}

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
   * Every discovered server is tried in turn, because the session may live on
   * the console's `opencode serve` or on a desktop app's background service.
   * Fails closed to an empty page when no server knows the session, matching
   * the previous disk reader.
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

    const rows = await this.readMessages(providerSessionId, directory);
    if (!rows) {
      // Every server answered definitively that it does not know the session,
      // so there is genuinely no transcript to return.
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    // The shared pass canonicalizes provider interaction rows (the native
    // `question` call becomes `AskUserQuestion`) and caps oversized tool
    // output, matching how the Claude and Codex readers build a transcript.
    const normalized = prepareTranscriptMessages(this.normalizeHistoryMessages(rows, sessionId));
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

  /**
   * Reads a session's messages from whichever discovered server owns it.
   *
   * A transient failure (a server hiccuping mid-run) must not read as an empty
   * transcript, so servers that errored get one immediate retry and the sweep
   * then reports failure instead of returning nothing. Only a definitive "this
   * server does not know the session" from every server yields null.
   */
  private async readMessages(
    providerSessionId: string,
    directory?: string,
  ): Promise<OpenCodeMessageRow[] | null> {
    const servers = createOpenCodeServerClients();
    const failed: Array<{ server: OpenCodeServer; error: string }> = [];

    for (const server of servers) {
      const result = await readServerMessages(server, providerSessionId, directory);
      if (result.status === 'ok') {
        return result.rows;
      }
      if (result.status === 'failed') {
        failed.push({ server, error: result.error });
      }
    }

    if (failed.length === 0) {
      return null;
    }

    // One retry covers the common transient case: the owning server is busy
    // finishing a turn and briefly refuses the read.
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const { server } of failed) {
      const result = await readServerMessages(server, providerSessionId, directory);
      if (result.status === 'ok') {
        return result.rows;
      }
    }

    const detail = failed.map((entry) => `${entry.server.config.url}: ${entry.error}`).join('; ');
    throw new AppError(`OpenCode history is temporarily unavailable (${detail}).`, {
      code: 'OPENCODE_HISTORY_UNAVAILABLE',
      statusCode: 503,
    });
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
        // A step aborted by dismissing the question is not a failure.
        && !hasDismissedQuestionError(row.parts)
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
          const toolName = readOptionalString(partData.tool) ?? 'Tool';
          const toolMessage = createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName,
            // OpenCode answers a `question` call through the tool's metadata,
            // not its input; fold the labels in so the card reads like the
            // Claude/Codex ones.
            toolInput: toolName === 'question'
              ? foldQuestionAnswers(state.input, readObjectRecord(state.metadata))
              : state.input ?? partData.input ?? {},
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

/** Outcome of asking one server for a session's messages. */
type ServerMessagesResult =
  | { status: 'ok'; rows: OpenCodeMessageRow[] }
  | { status: 'notFound' }
  | { status: 'failed'; error: string };

/**
 * Classifies a failed SDK read.
 *
 * - `notFound`: the server answered and does not know the session.
 * - `unsupported`: the route does not exist on this server version (the 1.18
 *   compatibility route on 2.0), which says nothing about the session.
 * - `failed`: network error, 5xx, ... — transient and worth retrying.
 */
function classifyServerReadError(message: string): 'notFound' | 'unsupported' | 'failed' {
  if (/not found/i.test(message)) {
    return 'notFound';
  }
  if (/not supported/i.test(message)) {
    return 'unsupported';
  }
  return 'failed';
}

/**
 * Asks one server for the session: paginated v2 first (2.0 only exposes
 * `/api/*`), then the 1.18 compatibility route, folding both into the
 * `{ info, parts }` shape.
 *
 * The v2 endpoint is paged and ordered by the caller, and the bundled SDK's
 * generated client predates both query params, so this read is a raw HTTP
 * call. Its default page is the newest 50 messages in reverse order, which is
 * why history used to arrive reversed and truncated.
 *
 * The 1.18 compatibility route is consulted whenever v2 reports no rows: a
 * 1.18 server answers its own legacy sessions with an empty v2 page instead of
 * a not-found error, and only the compat route can read them.
 */
async function readServerMessages(
  server: OpenCodeServer,
  providerSessionId: string,
  directory?: string,
): Promise<ServerMessagesResult> {
  let lastError: string | null = null;
  let notFound = false;
  let v2Rows: OpenCodeMessageRow[] | null = null;
  let v1Rows: OpenCodeMessageRow[] | null = null;

  try {
    v2Rows = await readV2Messages(server, providerSessionId);
  } catch (error) {
    const classification = classifyServerReadError(error instanceof Error ? error.message : String(error));
    if (classification === 'notFound') notFound = true;
    else if (classification === 'failed') lastError = error instanceof Error ? error.message : String(error);
  }

  if (v2Rows && v2Rows.length > 0) {
    return { status: 'ok', rows: v2Rows };
  }

  try {
    const result = await server.client.session.messages(
      { sessionID: providerSessionId, directory },
      { throwOnError: true },
    );
    if (Array.isArray(result.data)) {
      v1Rows = result.data.map((value) => v1MessageToRow(value));
    }
  } catch (error) {
    const classification = classifyServerReadError(error instanceof Error ? error.message : String(error));
    if (classification === 'notFound') notFound = true;
    else if (classification === 'failed') lastError = error instanceof Error ? error.message : String(error);
  }

  // Rows from either route win; the 1.18 compat route is what makes a 1.18
  // server's legacy sessions readable at all.
  if (v1Rows && v1Rows.length > 0) {
    return { status: 'ok', rows: v1Rows };
  }

  // A transient error with no rows anywhere outranks "not found" and "empty":
  // on 1.18 the v2 route answers 500 for sessions it *does* know, so failing
  // closed to an empty transcript would silently hide real history.
  if (lastError) {
    return { status: 'failed', error: lastError };
  }

  // An empty page whose compat read also answered (with rows or without them)
  // is a genuinely empty transcript, not an unknown session.
  if (v2Rows || v1Rows) {
    return { status: 'ok', rows: v2Rows ?? v1Rows ?? [] };
  }

  if (notFound) {
    return { status: 'notFound' };
  }
  return { status: 'failed', error: 'Unknown OpenCode history error' };
}

/** One page of v2 messages plus the cursor for the page that precedes it. */
type V2MessagesPage = {
  rows: OpenCodeMessageRow[];
  nextCursor: string | null;
};

/**
 * Reads every page of one server's v2 message history, oldest first.
 *
 * `order=asc` fixes the surface order (the default page is newest-first) and
 * `cursor` walks forward through time. The server rejects a cursor combined
 * with an explicit order, so only the first request carries `order`.
 */
async function readV2Messages(
  server: OpenCodeServer,
  providerSessionId: string,
): Promise<OpenCodeMessageRow[]> {
  const rows: OpenCodeMessageRow[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_V2_MESSAGE_PAGES; page += 1) {
    const result = await readV2MessagesPage(server, providerSessionId, cursor);
    rows.push(...result.rows);
    if (!result.nextCursor || result.rows.length === 0) {
      break;
    }
    cursor = result.nextCursor;
  }

  return rows;
}

/**
 * Reads one v2 message page through raw HTTP.
 *
 * The bundled `@opencode-ai/sdk` generated client predates the 2.0 server's
 * `order`/`cursor` query params ({@link readV2Messages} explains why they are
 * required), and the SDK drops unknown params instead of forwarding them, so
 * this cannot go through the SDK.
 */
async function readV2MessagesPage(
  server: OpenCodeServer,
  providerSessionId: string,
  cursor: string | null,
): Promise<V2MessagesPage> {
  const query = new URLSearchParams({ limit: String(V2_MESSAGES_PAGE_SIZE) });
  if (cursor) {
    query.set('cursor', cursor);
  } else {
    query.set('order', 'asc');
  }

  const baseUrl = server.config.url.replace(/\/+$/, '');
  const response = await fetch(
    `${baseUrl}/api/session/${encodeURIComponent(providerSessionId)}/message?${query.toString()}`,
    {
      headers: server.config.headers,
      signal: AbortSignal.timeout(V2_MESSAGES_TIMEOUT_MS),
    },
  );
  const body = readObjectRecord(await response.json().catch(() => null)) ?? {};
  if (!response.ok) {
    throw new Error(
      readOptionalString(readObjectRecord(body.data)?.message)
        ?? readOptionalString(body.message)
        ?? `HTTP ${response.status}`,
    );
  }

  return {
    rows: Array.isArray(body.data) ? body.data.map((value) => v2MessageToRow(value)) : [],
    nextCursor: readOptionalString(readObjectRecord(body.cursor)?.next) ?? null,
  };
}

/** Maps one 1.18 compatibility `{ info, parts }` entry into the row shape. */
function v1MessageToRow(value: unknown): OpenCodeMessageRow {
  const entry = readObjectRecord(value) ?? {};
  return {
    info: readObjectRecord(entry.info),
    parts: Array.isArray(entry.parts)
      ? entry.parts.map(readObjectRecord).filter((part): part is Record<string, unknown> => part !== null)
      : [],
  };
}

/**
 * Maps one v2 `SessionMessage` into the same `{ info, parts }` row shape the
 * 1.18 endpoint returns, so the normalizer has a single input.
 */
function v2MessageToRow(value: unknown): OpenCodeMessageRow {
  const message = readObjectRecord(value) ?? {};
  const id = readOptionalString(message.id) ?? generateMessageId('opencode');
  const time = readObjectRecord(message.time);
  const type = readOptionalString(message.type);

  if (type === 'user') {
    const parts: Record<string, unknown>[] = [];
    const text = readOptionalString(message.text);
    if (text !== undefined) {
      parts.push({ id: `${id}_text`, type: 'text', text });
    }
    return { info: { id, role: 'user', time }, parts };
  }

  if (type === 'assistant') {
    const content = Array.isArray(message.content) ? message.content : [];
    const parts = content
      .map((contentValue, index) => v2ContentToPart(contentValue, id, index))
      .filter((part): part is Record<string, unknown> => part !== null);
    return {
      info: { id, role: 'assistant', time, tokens: message.tokens, error: message.error },
      parts,
    };
  }

  return { info: { id, role: type, time }, parts: [] };
}

/** Maps one v2 assistant content block into a compatibility `part`. */
function v2ContentToPart(
  value: unknown,
  messageId: string,
  index: number,
): Record<string, unknown> | null {
  const content = readObjectRecord(value);
  if (!content) {
    return null;
  }

  const id = readOptionalString(content.id) ?? `${messageId}_${index}`;
  const type = readOptionalString(content.type);
  if (type === 'text') {
    return { id, type: 'text', text: readOptionalString(content.text) ?? '' };
  }
  if (type === 'reasoning') {
    return { id, type: 'reasoning', text: readOptionalString(content.text) ?? '' };
  }
  if (type === 'tool') {
    return {
      id,
      type: 'tool',
      tool: readOptionalString(content.name) ?? 'Tool',
      callID: id,
      state: mapV2ToolState(content.state),
    };
  }

  return null;
}

/**
 * Folds a v2 tool state's `content`/`error` into the compatibility
 * `output`/`error` fields the normalizer already understands.
 */
function mapV2ToolState(value: unknown): Record<string, unknown> {
  const state = readObjectRecord(value) ?? {};
  const status = readOptionalString(state.status) ?? 'pending';
  // `metadata` carries structured results, such as a question's answers; keep
  // it on the compatibility state so history normalization can read it.
  const base: Record<string, unknown> = {
    status,
    input: state.input ?? {},
    ...(state.metadata !== undefined ? { metadata: state.metadata } : {}),
  };
  if (status === 'completed') {
    return { ...base, output: v2ToolOutput(state.content) };
  }
  if (status === 'error') {
    const error = readObjectRecord(state.error);
    return { ...base, error: readOptionalString(error?.message) ?? 'Tool failed' };
  }
  return base;
}

/** Joins a v2 tool result's content blocks into plain text. */
function v2ToolOutput(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((value) => {
      const block = readObjectRecord(value) ?? {};
      const type = readOptionalString(block.type);
      if (type === 'text') {
        return readOptionalString(block.text) ?? '';
      }
      if (type === 'file') {
        return readOptionalString(block.uri) ?? '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
