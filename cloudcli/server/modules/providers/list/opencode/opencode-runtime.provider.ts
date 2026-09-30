import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { createOpenCodeServerClient } from '@/modules/providers/list/opencode/opencode-server.js';
import { appendFilesInputTag, appendImagesInputTag } from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimePermissionGateway,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

/**
 * One OpenCode turn this runtime started, keyed by the app session id.
 *
 * The client is captured so `abort` can interrupt the server-side run, and the
 * controller tears down this run's event subscription.
 */
type ActiveOpenCodeRun = {
  client: OpenCodeClient;
  providerSessionId: string;
  directory: string;
  controller: AbortController;
  aborted: boolean;
};

const activeOpenCodeRuns = new Map<string, ActiveOpenCodeRun>();

/**
 * One entry in a session permission ruleset; mirrors the SDK `PermissionRule`.
 */
type OpenCodePermissionRule = {
  permission: string;
  pattern: string;
  action: 'allow' | 'ask' | 'deny';
};

/**
 * Rule appended to a resumed session whose permission ruleset denies the
 * `question` tool. Appended last, it wins over the earlier deny rule.
 */
const OPENCODE_QUESTION_ALLOW_RULE: OpenCodePermissionRule = {
  permission: 'question',
  pattern: '*',
  action: 'allow',
};

/**
 * Rule that auto-approves file edits for the `acceptEdits` permission mode.
 */
const OPENCODE_EDIT_ALLOW_RULE: OpenCodePermissionRule = {
  permission: 'edit',
  pattern: '*',
  action: 'allow',
};

/**
 * Tool names OpenCode recognises in a permission ruleset.
 *
 * `bypassPermissions` allows every entry; this mirrors the CLI's `--auto`
 * flag now that CloudCLI writes the session ruleset over the SDK instead of
 * passing a command-line switch.
 */
const OPENCODE_PERMISSION_TOOLS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'doom_loop',
  'skill',
];

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function formatToolContent(value: unknown): string {
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
}

/**
 * Maps the UI permission mode onto an OpenCode session permission ruleset.
 *
 * - plan              → no ruleset; the prompt selects the read-only `plan`
 *                       agent instead.
 * - bypassPermissions → every known tool allowed, the SDK equivalent of the
 *                       CLI's `--auto`.
 * - acceptEdits       → file edits auto-approved, other tools under the user's
 *                       own config.
 * - default           → no ruleset; the user's config governs.
 *
 * Exported for the runtime's tests.
 */
export function resolveOpenCodePermissionRuleset(
  permissionMode: unknown,
): OpenCodePermissionRule[] | undefined {
  switch (permissionMode) {
    case 'bypassPermissions':
      return OPENCODE_PERMISSION_TOOLS.map((permission) => ({
        permission,
        pattern: '*',
        action: 'allow',
      }));
    case 'acceptEdits':
      return [OPENCODE_EDIT_ALLOW_RULE];
    default:
      return undefined;
  }
}

/**
 * Resolves the OpenCode reasoning-effort variant, validating it against the
 * selected model's allowed variants. Unknown models or efforts yield undefined
 * so the server keeps its own default.
 *
 * Exported for the runtime's tests.
 */
export function resolveOpenCodeEffort(
  model: string | undefined,
  effort: unknown,
  modelsDefinition: AnyRecord | undefined,
): string | undefined {
  const options = Array.isArray(modelsDefinition?.OPTIONS) ? modelsDefinition.OPTIONS : [];
  const selectedModel = readRecord(options.find((option) => readRecord(option)?.value === model));
  const effortDefinition = readRecord(selectedModel?.effort);
  const effortValues = Array.isArray(effortDefinition?.values)
    ? effortDefinition.values
      .map((value) => readRecord(value)?.value)
      .filter((value): value is string => typeof value === 'string')
    : [];

  return typeof effort === 'string' && effort !== 'default' && effortValues.includes(effort)
    ? effort
    : undefined;
}

/**
 * Reports whether a session's permission ruleset leaves the `question` tool
 * allowed. Rules evaluate last-match-wins, so only the final `question` rule
 * decides; an absent ruleset leaves every tool at its default (allowed).
 *
 * Exported for the runtime's tests.
 */
export function isOpenCodeQuestionAllowed(permission: unknown): boolean {
  const rules = Array.isArray(permission) ? permission : [];
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = readRecord(rules[index]);
    if (rule && rule.permission === 'question') {
      return rule.action === 'allow';
    }
  }

  return true;
}

