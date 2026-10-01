import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import { sessionsDb, userDb } from '@/modules/database/index.js';
import {
  notifyPermissionRequired,
  notifyQuestionRequired,
  notifyRunStopped,
  sendDesktopTaskProgress,
} from '@/modules/notifications/index.js';
import { chatRunRegistry, connectedClients, setExternalSessionActivity, WS_OPEN_STATE } from '@/modules/websocket/index.js';
import type {
  LLMProvider,
  OpenCodeServerConfig,
  ProviderPermissionDecision,
  ProviderRuntimePermissionGateway,
} from '@/shared/types.js';
import { createNormalizedMessage, resolveOpenCodeServerConfigs } from '@/shared/utils.js';

const PROVIDER: LLMProvider = 'opencode';
const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;
/** How often a live stream re-reads the active set to heal missed idle events. */
const STATUS_RECONCILE_INTERVAL_MS = 30_000;
const MAX_TRACKED_IDS = 500;

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

type OpenCodeEventShape = {
  type?: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
  directory?: string;
  /** v2 events carry the project directory under `location`. */
  location?: Record<string, unknown>;
  payload?: OpenCodeEventShape;
};

/**
 * A question option in the shape the transcript's question panel renders.
 *
 * OpenCode's own option type is identical; the panel is shared with Claude, so
 * the question is re-emitted as an `AskUserQuestion` permission request.
 */
type OpenCodeQuestionOption = {
  label: string;
  description: string;
};

/** One question, normalized to the frontend `Question` shape (`multiple` → `multiSelect`). */
type OpenCodeQuestion = {
  question: string;
  header: string;
  options: OpenCodeQuestionOption[];
  multiSelect: boolean;
};

/** One selectable option of an OpenCode v2 form field. */
type OpenCodeFormOption = {
  value?: string;
  label?: string;
  description?: string;
};

/**
 * One field of an OpenCode v2 form.
 *
 * Desktop servers (2.0+) implement the `question` tool as a form whose
 * metadata is marked `kind: "question"`; each question becomes a `multiselect`
 * (multi-select) or `string` (single-select) field, with `custom` enabled so
 * the phone's free-form "Other" answer stays valid.
 */
type OpenCodeFormField = {
  key?: string;
  title?: string;
  description?: string;
  type?: string;
  options?: OpenCodeFormOption[];
  custom?: boolean;
};

/** A pending OpenCode v2 form, shaped after the server's `Form.Info`. */
type OpenCodeForm = {
  id?: string;
  sessionID?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  fields?: OpenCodeFormField[];
};

/**
 * One OpenCode server the bridge mirrors.
 *
 * Several can run at once — the console-managed `opencode serve` plus each
 * desktop app's background service — so every server keeps its own client and
 * event loop. The v2 API is used everywhere because both 1.18 and 2.0 expose it.
 */
type OpenCodeServer = {
  config: OpenCodeServerConfig;
  client: OpenCodeClient;
};

let servers: OpenCodeServer[] = [];
let bridgeAbortController: AbortController | null = null;
let started = false;
/** Provider-native ids each server reports active, so one server's snapshot cannot clear another's. */
const activeProviderSessionsByServer = new Map<string, Set<string>>();
/** Provider-native ids the last snapshot (or event) reported as busy. */
const busyProviderSessions = new Set<string>();
/** Permission ids already announced, so one approval prompt notifies once. */
const announcedPermissions = new Set<string>();
/** Directories seen in global events, including sessions not indexed yet. */
const sessionDirectories = new Map<string, string>();
/** Prevents a double tap while retaining the prompt until the server accepts it. */
const resolvingInteractions = new Set<string>();

/**
 * Request ids the bridge has already answered.
 *
 * A reconnect snapshot can list a request that was answered while that snapshot
 * was in flight. Skipping these ids stops an already-answered prompt from
 * reappearing on the phone; the server drops it from its own list shortly after.
 */
const resolvedInteractions = new Set<string>();

/**
 * One unanswered approval prompt raised by the OpenCode server.
 *
 * The provider-native session id is kept alongside the app-facing id because
 * answering the prompt is a server call keyed by the native id, while the UI
 * only ever addresses the app id.
 */
type OpenCodePendingPermission = {
  permissionId: string;
  sessionId: string;
  directory?: string;
  appSessionId: string;
  /** URL of the server that raised the prompt, so the reply goes back to it. */
  serverUrl: string;
  toolName: string;
  input: unknown;
  context: unknown;
  receivedAt: Date;
};

/**
 * Pending approvals keyed by OpenCode permission id.
 *
 * This is what lets an approval raised on the Mac (or by a desktop client) be
 * answered from the phone: `listPending` feeds the chat subscribe payload and
 * `resolve` posts the decision back through the SDK client below.
 */
const pendingPermissions = new Map<string, OpenCodePendingPermission>();

/** A question the assistant asked and is waiting for the user to answer. */
type OpenCodePendingQuestion = {
  requestId: string;
  sessionId: string;
  directory?: string;
  appSessionId: string;
  /** URL of the server that raised the question, so the reply goes back to it. */
  serverUrl: string;
  questions: OpenCodeQuestion[];
  /**
   * Set when the question arrived as a v2 form (OpenCode 2.0+ desktop servers).
   * Those requests are answered through the form API instead of the legacy
   * question endpoints, and carry the field keys the answers must use.
   */
  form: OpenCodeForm | null;
  receivedAt: Date;
};

/**
 * Pending questions keyed by OpenCode question-request id.
 *
 * Surfaced through the same pending-permission channel as approvals, rendered
 * by the shared `AskUserQuestion` panel, and answered through the v2 client.
 */
const pendingQuestions = new Map<string, OpenCodePendingQuestion>();

function rememberId(store: Set<string>, id: string): boolean {
  if (!id || store.has(id)) {
    return false;
  }

  store.add(id);
  if (store.size > MAX_TRACKED_IDS) {
    const oldest = store.values().next().value;
    if (oldest) {
      store.delete(oldest);
    }
  }

  return true;
}

