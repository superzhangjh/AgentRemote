/**
 * OpenAI Codex App Server Integration
 * =============================
 *
 * This module runs Codex turns through the local app-server so the native
 * Codex client and CloudCLI share first-class threads and approval requests.
 *
 * ## Usage
 *
 * - codexRuntime.run(command, options, writer, context) - Execute a streamed turn
 * - codexRuntime.abort(sessionId) - Interrupt an active turn
 */

import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import {
  appendFilesInputTag,
  buildCodexInputItems,
  normalizeImageDescriptors,
  createCompleteMessage,
  createNormalizedMessage,
} from '@/shared/index.js';
import {
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';
import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/index.js';
import type { ProviderPermissionDecision } from '@/shared/types.js';

type ActiveCodexSession = {
  status: 'running' | 'aborted' | 'completed';
  abortController: AbortController;
  startedAt: string;
};

const activeCodexSessions = new Map<string, ActiveCodexSession>();
const pendingToolApprovals = new Map<string, {
  sessionId: string;
  toolName: string;
  input: unknown;
  receivedAt: Date;
  writer: ProviderRuntimeWriter;
  resolve: (decision: ProviderPermissionDecision) => void;
}>();

/**
 * Item types whose in-flight updates are worth showing. These are the ones a
 * user waits on — a shell command's output, an MCP call, and the running plan.
 */
const PROGRESSIVE_CODEX_ITEM_TYPES = new Set(['command_execution', 'mcp_tool_call', 'todo_list']);

function readUsageNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractCodexTokenBudget(event: AnyRecord) {
  const info = event?.info || event?.payload?.info || event?.usage?.info;
  const usage = info?.total_token_usage || event?.usage?.total_token_usage || event?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.output_tokens);
  const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    used,
    total: readUsageNumber(info?.model_context_window || event?.usage?.model_context_window) || 200000,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

function normalizeAppServerStatus(status: unknown): string | undefined {
  if (typeof status !== 'string') {
    return undefined;
  }
  return status === 'inProgress' ? 'in_progress' : status.toLowerCase();
}

function appServerItemToSdkItem(item: AnyRecord): AnyRecord {
  const mappedType: Record<string, string> = {
    agentMessage: 'agent_message',
    reasoning: 'reasoning',
    commandExecution: 'command_execution',
    fileChange: 'file_change',
    mcpToolCall: 'mcp_tool_call',
    webSearch: 'web_search',
    plan: 'todo_list',
  };
  const type = mappedType[item.type] || item.type;
  const mapped: AnyRecord = { ...item, type, id: item.id };

  if (type === 'reasoning') {
    mapped.text = typeof item.summary === 'string'
      ? item.summary
      : Array.isArray(item.content)
        ? item.content.map((part: AnyRecord) => typeof part?.text === 'string' ? part.text : '').join('')
        : '';
  }
  if (type === 'command_execution') {
    mapped.aggregated_output = item.aggregatedOutput;
    mapped.exit_code = item.exitCode;
  }
  if (type === 'file_change' && item.changes && !Array.isArray(item.changes)) {
    mapped.changes = Object.entries(item.changes).map(([filePath, change]) => ({
      ...(change as AnyRecord),
      path: (change as AnyRecord)?.path || filePath,
    }));
  }
  if (type === 'mcp_tool_call') {
    mapped.server = item.server;
    mapped.tool = item.tool;
  }
  if (type === 'todo_list' && item.type === 'plan') {
    mapped.items = typeof item.text === 'string'
      ? item.text.split(/\r?\n/).map((text) => ({ text, completed: false })).filter((entry) => entry.text.trim())
      : [];
  }

  mapped.status = normalizeAppServerStatus(item.status);
  return mapped;
}

function appServerNotificationToSdkEvent(message: AnyRecord): AnyRecord | null {
  const params = message.params && typeof message.params === 'object' ? message.params as AnyRecord : {};
  switch (message.method) {
    case 'turn/started':
      return { type: 'turn.started' };
    case 'turn/completed': {
      const turn = params.turn as AnyRecord | undefined;
      if (turn?.status === 'failed') {
        return { type: 'turn.failed', error: turn.error };
      }
      return { type: 'turn.completed', usage: turn?.tokenUsage };
    }
    case 'turn/failed':
      return { type: 'turn.failed', error: params.error };
    case 'item/started':
      return { type: 'item.started', item: appServerItemToSdkItem(params.item || {}) };
    case 'item/completed':
      return { type: 'item.completed', item: appServerItemToSdkItem(params.item || {}) };
    case 'turn/plan/updated':
      return {
        type: 'item.updated',
        item: {
          id: `codex-plan-${params.turnId || 'current'}`,
          type: 'todo_list',
          items: (Array.isArray(params.plan) ? params.plan : []).map((step: AnyRecord) => ({
            text: step.step,
            completed: step.status === 'completed',
          })),
        },
      };
    default:
      return null;
  }
}

function createPendingApproval(input: {
  sessionId: string;
  sessionSummary?: string;
  writer: ProviderRuntimeWriter;
  userId: string | number | null;
  toolName: string;
  details: unknown;
}): Promise<ProviderPermissionDecision> {
  const requestId = randomUUID();
  const receivedAt = new Date();

  let resolveDecision!: (decision: ProviderPermissionDecision) => void;
  const pending = new Promise<ProviderPermissionDecision>((resolve) => {
    resolveDecision = resolve;
  });
  pendingToolApprovals.set(requestId, {
      sessionId: input.sessionId,
      toolName: input.toolName,
      input: input.details,
      receivedAt,
      writer: input.writer,
      resolve: resolveDecision,
  });

  sendMessage(input.writer, createNormalizedMessage({
    kind: 'permission_request',
    requestId,
    toolName: input.toolName,
    input: input.details,
    sessionId: input.sessionId,
    provider: 'codex',
  }));
  notifyUserIfEnabled({
    userId: input.userId,
    event: {
      provider: 'codex',
      sessionId: input.sessionId,
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName: input.toolName, sessionName: input.sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `codex:permission:${input.sessionId}:${requestId}`,
      createdAt: new Date().toISOString(),
    },
  });

  return pending;
}

function resolveCodexApproval(requestId: string, decision: ProviderPermissionDecision): void {
  const pending = pendingToolApprovals.get(requestId);
  if (!pending) {
    return;
  }
  pendingToolApprovals.delete(requestId);
  sendMessage(pending.writer, createNormalizedMessage({
    kind: 'permission_resolved',
    requestId,
    sessionId: pending.sessionId,
    provider: 'codex',
  }));
  pending.resolve(decision);
}

function listPendingCodexApprovals(sessionId: string): unknown[] {
  return [...pendingToolApprovals.entries()]
    .filter(([, pending]) => pending.sessionId === sessionId)
    .map(([requestId, pending]) => ({
      requestId,
      toolName: pending.toolName,
      input: pending.input,
      sessionId: pending.sessionId,
      receivedAt: pending.receivedAt,
    }));
}

function cancelCodexApprovals(sessionId: string): void {
  for (const [requestId, pending] of pendingToolApprovals) {
    if (pending.sessionId !== sessionId) {
      continue;
    }
    pendingToolApprovals.delete(requestId);
    sendMessage(pending.writer, createNormalizedMessage({
      kind: 'permission_cancelled',
      requestId,
      sessionId,
      provider: 'codex',
    }));
    pending.resolve({ allow: false, message: 'Run cancelled' });
  }
}

async function handleCodexServerRequest(
  message: AnyRecord,
  input: {
    sessionId: string;
    sessionSummary?: string;
    writer: ProviderRuntimeWriter;
    userId: string | number | null;
  },
): Promise<unknown> {
  const params = message.params && typeof message.params === 'object' ? message.params as AnyRecord : {};
  const askUser = async (toolName: string, details: unknown): Promise<ProviderPermissionDecision> =>
    createPendingApproval({ ...input, toolName, details });

  switch (message.method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval': {
      const decision = await askUser('Bash', {
        command: params.command || '',
        cwd: params.cwd || '',
        reason: params.reason,
      });
      const remember = Boolean(decision.rememberEntry);
      return {
        decision: message.method === 'execCommandApproval'
          ? decision.allow ? (remember ? 'approved_for_session' : 'approved') : 'abort'
          : decision.allow ? (remember ? 'acceptForSession' : 'accept') : 'decline',
      };
    }
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval': {
      const decision = await askUser('Edit', {
        file_path: params.grantRoot || '',
        reason: params.reason,
        fileChanges: params.fileChanges,
      });
      return {
        decision: message.method === 'applyPatchApproval'
          ? decision.allow ? 'approved' : 'abort'
          : decision.allow ? (decision.rememberEntry ? 'acceptForSession' : 'accept') : 'decline',
      };
    }
    case 'item/tool/requestUserInput': {
      const decision = await askUser('AskUserQuestion', { questions: params.questions || [] });
      const updatedInput = decision.updatedInput && typeof decision.updatedInput === 'object'
        ? decision.updatedInput as AnyRecord
        : {};
      return { answers: decision.allow ? updatedInput.answers || {} : {} };
    }
    case 'item/permissions/requestApproval': {
      const decision = await askUser('RequestPermissions', {
        permissions: params.permissions,
        reason: params.reason,
        cwd: params.cwd,
      });
      return {
        permissions: decision.allow ? params.permissions || {} : {},
        scope: decision.rememberEntry ? 'session' : 'turn',
      };
    }
    case 'mcpServer/elicitation/request':
      return { action: 'decline' };
    default:
      return {};
  }
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event: AnyRecord): AnyRecord {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // `itemId` is the SDK's stable per-item id. Carrying it through means an
      // in-progress row and its later completion normalize to the same message
      // id, so the client updates one transcript entry instead of appending a
      // new one for every progress tick.
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            itemId: item.id,
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            itemId: item.id,
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            itemId: item.id,
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            itemId: item.id,
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            itemId: item.id,
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            itemId: item.id,
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            itemId: item.id,
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            itemId: item.id,
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            itemId: item.id,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id || event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to the app-server thread and turn settings.
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode: string): {
  sandboxMode: 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'on-request' | 'never';
} {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        // Keep workspace writes sandboxed and route any required approval to
        // the connected CloudCLI client.
        approvalPolicy: 'on-request'
      };
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
async function queryCodex(
  command: string,
  options: AnyRecord = {},
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    images,
    files,
    permissionMode = 'default'
  } = options;

  // Callers pass the stable app session id; the SDK resumes threads with the
  // provider-native id recorded on the session row.
  let providerSessionId = context.resolveProviderSessionId(sessionId);

  // Sessions discovered from Codex itself use their native thread id as the
  // app id. Fork those before the first CloudCLI write so an open Codex window
  // and the phone never compete for the same thread writer or append into one
  // another's transcript.
  if (sessionId && providerSessionId === sessionId) {
    const importedSession = sessionsDb.getSessionById(sessionId);
    if (
      importedSession?.provider === 'codex'
      && importedSession.provider_session_id === sessionId
      && importedSession.jsonl_path
    ) {
      const fork = await codexAppServer.forkThread({
        threadId: sessionId,
        cwd: importedSession.project_path || options.projectPath || process.cwd(),
      });
      sessionsDb.repointSessionToProviderSession(sessionId, {
        providerSessionId: fork.threadId,
        jsonlPath: fork.path,
      });
      providerSessionId = fork.threadId;
      ws.setSessionId?.(fork.threadId);
    }
  }

  const resolvedModel = await context.resolveResumeModel(sessionId, model);

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const catalog = await context.getProviderModels();
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;

  // Provider-native thread id (starts as the resume id, or is returned by
  // thread/start for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  let terminalFailure: Error | null = null;
  let errorSurfaced = false;
  const abortController = new AbortController();
  const activeRun: ActiveCodexSession = {
    status: 'running',
    abortController,
    startedAt: new Date().toISOString(),
  };
  // Session-map key: the app session id when the caller supplied one, else
  // the provider-native thread id once captured.
  const sessionKey = () => sessionId || capturedSessionId || null;
  const registerSession = (id: string | null) => {
    if (id) {
      activeCodexSessions.set(id, activeRun);
    }
  };
  registerSession(sessionKey());

  const rememberThread = (thread: { id: string; path?: string }) => {
    capturedSessionId = thread.id;
    registerSession(sessionKey());
    ws.setSessionId?.(thread.id);
    if (sessionId && thread.path) {
      sessionsDb.repointSessionToProviderSession(sessionId, {
        providerSessionId: thread.id,
        jsonlPath: thread.path,
      });
    }
    if (!providerSessionId && !sessionCreatedSent) {
      sessionCreatedSent = true;
      sendMessage(ws, createNormalizedMessage({
        kind: 'session_created',
        newSessionId: thread.id,
        sessionId: thread.id,
        provider: 'codex',
      }));
    }
  };

  const processEvent = (event: AnyRecord) => {
    if (
      (event.type === 'item.started' || event.type === 'item.updated')
      && !PROGRESSIVE_CODEX_ITEM_TYPES.has(event.item?.type)
    ) {
      return;
    }

    const transformed = transformCodexEvent(event);
    if (transformed.type === 'error' || transformed.itemType === 'error') {
      errorSurfaced = true;
    }
    for (const message of context.normalizeMessage(transformed, capturedSessionId || sessionId || null)) {
      sendMessage(ws, message);
    }

    if (event.type === 'turn.failed' && !terminalFailure) {
      const reason = event.error?.message || event.error || 'Turn failed';
      terminalFailure = new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
      errorSurfaced = true;
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'codex',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        error: terminalFailure,
      });
    }

    if (event.type === 'turn.completed') {
      const tokenBudget = extractCodexTokenBudget(event);
      if (tokenBudget) {
        sendMessage(ws, createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'codex',
        }));
      }
    }
  };

  const commandOutputs = new Map<string, string>();
  const commandNames = new Map<string, string>();
  const onNotification = (message: AnyRecord) => {
    const params = message.params && typeof message.params === 'object' ? message.params as AnyRecord : {};
    if (abortController.signal.aborted) {
      return;
    }

    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      sendMessage(ws, createNormalizedMessage({
        kind: 'stream_delta',
        content: params.delta,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
      }));
      return;
    }

    if (message.method === 'item/commandExecution/outputDelta' && typeof params.itemId === 'string') {
      const itemId = params.itemId;
      const output = `${commandOutputs.get(itemId) || ''}${String(params.delta || '')}`;
      commandOutputs.set(itemId, output);
      processEvent({
        type: 'item.updated',
        item: {
          id: itemId,
          type: 'command_execution',
          command: commandNames.get(itemId) || '',
          aggregated_output: output,
          status: 'in_progress',
        },
      });
      return;
    }

    if (message.method === 'thread/tokenUsage/updated') {
      const tokenUsage = params.tokenUsage as AnyRecord | undefined;
      const last = tokenUsage?.last as AnyRecord | undefined;
      const total = tokenUsage?.total as AnyRecord | undefined;
      const tokenBudget = extractCodexTokenBudget({
        usage: {
          total_token_usage: {
            input_tokens: last?.inputTokens,
            output_tokens: last?.outputTokens,
            total_tokens: total?.totalTokens,
          },
          model_context_window: tokenUsage?.modelContextWindow,
        },
      });
      if (tokenBudget) {
        sendMessage(ws, createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'codex',
        }));
      }
      return;
    }

    if (message.method === 'item/started' && params.item?.type === 'commandExecution') {
      const itemId = typeof params.item.id === 'string' ? params.item.id : '';
      if (itemId) {
        commandNames.set(itemId, String(params.item.command || ''));
        commandOutputs.set(itemId, String(params.item.aggregatedOutput || ''));
      }
    }

    const event = appServerNotificationToSdkEvent(message);
    if (event) {
      processEvent(event);
    }

    if (message.method === 'item/completed' && typeof params.item?.id === 'string') {
      commandOutputs.delete(params.item.id);
      commandNames.delete(params.item.id);
    }
  };

  try {
    const promptWithFiles = appendFilesInputTag(command, files);
    const sdkInput: Array<{ type: string; text?: string; path?: string }> = normalizeImageDescriptors(images).length > 0
      ? buildCodexInputItems(promptWithFiles, images, workingDirectory)
      : [{ type: 'text', text: promptWithFiles }];
    const turnInput = sdkInput.map((item) => item.type === 'local_image'
      ? { type: 'localImage', path: item.path }
      : { type: 'text', text: item.text || '', text_elements: [] });

    await codexAppServer.runTurn({
      threadId: providerSessionId,
      cwd: workingDirectory,
      model: resolvedModel,
      effort: resolvedEffort,
      sandboxMode,
      approvalPolicy,
      turnInput,
      signal: abortController.signal,
      onThread: rememberThread,
      onNotification,
      onServerRequest: (message) => handleCodexServerRequest(message, {
        sessionId: sessionKey() || capturedSessionId || '',
        sessionSummary,
        writer: ws,
        userId: ws?.userId || null,
      }),
    });

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runSession = activeCodexSessions.get(sessionKey() || '');
    const runAborted = runSession?.status === 'aborted' || abortController.signal.aborted;
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || sessionId || null,
        exitCode: terminalFailure ? 1 : 0,
      }));
      if (!terminalFailure) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed'
        });
      }
    }

  } catch (error) {
    const session = activeCodexSessions.get(sessionKey() || '');
    const runError = error instanceof Error ? error : new Error(String(error));
    const wasAborted =
      session?.status === 'aborted' ||
      runError.name === 'AbortError' ||
      runError.message.toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      if (!errorSurfaced) {
        // Check if Codex SDK is available for a clearer error message
        const installed = await context.isProviderInstalled();
        const errorContent = !installed
          ? 'Codex CLI is not configured. Please set up authentication first.'
          : runError.message;

        sendMessage(ws, createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
      }
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: 1,
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error
        });
      }
    }

  } finally {
    cancelCodexApprovals(sessionKey() || '');
    // Update session status
    if (sessionKey()) {
      const session = activeCodexSessions.get(sessionKey() || '');
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
function abortCodexSession(sessionId: string) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  cancelCodexApprovals(sessionId);
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/** Used by the providers module's CodexProvider to run, abort, and approve turns. */
export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
  permissions: {
    resolve: resolveCodexApproval,
    listPending: listPendingCodexApprovals,
  },
};

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws: ProviderRuntimeWriter, data: unknown) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
const completedSessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

// Runtime cleanup should not keep focused tests or one-off scripts alive after
// their provider work has completed.
completedSessionCleanupTimer.unref?.();