/**
 * Splits a `provider/model` string into the OpenCode `{ providerID, modelID }`
 * pair. Returns null for an empty or unprefixed value.
 */
function parseOpenCodeModelRef(value: unknown): { providerID: string; modelID: string } | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null;
  }

  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

/**
 * Creates or repairs the OpenCode session a turn runs against.
 *
 * A brand-new session is created through the server so it never carries the
 * `question: deny` rule `opencode run` seeds. A resumed session gets an
 * explicit `question: allow` rule when its ruleset denies questions, plus the
 * turn's permission ruleset when the UI requested one.
 */
async function ensureOpenCodeRunSession(
  client: OpenCodeClient,
  directory: string,
  providerSessionId: string | null,
  title: string | undefined,
  permissionMode: unknown,
): Promise<string> {
  const permission = resolveOpenCodePermissionRuleset(permissionMode);

  if (!providerSessionId) {
    const created = await client.session.create({
      directory,
      ...(title ? { title } : {}),
      ...(permission ? { permission } : {}),
    });
    const sessionId = readString(readRecord(created.data)?.id);
    if (!sessionId) {
      throw new Error('OpenCode server did not return a session id.');
    }
    return sessionId;
  }

  try {
    const current = await client.session.get({ sessionID: providerSessionId, directory });
    const updateBody: AnyRecord = {};
    if (!isOpenCodeQuestionAllowed(readRecord(current.data)?.permission)) {
      updateBody.permission = [...(permission ?? []), OPENCODE_QUESTION_ALLOW_RULE];
    } else if (permission) {
      updateBody.permission = permission;
    }

    if (Object.keys(updateBody).length > 0) {
      await client.session.update({ sessionID: providerSessionId, directory, ...updateBody });
    }
  } catch (error) {
    // A session the server no longer knows about still gets a run attempt; the
    // prompt call will surface the real failure.
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[OpenCode] Unable to prepare session through the server:', message);
  }

  return providerSessionId;
}

/**
 * Reads the assistant message metadata the server streams while a turn runs and
 * folds it into the token budget shape the frontend renders.
 */