/**
 * Every OpenCode server CloudCLI should mirror.
 *
 * Exported for the module's tests; the discovery itself lives in shared utils
 * so the bridge and the provider readers agree on the same server set.
 */
export function resolveServerConfigs(): OpenCodeServerConfig[] {
  return resolveOpenCodeServerConfigs();
}

/** The primary server, used by callers that mirror a single instance. */
export function resolveServerConfig(): OpenCodeServerConfig {
  return resolveOpenCodeServerConfigs()[0];
}

/** Maps a provider-native session id onto the app-facing id CloudCLI stores. */
function resolveAppSessionId(providerSessionId: string): string {
  const row = sessionsDb.getSessionByProviderSessionId(providerSessionId, PROVIDER);
  return row?.session_id ?? providerSessionId;
}

function resolveSessionDirectory(providerSessionId: string, directory?: string): string | undefined {
  return directory ?? sessionDirectories.get(providerSessionId)
    ?? sessionsDb.getSessionByProviderSessionId(providerSessionId, PROVIDER)?.project_path ?? undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Marks one provider-native session busy/idle and mirrors it to every client. */
function applySessionActivity(providerSessionId: string, isBusy: boolean): void {
  const wasBusy = busyProviderSessions.has(providerSessionId);
  if (isBusy) {
    busyProviderSessions.add(providerSessionId);
  } else {
    busyProviderSessions.delete(providerSessionId);
  }

  const appSessionId = resolveAppSessionId(providerSessionId);
  const phase = getBusySessionPhase(providerSessionId);
  // The phone's ongoing task notification only tracks CloudCLI-owned runs, so
  // an externally-started OpenCode turn is invisible there unless the bridge
  // reports it too. Only on the transition, to avoid re-sending every status frame.
  if (wasBusy !== isBusy) {
    sendSessionTaskProgress(appSessionId, isBusy ? 'running' : 'finished', isBusy ? phase : '');
  }

  if (wasBusy && !isBusy) {
    notifyExternalRunCompleted(appSessionId, providerSessionId);
  }

  if (!isBusy) {
    clearPendingInteractionsForSession(providerSessionId);
  }

  setExternalSessionActivity(appSessionId, PROVIDER, isBusy, isBusy ? phase : null);
}

/** True while a session is still waiting on an approval or a question. */
function hasPendingInteraction(providerSessionId: string): boolean {
  return Array.from(pendingPermissions.values()).some((entry) => entry.sessionId === providerSessionId)
    || Array.from(pendingQuestions.values()).some((entry) => entry.sessionId === providerSessionId);
}

/**
 * Pops the phone's "task completed" alert when an OpenCode turn finishes.
 *
 * A turn whose session sits in the chat-run registry is one CloudCLI started;
 * its provider runtime already raises the same `run.stopped` alert, and the
 * registry keeps the entry for a while after completion, so those are skipped
 * rather than relying on the orchestrator's short dedupe window. A session
 * still waiting on an approval or question has not finished either, so it is
 * skipped too — the interaction alert covers that case.
 */
function notifyExternalRunCompleted(appSessionId: string, providerSessionId: string): void {
  if (chatRunRegistry.getRun(appSessionId) || hasPendingInteraction(providerSessionId)) {
    return;
  }

  notifyRunStopped({
    userId: resolveNotificationUserId(),
    provider: PROVIDER,
    // The orchestrator's JavaScript signature under-types these two string
    // fields as `null`; the provider runtimes cast them the same way.
    sessionId: appSessionId as never,
    sessionName: sessionsDb.getSessionName(appSessionId, PROVIDER) as never,
    stopReason: 'completed',
  });
}

/**
 * Pending interactions take precedence over ordinary busy status frames.
 */
function getBusySessionPhase(providerSessionId: string): string {
  if (Array.from(pendingQuestions.values()).some((entry) => entry.sessionId === providerSessionId)) {
    return '等待回答';
  }
  return Array.from(pendingPermissions.values()).some((entry) => entry.sessionId === providerSessionId)
    ? '等待审批' : '正在处理任务';
}

/** Returns the first user id so external-provider notifications have a recipient. */
function resolveNotificationUserId(): number | null {
  const user = userDb.getFirstUser();
  return typeof user?.id === 'number' ? user.id : null;
}

/**
 * Mirrors an externally-owned OpenCode run into the phone's foreground task
 * notification, which otherwise only hears about CloudCLI-owned runs.
 */
function sendSessionTaskProgress(
  appSessionId: string,
  state: 'running' | 'finished',
  detail: string,
): void {
  const userId = resolveNotificationUserId();
  if (!userId) {
    return;
  }

  sendDesktopTaskProgress(userId, {
    sessionId: appSessionId,
    provider: PROVIDER,
    title: sessionsDb.getSessionName(appSessionId, PROVIDER) || 'Agent 任务',
    detail,
    steps: 0,
    state,
  });
}

/** Sends one normalized event to every open chat socket. */
function broadcastChatEvent(event: ReturnType<typeof createNormalizedMessage>): void {
  const payload = JSON.stringify(event);
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

/**
 * Drops a session's pending approvals/questions and tells watchers to retract them.
 *
 * Called when the server reports the session idle: an interaction cannot outlive
 * the turn that raised it, so any entry still held here is stale.
 */
function clearPendingInteractionsForSession(providerSessionId: string): void {
  for (const [permissionId, entry] of pendingPermissions.entries()) {
    if (entry.sessionId !== providerSessionId) {
      continue;
    }

    pendingPermissions.delete(permissionId);
    broadcastChatEvent(createNormalizedMessage({
      kind: 'permission_cancelled',
      provider: PROVIDER,
      sessionId: entry.appSessionId,
      requestId: permissionId,
    }));
  }

  for (const [requestId, entry] of pendingQuestions.entries()) {
    if (entry.sessionId !== providerSessionId) {
      continue;
    }

    pendingQuestions.delete(requestId);
    broadcastChatEvent(createNormalizedMessage({
      kind: 'permission_cancelled',
      provider: PROVIDER,
      sessionId: entry.appSessionId,
      requestId,
    }));
  }
}

/** Converts raw OpenCode question info into the transcript panel's `Question` shape. */
function normalizeOpenCodeQuestions(raw: unknown): OpenCodeQuestion[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const questions: OpenCodeQuestion[] = [];
  for (const entry of raw) {
    const record = readRecord(entry);
    const question = readString(record?.question);
    if (!question) {
      continue;
    }

    const options: OpenCodeQuestionOption[] = [];
    if (Array.isArray(record?.options)) {
      for (const option of record.options) {
        const optionRecord = readRecord(option);
        const label = readString(optionRecord?.label);
        if (!label) {
          continue;
        }
        options.push({ label, description: readString(optionRecord?.description) ?? '' });
      }
    }

    questions.push({
      question,
      header: readString(record?.header) ?? '',
      options,
      // OpenCode calls it `multiple`; the shared panel calls it `multiSelect`.
      multiSelect: record?.multiple === true,
    });
  }

  return questions;
}

/** The text the phone panel keys an answer by: the question it displays. */
function questionTextForFormField(field: OpenCodeFormField, form: OpenCodeForm): string {
  return field.description ?? field.title ?? form.title ?? '';
}

/** Converts an OpenCode v2 form into the shared question panel's shape. */
function normalizeOpenCodeFormQuestions(form: OpenCodeForm): OpenCodeQuestion[] {
  const questions: OpenCodeQuestion[] = [];
  for (const field of form.fields ?? []) {
    // External fields are browser hand-offs, not questions.
    if (field.type === 'external') {
      continue;
    }

    const question = questionTextForFormField(field, form).trim();
    if (!question) {
      continue;
    }

    const options: OpenCodeQuestionOption[] = [];
    for (const option of field.options ?? []) {
      const label = option.label ?? option.value;
      if (label) {
        options.push({ label, description: option.description ?? '' });
      }
    }

    questions.push({
      question,
      header: field.title ?? form.title ?? '',
      options,
      multiSelect: field.type === 'multiselect',
    });
  }

  return questions;
}

/** Reads one v2 form payload defensively; the event stream is untrusted input. */
function readOpenCodeForm(value: unknown): OpenCodeForm | null {
  const record = readRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const sessionID = readString(record.sessionID);
  if (!id || !sessionID) {
    return null;
  }

  const fields: OpenCodeFormField[] = [];
  if (Array.isArray(record.fields)) {
    for (const entry of record.fields) {
      const field = readRecord(entry);
      if (!field) {
        continue;
      }

      const options: OpenCodeFormOption[] = [];
      if (Array.isArray(field.options)) {
        for (const option of field.options) {
          const optionRecord = readRecord(option);
          if (!optionRecord) {
            continue;
          }
          options.push({
            value: readString(optionRecord.value) ?? undefined,
            label: readString(optionRecord.label) ?? undefined,
            description: readString(optionRecord.description) ?? undefined,
          });
        }
      }

      fields.push({
        key: readString(field.key) ?? undefined,
        title: readString(field.title) ?? undefined,
        description: readString(field.description) ?? undefined,
        type: readString(field.type) ?? undefined,
        options,
        custom: field.custom === true,
      });
    }
  }

  return {
    id,
    sessionID,
    title: readString(record.title) ?? undefined,
    metadata: readRecord(record.metadata) ?? undefined,
    fields,
  };
}

/** Registers live and recovered approvals through the same phone delivery path. */
function registerPendingPermission(
  properties: Record<string, unknown>,
  directory: string | undefined,
  serverUrl: string,
): void {
  const permissionId = readString(properties.id);
  const sessionId = readString(properties.sessionID) ?? readString(properties.sessionId);
  if (!permissionId || !sessionId || pendingPermissions.has(permissionId)
    || resolvedInteractions.has(permissionId)) {
    return;
  }

  const appSessionId = resolveAppSessionId(sessionId);
  const entry: OpenCodePendingPermission = {
    permissionId,
    sessionId,
    directory: resolveSessionDirectory(sessionId, directory),
    appSessionId,
    serverUrl,
    toolName: readString(properties.title) ?? readString(properties.permission)
      ?? readString(properties.action) ?? readString(properties.type) ?? 'Tool',
    input: readRecord(properties.metadata) ?? undefined,
    context: properties.pattern ?? properties.patterns ?? properties.resources,
    receivedAt: new Date(),
  };
  pendingPermissions.set(permissionId, entry);
  if (rememberId(announcedPermissions, permissionId)) {
    notifyUserOfPermission(sessionId, entry.toolName);
  }
  applySessionActivity(sessionId, true);
  sendSessionTaskProgress(appSessionId, 'running', '等待审批');
  broadcastPendingPermission(entry);
}

function broadcastPendingPermission(entry: OpenCodePendingPermission): void {
  broadcastChatEvent(createNormalizedMessage({
    kind: 'permission_request',
    provider: PROVIDER,
    sessionId: entry.appSessionId,
    requestId: entry.permissionId,
    toolName: entry.toolName,
    input: entry.input,
    context: entry.context,
    canInterrupt: false,
  }));
}

function broadcastPendingQuestion(entry: OpenCodePendingQuestion): void {
  broadcastChatEvent(createNormalizedMessage({
    kind: 'permission_request',
    provider: PROVIDER,
    sessionId: entry.appSessionId,
    requestId: entry.requestId,
    toolName: 'AskUserQuestion',
    input: { questions: entry.questions },
    canInterrupt: false,
  }));
}

/**
 * Registers a pending question and pushes it to every watching client as an
 * `AskUserQuestion` permission request, so the shared question panel renders it.
 *
 * `form` is set for questions OpenCode 2.0+ raised as forms; the reply then
 * goes back through the form endpoints, keyed by each field's `key`.
 */
function registerPendingQuestion(
  requestId: string,
  sessionId: string,
  questions: OpenCodeQuestion[],
  serverUrl: string,
  directory?: string,
  form: OpenCodeForm | null = null,
): void {
  if (!requestId || questions.length === 0 || pendingQuestions.has(requestId)
    || resolvedInteractions.has(requestId)) {
    return;
  }

  const appSessionId = resolveAppSessionId(sessionId);
  const entry: OpenCodePendingQuestion = {
    requestId,
    sessionId,
    directory: resolveSessionDirectory(sessionId, directory),
    appSessionId,
    serverUrl,
    questions,
    form,
    receivedAt: new Date(),
  };
  pendingQuestions.set(requestId, entry);

  notifyUserOfQuestion(sessionId, questions[0]?.question ?? null);
  applySessionActivity(sessionId, true);
  sendSessionTaskProgress(appSessionId, 'running', '等待回答');
  broadcastPendingQuestion(entry);
}

/**
 * Registers a v2 form the assistant is waiting on.
 *
 * Desktop servers (2.0+) implement the `question` tool as a form whose metadata
 * is marked `kind: "question"`. Other forms (MCP elicitation, for one) are not
 * questions and stay out of the approvals channel.
 */
function registerPendingForm(
  rawForm: unknown,
  sessionId: string,
  serverUrl: string,
  directory?: string,
): void {
  const form = readOpenCodeForm(rawForm);
  if (!form || readRecord(form.metadata)?.kind !== 'question') {
    return;
  }

  registerPendingQuestion(
    form.id ?? '',
    form.sessionID ?? sessionId,
    normalizeOpenCodeFormQuestions(form),
    serverUrl,
    directory,
    form,
  );
}

/**
 * Reconciles pending questions for one session against the server's list.
 *
 * The event stream does not always carry a usable request id, so a running
 * `question` tool part causes one list call; the request whose `tool.callID`
 * matches the part is the one being rendered.
 */
async function reconcilePendingQuestions(
  sessionId: string,
  callId: string | null,
  directory: string | undefined,
  server: OpenCodeServer,
): Promise<void> {
  // The part can become `running` a beat before the server registers the
  // request, so retry briefly instead of giving up on the first empty list.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await server.client.v2.question.request.list(
        { location: { directory } },
        { throwOnError: true },
      );
      const requests = readRequestList(result.data);
      let registered = false;
      for (const request of requests) {
        const requestId = readString(request?.id);
        if (!requestId || pendingQuestions.has(requestId)) {
          continue;
        }
        if (request.sessionID !== sessionId) {
          continue;
        }
        if (callId && readString(readRecord(request.tool)?.callID) !== callId) {
          continue;
        }
        registerPendingQuestion(
          requestId,
          sessionId,
          normalizeOpenCodeQuestions(request?.questions),
          server.config.url,
          directory,
        );
        registered = true;
      }
      if (registered) {
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[OpenCodeBridge] Failed to list pending questions:', message);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/**
 * True while the server still reports the session as running.
 *
 * The local busy set only refreshes every 30 seconds, so checking it alone
 * would pin a task spinner for a session nothing is running — a synthetic
 * approval, or a run that already ended. An unreachable server keeps the
 * previous busy state rather than dropping a real prompt's indicator.
 */
async function isProviderSessionActive(server: OpenCodeServer, sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`${server.config.url}/api/session/active`, {
      headers: server.config.headers,
    });
    if (!response.ok) {
      return true;
    }

    const body: unknown = await response.json();
    // The API wraps its map once (`{ data: { <sessionId>: ... } }`).
    const active = readRecord(readRecord(body)?.data);
    return active ? Object.prototype.hasOwnProperty.call(active, sessionId) : true;
  } catch {
    return true;
  }
}

/**
 * Tells watchers an interaction ended and restores the run's progress label.
 *
 * When the settling server no longer reports the session as running, this
 * releases the activity immediately instead of waiting for the next snapshot:
 * the phone's poll then clears its spinner within a few seconds.
 */
function broadcastInteractionSettled(
  appSessionId: string,
  sessionId: string,
  requestId: string,
  kind: 'permission_resolved' | 'permission_cancelled',
  serverUrl?: string,
): void {
  broadcastChatEvent(createNormalizedMessage({
    kind,
    provider: PROVIDER,
    sessionId: appSessionId,
    requestId,
  }));

  if (!busyProviderSessions.has(sessionId)) {
    return;
  }

  const server = serverUrl ? findServer(serverUrl) : null;
  if (!server) {
    applySessionActivity(sessionId, true);
    return;
  }

  void isProviderSessionActive(server, sessionId).then((active) => {
    if (!active && !hasPendingInteraction(sessionId)) {
      applySessionActivity(sessionId, false);
      return;
    }
    applySessionActivity(sessionId, true);
    sendSessionTaskProgress(appSessionId, 'running', getBusySessionPhase(sessionId));
  }).catch(() => {
    // The bridge may be shutting down between the probe and the update; a
    // failed activity refresh is harmless.
  });
}

/** Removes a pending question and tells watchers it was answered or dismissed. */
function settlePendingQuestion(requestId: string, kind: 'permission_resolved' | 'permission_cancelled'): void {
  const entry = pendingQuestions.get(requestId);
  if (!entry) {
    return;
  }

  pendingQuestions.delete(requestId);
  rememberId(resolvedInteractions, requestId);
  broadcastInteractionSettled(entry.appSessionId, entry.sessionId, requestId, kind, entry.serverUrl);
}

/**
 * Turns the question panel's answer map back into OpenCode's ordered
 * array-of-arrays. The panel joins multi-selects with ", ", so split them back.
 */
function buildQuestionAnswers(entry: OpenCodePendingQuestion, decision: ProviderPermissionDecision): string[][] {
  const updatedInput = readRecord(decision.updatedInput);
  const rawAnswers = readRecord(updatedInput?.answers);

  return entry.questions.map((question) => {
    const value = rawAnswers?.[question.question];
    if (typeof value !== 'string') {
      return [];
    }
    return value
      .split(', ')
      .map((answer) => answer.trim())
      .filter(Boolean);
  });
}

/**
 * Turns the question panel's answer map into a v2 form's `Form.Answer`.
 *
 * The panel keys answers by the displayed question text, while a form expects
 * each answer under its field `key`: multi-selects as a string array, single
 * selects as one string. Fields the user left unanswered are omitted.
 */
function buildFormAnswers(
  entry: OpenCodePendingQuestion,
  decision: ProviderPermissionDecision,
): Record<string, string | string[]> {
  const updatedInput = readRecord(decision.updatedInput);
  const rawAnswers = readRecord(updatedInput?.answers);
  const answer: Record<string, string | string[]> = {};
  const form = entry.form;
  if (!rawAnswers || !form?.fields) {
    return answer;
  }

  for (const field of form.fields) {
    if (!field.key || field.type === 'external') {
      continue;
    }

    const value = rawAnswers[questionTextForFormField(field, form)];
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }

    const labels = value
      .split(', ')
      .map((label) => label.trim())
      .filter(Boolean);
    if (labels.length === 0) {
      continue;
    }

    answer[field.key] = field.type === 'multiselect' ? labels : labels[0];
  }

  return answer;
}