function buildOpenCodeTokenBudget(tokens: Record<string, unknown> | null): AnyRecord | null {
  if (!tokens) {
    return null;
  }

  const cache = readRecord(tokens.cache) ?? {};
  const inputTokens = Number(tokens.input ?? 0) + Number(cache.read ?? 0);
  const outputTokens = Number(tokens.output ?? 0);
  const used = Number(tokens.input ?? 0)
    + outputTokens
    + Number(tokens.reasoning ?? 0)
    + Number(cache.read ?? 0)
    + Number(cache.write ?? 0);
  if (used <= 0) {
    return null;
  }

  return {
    used,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

async function runOpenCodeSession(
  command: string,
  options: AnyRecord,
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    effort,
    sessionSummary,
    images,
    files,
    permissionMode,
  } = options ?? {};

  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const workingDir = (cwd || projectPath || process.cwd()) as string;
  // Process-map key: the app session id when the caller supplied one, so
  // abort-by-app-id always works.
  const processKey = (sessionId as string) || Date.now().toString();
  const client = createOpenCodeServerClient();
  const controller = new AbortController();

  let capturedSessionId: string | null = providerSessionId;
  let sessionCreatedSent = false;
  let completeSent = false;
  let terminalNotificationSent = false;
  let terminal = false;
  let tokenBudget: AnyRecord | null = null;
  let streamError: string | null = null;
  const seenTextLengths = new Map<string, number>();
  const toolStates = new Map<string, string>();

  const run: ActiveOpenCodeRun = {
    client,
    providerSessionId: providerSessionId ?? '',
    directory: workingDir,
    controller,
    aborted: false,
  };

  const finalSessionId = (): string => (sessionId as string) || capturedSessionId || processKey;

  const notifyTerminalState = ({ code = null, error = null }: { code?: number | null; error?: unknown } = {}) => {
    if (terminalNotificationSent) {
      return;
    }
    terminalNotificationSent = true;

    const notifySessionId = (sessionId as string) || capturedSessionId || processKey;
    if (code === 0 && !error) {
      notifyRunStopped({
        userId: ws?.userId ?? null,
        provider: 'opencode',
        sessionId: notifySessionId as never,
        sessionName: sessionSummary,
        stopReason: 'completed',
      });
      return;
    }

    notifyRunFailed({
      userId: ws?.userId ?? null,
      provider: 'opencode',
      sessionId: notifySessionId as never,
      sessionName: sessionSummary,
      error: error instanceof Error ? error.message : error || `OpenCode run exited with code ${code}`,
    });
  };

  const emit = (fields: AnyRecord): void => {
    ws.send(createNormalizedMessage({
      provider: 'opencode',
      sessionId: capturedSessionId || (sessionId as string) || null,
      ...fields,
    } as never));
  };

  const registerSession = (nextSessionId: string | null): void => {
    if (!nextSessionId || capturedSessionId === nextSessionId) {
      return;
    }

    capturedSessionId = nextSessionId;
    run.providerSessionId = nextSessionId;
    if (ws.setSessionId && typeof ws.setSessionId === 'function') {
      ws.setSessionId(nextSessionId);
    }

    if (!providerSessionId && !sessionCreatedSent) {
      sessionCreatedSent = true;
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: nextSessionId,
        sessionId: nextSessionId,
        provider: 'opencode',
      }));
    }
  };

  const handlePart = (part: Record<string, unknown>): void => {
    const partId = readString(part.id) ?? readString(part.callID);
    if (!partId) {
      return;
    }

    const type = readString(part.type);
    if (type === 'text' || type === 'reasoning') {
      const fullText = typeof part.text === 'string' ? part.text : '';
      const previous = seenTextLengths.get(partId) ?? 0;
      if (fullText.length <= previous) {
        seenTextLengths.set(partId, fullText.length);
        return;
      }

      const delta = fullText.slice(previous);
      seenTextLengths.set(partId, fullText.length);
      if (!delta) {
        return;
      }

      emit({
        id: partId,
        kind: type === 'reasoning' ? 'thinking' : 'stream_delta',
        content: delta,
      });
      return;
    }

    if (type === 'tool') {
      const state = readRecord(part.state) ?? {};
      const status = readString(state.status) ?? 'pending';
      if (toolStates.get(partId) === status) {
        return;
      }
      toolStates.set(partId, status);

      const toolMessage: AnyRecord = {
        id: partId,
        kind: 'tool_use',
        toolName: readString(part.tool) ?? 'Tool',
        toolInput: state.input ?? part.input ?? {},
        toolId: readString(part.callID) ?? partId,
      };

      if (status === 'completed' || status === 'error') {
        toolMessage.toolResult = {
          content: formatToolContent(state.output ?? state.error),
          isError: status === 'error',
        };
      }

      ws.send(createNormalizedMessage(toolMessage as never));
      return;
    }

    if (type === 'step-finish') {
      emit({ id: partId, kind: 'stream_end' });
    }
  };

  const handleAssistantMessage = (info: Record<string, unknown> | null): void => {
    if (!info || info.role !== 'assistant') {
      return;
    }

    const budget = buildOpenCodeTokenBudget(readRecord(info.tokens));
    if (budget) {
      tokenBudget = budget;
    }

    if (info.error != null && !streamError) {
      streamError = formatToolContent(info.error) || 'OpenCode run failed';
    }
  };

  /**
   * Handles one server event. Returns true when the event terminates the run.
   */
  const handleEvent = (rawEvent: unknown): boolean => {
    const event = readRecord(rawEvent);
    if (!event) {
      return false;
    }
    const payload = readRecord(event.payload) ?? event;
    const type = readString(payload.type);
    if (!type) {
      return false;
    }
    const properties = readRecord(payload.properties) ?? readRecord(payload.data) ?? {};
    const part = readRecord(properties.part);
    const eventSessionId = readString(properties.sessionID)
      ?? readString(properties.sessionId)
      ?? readString(part?.sessionID);
    if (eventSessionId && eventSessionId !== run.providerSessionId) {
      return false;
    }

    if (type === 'session.idle') {
      return true;
    }
    if (type === 'session.error') {
      const error = readRecord(properties.error);
      streamError = readString(error?.message)
        ?? readString(properties.message)
        ?? formatToolContent(properties.error)
        ?? 'OpenCode session error';
      return true;
    }
    if (type === 'message.updated') {
      handleAssistantMessage(readRecord(properties.info));
      return false;
    }
    if (type === 'message.part.updated' && part) {
      handlePart(part);
      return false;
    }

    return false;
  };

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId as string | undefined, model as string | undefined);
    let effortModels: AnyRecord | undefined;
    try {
      effortModels = await context.getProviderModels() as AnyRecord;
    } catch (error) {
      console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
    }
    const resolvedEffort = resolveOpenCodeEffort(resolvedModel, effort, effortModels);

    const runProviderSessionId = await ensureOpenCodeRunSession(
      client,
      workingDir,
      providerSessionId,
      sessionSummary as string | undefined,
      permissionMode,
    );
    run.providerSessionId = runProviderSessionId;
    registerSession(runProviderSessionId);
    activeOpenCodeRuns.set(processKey, run);

    // Subscribe before prompting so no streamed part is missed between the
    // prompt being admitted and the stream attaching.
    const { stream } = await client.event.subscribe(
      { directory: workingDir },
      { signal: controller.signal, sseMaxRetryAttempts: 1 },
    );

    const consumeEvents = (async () => {
      for await (const rawEvent of stream as AsyncGenerator<unknown>) {
        if (run.aborted) {
          break;
        }
        if (handleEvent(rawEvent)) {
          terminal = true;
          break;
        }
      }
    })();

    const promptText = appendFilesInputTag(
      appendImagesInputTag(command?.trim() || '', images),
      files,
    );
    const parts: AnyRecord[] = [];
    if (promptText.trim()) {
      parts.push({ type: 'text', text: promptText });
    }

    const promptBody: AnyRecord = {
      sessionID: runProviderSessionId,
      directory: workingDir,
      parts,
    };
    const modelRef = parseOpenCodeModelRef(resolvedModel);
    if (modelRef) {
      promptBody.model = modelRef;
    }
    if (resolvedEffort) {
      promptBody.variant = resolvedEffort;
    }
    if (permissionMode === 'plan') {
      promptBody.agent = 'plan';
    }

    await client.session.promptAsync(promptBody as never);
    await consumeEvents;

    if (run.aborted) {
      return;
    }

    if (streamError) {
      throw new Error(streamError);
    }

    // The session's own counters are authoritative; fall back to the tokens
    // streamed on the assistant message when the server does not report them.
    try {
      const session = await client.session.get({
        sessionID: runProviderSessionId,
        directory: workingDir,
      });
      tokenBudget = buildOpenCodeTokenBudget(readRecord(readRecord(session.data)?.tokens)) ?? tokenBudget;
    } catch {
      // Token usage is best-effort; a failed read must not fail the run.
    }

    if (run.aborted || controller.signal.aborted) {
      return;
    }

    if (tokenBudget) {
      ws.send(createNormalizedMessage({
        kind: 'status',
        text: 'token_budget',
        tokenBudget,
        sessionId: finalSessionId(),
        provider: 'opencode',
      }));
    }

    if (!completeSent) {
      completeSent = true;
      ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId(), exitCode: 0 }));
    }
    notifyTerminalState({ code: 0 });
  } catch (error) {
    if (run.aborted || controller.signal.aborted) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    if (!completeSent) {
      completeSent = true;
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: message,
        sessionId: finalSessionId(),
        provider: 'opencode',
      }));
      ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId(), exitCode: 1 }));
    }
    notifyTerminalState({ error: message });
    throw error instanceof Error ? error : new Error(message);
  } finally {
    activeOpenCodeRuns.delete(processKey);
  }
}