/** Posts one v2 form answer; a non-2xx response keeps the prompt retryable. */
async function replyToOpenCodeForm(
  server: OpenCodeServer,
  entry: OpenCodePendingQuestion,
  decision: ProviderPermissionDecision,
): Promise<void> {
  const response = await fetch(
    `${server.config.url}/api/session/${encodeURIComponent(entry.sessionId)}/form/${encodeURIComponent(entry.requestId)}/reply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...server.config.headers },
      body: JSON.stringify({ answer: buildFormAnswers(entry, decision) }),
    },
  );
  if (!response.ok) {
    throw new Error(`Form reply failed with status ${response.status}`);
  }
}

/** Cancels one v2 form. The server treats the tool call as aborted. */
async function cancelOpenCodeForm(
  server: OpenCodeServer,
  entry: OpenCodePendingQuestion,
): Promise<void> {
  const response = await fetch(
    `${server.config.url}/api/session/${encodeURIComponent(entry.sessionId)}/form/${encodeURIComponent(entry.requestId)}`,
    { method: 'DELETE', headers: server.config.headers },
  );
  if (!response.ok) {
    throw new Error(`Form cancel failed with status ${response.status}`);
  }
}

/**
 * Lists a session's pending v2 forms.
 *
 * Returns null when the server does not implement the form routes (older
 * 1.18 servers answer 404), so callers can skip without treating it as an
 * error. Transient failures throw and are retried by the next snapshot.
 */
async function listOpenCodeForms(
  server: OpenCodeServer,
  sessionId: string,
  signal: AbortSignal,
): Promise<OpenCodeForm[] | null> {
  const response = await fetch(
    `${server.config.url}/api/session/${encodeURIComponent(sessionId)}/form`,
    { headers: server.config.headers, signal },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Form list failed with status ${response.status}`);
  }

  const body: unknown = await response.json();
  const data = Array.isArray(body) ? body : readRecord(body)?.data;
  if (!Array.isArray(data)) {
    return [];
  }

  const forms: OpenCodeForm[] = [];
  for (const value of data) {
    const form = readOpenCodeForm(value);
    if (form) {
      forms.push(form);
    }
  }
  return forms;
}


function notifyUserOfPermission(sessionId: string, toolName: string | null): void {
  const userId = resolveNotificationUserId();
  if (!userId) {
    return;
  }

  notifyPermissionRequired({
    userId,
    provider: PROVIDER,
    sessionId: resolveAppSessionId(sessionId),
    toolName: toolName ?? undefined,
  });
}

function notifyUserOfQuestion(sessionId: string, question: string | null): void {
  const userId = resolveNotificationUserId();
  if (!userId) {
    return;
  }

  notifyQuestionRequired({
    userId,
    provider: PROVIDER,
    sessionId: resolveAppSessionId(sessionId),
    question: question ?? undefined,
  });
}

/** Consumed by bridge tests to verify provider event normalization and approval delivery. */
export function handleOpenCodeEvent(
  event: OpenCodeEventShape,
  server: OpenCodeServer | null = servers[0] ?? null,
): void {
  if (!server) {
    return;
  }
  const payload = event.payload ?? event;
  const properties = readRecord(payload.properties) ?? readRecord(payload.data);
  const sessionId = readString(properties?.sessionID) ?? readString(properties?.sessionId)
    ?? readString(readRecord(properties?.part)?.sessionID)
    // v2 form events carry the session on the form itself.
    ?? readString(readRecord(properties?.form)?.sessionID);
  if (!sessionId) {
    return;
  }
  // v1 events carry `directory`; v2 events carry it under `location`.
  const directory = readString(event.directory) ?? readString(readRecord(event.location)?.directory) ?? undefined;
  if (directory) {
    sessionDirectories.set(sessionId, directory);
  }

  if (payload.type === 'session.status') {
    const status = readRecord(properties?.status);
    const statusType = readString(status?.type) ?? 'idle';
    applySessionActivity(sessionId, statusType !== 'idle');
    return;
  }

  if (payload.type === 'session.idle') {
    applySessionActivity(sessionId, false);
    return;
  }

  if (payload.type === 'permission.updated' || payload.type === 'permission.asked' || payload.type === 'permission.v2.asked') {
    registerPendingPermission(properties ?? {}, directory, server.config.url);
    return;
  }

  if (payload.type === 'permission.replied' || payload.type === 'permission.v2.replied') {
    const permissionId = readString(properties?.permissionID)
      ?? readString(properties?.requestID)
      ?? '';
    const entry = permissionId ? pendingPermissions.get(permissionId) : undefined;
    if (!entry) {
      return;
    }

    pendingPermissions.delete(permissionId);
    rememberId(resolvedInteractions, permissionId);
    broadcastInteractionSettled(entry.appSessionId, entry.sessionId, permissionId, 'permission_resolved', entry.serverUrl);
    return;
  }

  if (payload.type === 'question.asked' || payload.type === 'question.v2.asked') {
    registerPendingQuestion(
      readString(properties?.id) ?? '',
      sessionId,
      normalizeOpenCodeQuestions(properties?.questions),
      server.config.url,
      directory,
    );
    return;
  }

  if (payload.type === 'question.replied' || payload.type === 'question.v2.replied') {
    settlePendingQuestion(readString(properties?.requestID) ?? '', 'permission_resolved');
    return;
  }

  if (payload.type === 'question.rejected' || payload.type === 'question.v2.rejected') {
    settlePendingQuestion(readString(properties?.requestID) ?? '', 'permission_cancelled');
    return;
  }

  // OpenCode 2.0+ desktop servers raise the `question` tool as a form: the
  // session id sits on the form, and answering goes through the form API.
  if (payload.type === 'form.created') {
    registerPendingForm(readRecord(properties?.form), sessionId, server.config.url, directory);
    return;
  }

  if (payload.type === 'form.replied') {
    settlePendingQuestion(readString(properties?.id) ?? '', 'permission_resolved');
    return;
  }

  if (payload.type === 'form.cancelled') {
    settlePendingQuestion(readString(properties?.id) ?? '', 'permission_cancelled');
    return;
  }

  if (payload.type === 'message.part.updated') {
    const part = readRecord(properties?.part);
    if (!part) {
      return;
    }
    const state = readRecord(part.state);
    if (part.type === 'tool' && part.tool === 'question' && readString(state?.status) === 'running') {
      // The event stream does not reliably carry the question request id, so
      // reconcile against the server's pending list using this part's call id.
      // `registerPendingQuestion` dedupes, so repeated updates are harmless.
      const callId = readString(part.callID);
      void reconcilePendingQuestions(sessionId, callId, directory, server);
    }
  }
}