function abortOpenCodeSession(sessionId: string): boolean {
  const run = activeOpenCodeRuns.get(sessionId);
  if (!run) {
    return false;
  }

  run.aborted = true;
  run.controller.abort();
  void run.client.session
    .abort({ sessionID: run.providerSessionId, directory: run.directory })
    .catch(() => {
      // The local teardown already stopped the run; a failed server abort is
      // not worth surfacing.
    });
  activeOpenCodeRuns.delete(sessionId);
  return true;
}

/**
 * Installed interactive-approval gateway.
 *
 * The OpenCode bridge owns the live pending approvals and the SDK client that
 * answers them, but importing it here would create a providers <-> websocket
 * import cycle. The server entrypoint installs it instead; until then the facet
 * reports nothing pending and ignores decisions.
 */
let permissionGateway: ProviderRuntimePermissionGateway | null = null;

/**
 * Wires the OpenCode bridge's approval gateway into this runtime.
 *
 * Consumed by the server entrypoint, which is the only place that can see both
 * the bridge and the provider runtime.
 */
export function installOpenCodePermissionGateway(
  gateway: ProviderRuntimePermissionGateway | null,
): void {
  permissionGateway = gateway;
}

const permissions: ProviderRuntimePermissionGateway = {
  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    permissionGateway?.resolve(requestId, decision);
  },
  listPending(sessionId: string): unknown[] {
    return permissionGateway?.listPending(sessionId) ?? [];
  },
};

export const opencodeRuntime = {
  run: runOpenCodeSession,
  abort: abortOpenCodeSession,
  permissions,
};

export { runOpenCodeSession };