/** Current SDK list responses are arrays; v2 API responses wrap them in `data`. */
function readRequestList(data: unknown): Record<string, unknown>[] {
  const requests = Array.isArray(data) ? data : readRecord(data)?.data;
  return Array.isArray(requests) ? requests.map(readRecord).filter((entry) => entry !== null) : [];
}

/**
 * Restores activity and pending prompts after startup or a stream reconnection.
 *
 * Activity comes from the v2 `session/active` list, which is global per server;
 * pending approvals/questions are location-scoped, so each known directory is
 * queried once and reconciled against the bridge's own pending maps.
 */
async function syncStatusSnapshot(server: OpenCodeServer, signal: AbortSignal): Promise<void> {
  const options = { signal, throwOnError: true as const };

  // Busy sessions: `session/active` lists the foreground drains this server
  // owns, so a session is busy exactly when it is present. A session blocked on
  // an approval is added back below so the activity flip cannot drop its prompt.
  const activeResult = await Promise.allSettled([server.client.v2.session.active(options)]);
  if (signal.aborted) {
    return;
  }
  const previousActive = activeProviderSessionsByServer.get(server.config.url) ?? new Set<string>();
  const activeIds = new Set<string>();
  if (activeResult[0].status === 'fulfilled') {
    // The v2 endpoint wraps its map once more (`{ data: { <sessionId>: ... } }`).
    // Reading the outer object's keys would yield the literal "data".
    const activeData = readRecord(readRecord(activeResult[0].value.data)?.data) ?? {};
    for (const providerSessionId of Object.keys(activeData)) {
      activeIds.add(providerSessionId);
      applySessionActivity(providerSessionId, true);
    }
  } else {
    // A failed query cannot establish that an unseen run is idle; keep the
    // previous set so the next snapshot reconciles it.
    for (const providerSessionId of previousActive) {
      activeIds.add(providerSessionId);
    }
  }
  for (const entry of [...pendingPermissions.values(), ...pendingQuestions.values()]) {
    if (entry.serverUrl === server.config.url) {
      activeIds.add(entry.sessionId);
    }
  }
  for (const providerSessionId of previousActive) {
    if (!activeIds.has(providerSessionId)) {
      applySessionActivity(providerSessionId, false);
    }
  }
  activeProviderSessionsByServer.set(server.config.url, activeIds);

  // Pending approvals/questions, reconciled per directory. A directory that
  // does not exist on disk cannot hold a live approval, and a server asked
  // about a stale path answers HTTP 500 on every reconcile (the CLI's internal
  // probe directories vanish when it exits), so dead paths are dropped here.
  const directories = new Set<string | undefined>([undefined]);
  const addDirectory = (directory: string): void => {
    if (directory && existsSync(directory)) {
      directories.add(directory);
    }
  };
  for (const directory of sessionDirectories.values()) {
    addDirectory(directory);
  }
  for (const session of sessionsDb.getAllSessions()) {
    if (session.provider === PROVIDER && session.project_path) {
      addDirectory(session.project_path);
    }
  }
  for (const directory of directories) {
    const results = await Promise.allSettled([
      server.client.v2.permission.request.list({ location: { directory } }, options),
      server.client.v2.question.request.list({ location: { directory } }, options),
    ]);
    if (signal.aborted) {
      return;
    }

    const permissionResult = results[0];
    if (permissionResult.status === 'fulfilled') {
      const requests = readRequestList(permissionResult.value.data);
      const requestIds = new Set(requests.map((request) => readString(request.id)));
      for (const [id, entry] of pendingPermissions) {
        if (entry.serverUrl === server.config.url && entry.directory === directory && !requestIds.has(id)) {
          pendingPermissions.delete(id);
          broadcastInteractionSettled(entry.appSessionId, entry.sessionId, id, 'permission_cancelled', entry.serverUrl);
        }
      }
      for (const request of requests) {
        registerPendingPermission(request, directory, server.config.url);
      }
    }

    const questionResult = results[1];
    if (questionResult.status === 'fulfilled') {
      const requests = readRequestList(questionResult.value.data);
      const requestIds = new Set(requests.map((request) => readString(request.id)));
      for (const [id, entry] of pendingQuestions) {
        // Form-backed questions (OpenCode 2.0+) are not part of the legacy
        // list; the form sweep below owns their lifecycle.
        if (entry.form) {
          continue;
        }
        if (entry.serverUrl === server.config.url && entry.directory === directory && !requestIds.has(id)) {
          settlePendingQuestion(id, 'permission_cancelled');
        }
      }
      for (const request of requests) {
        registerPendingQuestion(
          readString(request.id) ?? '',
          readString(request.sessionID) ?? '',
          normalizeOpenCodeQuestions(request.questions),
          server.config.url,
          directory,
        );
      }
    }
  }

  // v2 forms (OpenCode 2.0+ desktop servers) are the question mechanism there,
  // listed per session rather than per location. Only sessions this server owns
  // are queried; the first 404 stops the sweep because it means the server
  // predates the form routes, and transient failures wait for the next pass.
  const formSessions = new Set<string>();
  for (const entry of pendingQuestions.values()) {
    if (entry.serverUrl === server.config.url && entry.form) {
      formSessions.add(entry.sessionId);
    }
  }
  for (const session of sessionsDb.getAllSessions()) {
    if (session.provider !== PROVIDER || !session.provider_session_id) {
      continue;
    }
    if (session.open_code_server_id && server.config.id
      && session.open_code_server_id !== server.config.id) {
      continue;
    }
    formSessions.add(session.provider_session_id);
  }
  for (const providerSessionId of formSessions) {
    if (signal.aborted) {
      return;
    }

    let forms: OpenCodeForm[] | null;
    try {
      forms = await listOpenCodeForms(server, providerSessionId, signal);
    } catch {
      continue;
    }
    if (!forms) {
      break;
    }

    const formIds = new Set(forms.map((form) => form.id));
    for (const [id, entry] of pendingQuestions) {
      if (entry.serverUrl === server.config.url && entry.form
        && entry.sessionId === providerSessionId && !formIds.has(id)) {
        settlePendingQuestion(id, 'permission_cancelled');
      }
    }
    for (const form of forms) {
      registerPendingForm(form, providerSessionId, server.config.url, sessionDirectories.get(providerSessionId));
    }
  }
}

async function runEventLoop(server: OpenCodeServer, signal: AbortSignal): Promise<void> {
  let retryDelay = INITIAL_RETRY_DELAY_MS;
  while (!signal.aborted) {
    try {
      await syncStatusSnapshot(server, signal);
      // The v2 event stream carries every project's events, including the
      // location needed to find and answer each prompt.
      const { stream } = await server.client.v2.event.subscribe({ signal, sseMaxRetryAttempts: 1 });
      // A dropped `session.idle` event would otherwise leave the phone's
      // progress notification stuck on "processing" until the next reconnect.
      // Re-reading the server's authoritative active set heals that within one
      // interval; the guard keeps overlapping snapshots from interleaving.
      let reconciling = false;
      const reconcileTimer = setInterval(() => {
        if (reconciling || signal.aborted) {
          return;
        }
        reconciling = true;
        void syncStatusSnapshot(server, signal)
          .catch(() => {})
          .finally(() => { reconciling = false; });
      }, STATUS_RECONCILE_INTERVAL_MS);
      try {
        for await (const event of stream as AsyncGenerator<OpenCodeEventShape>) {
          if (signal.aborted) {
            break;
          }
          retryDelay = INITIAL_RETRY_DELAY_MS;
          if ((event.payload ?? event).type === 'server.connected') {
            // Covers requests raised between the snapshot and stream attachment.
            await syncStatusSnapshot(server, signal);
          }
          handleOpenCodeEvent(event, server);
        }
      } finally {
        clearInterval(reconcileTimer);
      }
      throw new Error('OpenCode event stream ended');
    } catch (error) {
      if (signal.aborted) {
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeBridge] Connection lost for ${server.config.url}, retrying in ${retryDelay}ms:`, message);
      await delay(retryDelay, undefined, { signal }).catch(() => {});
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

/** Consumed by the server entrypoint to mirror external OpenCode run activity. */
export function startOpenCodeBridge(): void {
  if (started || process.env.OPENCODE_BRIDGE_DISABLED === 'true') {
    return;
  }
  started = true;
  bridgeAbortController = new AbortController();

  const configs = resolveServerConfigs();
  servers = configs.map((config) => ({
    config,
    client: createOpencodeClient({ baseUrl: config.url, headers: config.headers }),
  }));
  for (const server of servers) {
    console.log(`[OpenCodeBridge] Watching OpenCode server at ${server.config.url}`);
    void runEventLoop(server, bridgeAbortController.signal);
  }
}

/** Consumed by the server entrypoint on shutdown. */
export function stopOpenCodeBridge(): void {
  started = false;
  bridgeAbortController?.abort();
  bridgeAbortController = null;
  servers = [];
  activeProviderSessionsByServer.clear();
  for (const providerSessionId of busyProviderSessions) {
    const appSessionId = resolveAppSessionId(providerSessionId);
    // Clear the phone's persistent task entry too, not just the websocket
    // activity flag; otherwise the notification stays on "processing".
    sendSessionTaskProgress(appSessionId, 'finished', '');
    setExternalSessionActivity(appSessionId, PROVIDER, false);
  }
  busyProviderSessions.clear();
  sessionDirectories.clear();
  resolvingInteractions.clear();
  resolvedInteractions.clear();
  announcedPermissions.clear();
  permissionReplyDialects.clear();
  pendingPermissions.clear();
  pendingQuestions.clear();
}

/** Finds the server a pending interaction belongs to, falling back to the first. */
function findServer(serverUrl: string): OpenCodeServer | null {
  return servers.find((server) => server.config.url === serverUrl) ?? servers[0] ?? null;
}

/**
 * Interactive approval gateway for OpenCode sessions.
 *
 * The server entrypoint hands this to the OpenCode runtime so the chat gateway
 * can surface pending approvals (via `chat.subscribe`) and answer them. It is
 * the only component connected to the OpenCode servers' event streams, so the
 * pending state lives here.
 */
export const openCodePermissionGateway: ProviderRuntimePermissionGateway = {
  listPending(appSessionId: string): unknown[] {
    const permissions = Array.from(pendingPermissions.values())
      .filter((entry) => entry.appSessionId === appSessionId)
      .map((entry) => ({
        requestId: entry.permissionId,
        toolName: entry.toolName,
        input: entry.input,
        context: entry.context,
        sessionId: entry.appSessionId,
        receivedAt: entry.receivedAt,
      }));

    // Questions ride the same channel, presented as `AskUserQuestion` so the
    // shared panel renders single/multi-select and a custom answer.
    const questions = Array.from(pendingQuestions.values())
      .filter((entry) => entry.appSessionId === appSessionId)
      .map((entry) => ({
        requestId: entry.requestId,
        toolName: 'AskUserQuestion',
        input: { questions: entry.questions },
        sessionId: entry.appSessionId,
        receivedAt: entry.receivedAt,
      }));

    return [...permissions, ...questions];
  },

  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    if (resolvingInteractions.has(requestId)) {
      return;
    }
    const question = pendingQuestions.get(requestId);
    if (question) {
      resolveOpenCodeQuestion(question, decision);
      return;
    }

    const entry = pendingPermissions.get(requestId);
    if (!entry) {
      return;
    }
    const server = findServer(entry.serverUrl);
    if (!server) {
      return;
    }

    const reply = decision.allow ? (decision.rememberEntry ? 'always' : 'once') : 'reject';
    resolvingInteractions.add(requestId);
    const request = replyToOpenCodePermission(server, entry, reply, decision.message);
    void request
      .then(() => {
        rememberId(resolvedInteractions, requestId);
        if (pendingPermissions.delete(requestId)) {
          broadcastInteractionSettled(entry.appSessionId, entry.sessionId, requestId, 'permission_resolved', entry.serverUrl);
        }
      })
      .catch((error: unknown) => {
        // The phone optimistically removes submitted prompts. Re-deliver on
        // HTTP errors as well as transport failures so it can retry immediately.
        if (pendingPermissions.has(requestId)) broadcastPendingPermission(entry);
        const message = error instanceof Error ? error.message : String(error);
        console.error('[OpenCodeBridge] Failed to answer permission request', {
          requestId,
          error: message,
        });
      })
      .finally(() => resolvingInteractions.delete(requestId));
  },
};

/**
 * How one server addresses a permission reply.
 *
 * OpenCode 2.0 renamed the body field from `reply` to `decision` and rejects
 * the old one outright (`Missing key at ["decision"]`), while 1.x only reads
 * `reply`. The dialect is probed once per server from `/global/health`, which
 * 1.x answers with JSON and 2.x serves as its web app.
 */
const permissionReplyDialects = new Map<string, 'decision' | 'reply'>();

async function resolvePermissionReplyDialect(server: OpenCodeServer): Promise<'decision' | 'reply'> {
  const cached = permissionReplyDialects.get(server.config.url);
  if (cached) {
    return cached;
  }

  let dialect: 'decision' | 'reply' = 'decision';
  try {
    const response = await fetch(`${server.config.url}/global/health`, {
      headers: server.config.headers,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (response.ok && contentType.includes('application/json')) {
      dialect = 'reply';
    }
  } catch {
    // An unreachable probe keeps the newer dialect; the reply itself surfaces
    // any real connectivity problem.
  }

  permissionReplyDialects.set(server.config.url, dialect);
  return dialect;
}

/** Sends one permission decision in the dialect its server understands. */
async function replyToOpenCodePermission(
  server: OpenCodeServer,
  entry: OpenCodePendingPermission,
  reply: 'once' | 'always' | 'reject',
  message: string | undefined,
): Promise<void> {
  if (await resolvePermissionReplyDialect(server) === 'reply') {
    await server.client.v2.session.permission.reply(
      { sessionID: entry.sessionId, requestID: entry.permissionId, reply, message },
      { throwOnError: true },
    );
    return;
  }

  const response = await fetch(
    `${server.config.url}/api/session/${encodeURIComponent(entry.sessionId)}/permission/${encodeURIComponent(entry.permissionId)}/reply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...server.config.headers },
      body: JSON.stringify({ decision: reply, ...(message ? { message } : {}) }),
    },
  );
  if (!response.ok) {
    throw new Error(`Permission reply failed with status ${response.status}`);
  }
}

/**
 * Answers through the endpoint matching the event, retaining failed submissions.
 *
 * Questions raised as v2 forms go through the form API; legacy 1.18 questions
 * go through the SDK's session question reply/reject endpoints.
 */
function resolveOpenCodeQuestion(entry: OpenCodePendingQuestion, decision: ProviderPermissionDecision): void {
  const server = findServer(entry.serverUrl);
  if (!server) {
    return;
  }

  resolvingInteractions.add(entry.requestId);
  const options = { throwOnError: true as const };
  let request: Promise<unknown>;
  if (entry.form) {
    request = decision.allow
      ? replyToOpenCodeForm(server, entry, decision)
      : cancelOpenCodeForm(server, entry);
  } else {
    const answers = buildQuestionAnswers(entry, decision);
    request = decision.allow
      ? server.client.v2.session.question.reply(
        { sessionID: entry.sessionId, requestID: entry.requestId, questionV2Reply: { answers } },
        options,
      )
      : server.client.v2.session.question.reject(
        { sessionID: entry.sessionId, requestID: entry.requestId },
        options,
      );
  }

  void Promise.resolve(request)
    .then(() => {
      rememberId(resolvedInteractions, entry.requestId);
      if (pendingQuestions.delete(entry.requestId)) {
        broadcastInteractionSettled(entry.appSessionId, entry.sessionId, entry.requestId,
          decision.allow ? 'permission_resolved' : 'permission_cancelled', entry.serverUrl);
      }
    })
    .catch((error: unknown) => {
      if (pendingQuestions.has(entry.requestId)) broadcastPendingQuestion(entry);
      const message = error instanceof Error ? error.message : String(error);
      console.error('[OpenCodeBridge] Failed to answer question request', {
        requestId: entry.requestId,
        error: message,
      });
    })
    .finally(() => resolvingInteractions.delete(entry.requestId));
}
