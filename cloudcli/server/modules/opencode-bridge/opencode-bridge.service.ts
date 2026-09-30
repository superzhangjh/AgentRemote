import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import { sessionsDb, userDb } from '@/modules/database/index.js';
import {
  notifyPermissionRequired,
  notifyQuestionRequired,
  sendDesktopTaskProgress,
} from '@/modules/notifications/index.js';
import { connectedClients, setExternalSessionActivity, WS_OPEN_STATE } from '@/modules/websocket/index.js';
import type { LLMProvider, ProviderPermissionDecision, ProviderRuntimePermissionGateway } from '@/shared/types.js';
import { createNormalizedMessage, readSharedOpenCodeServerUrl } from '@/shared/utils.js';

const PROVIDER: LLMProvider = 'opencode';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:4096';
const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_TRACKED_IDS = 500;

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

type OpenCodeEventShape = {
  type?: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
  directory?: string;
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

let client: OpenCodeClient | null = null;
let bridgeAbortController: AbortController | null = null;
let started = false;
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
  toolName: string;
  input: unknown;
  context: unknown;
  receivedAt: Date;
  protocol: 'legacy' | 'current' | 'v2';
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
  questions: OpenCodeQuestion[];
  receivedAt: Date;
  protocol: 'current' | 'v2';
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

type OpenCodeServerConfig = {
  url: string;
  headers: Record<string, string>;
};

/** Builds the Basic auth header from an explicit username/password pair. */
function buildAuthHeaders(username: string | undefined, password: string | undefined): Record<string, string> {
  if (!password) {
    return {};
  }

  const token = Buffer.from(`${username?.trim() || 'opencode'}:${password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${token}` };
}

/**
 * Reads a running `opencode serve` process's `--port` and
 * `OPENCODE_SERVER_PASSWORD` from the process table.
 *
 * The CLI generates a random per-process password and only exposes it in its
 * own environment; there is no config file to read. Reading the process table
 * lets CloudCLI connect without the user copying the address or secret, which
 * is exactly how `opencode attach` behaves when given no arguments.
 */
function discoverRunningServer(): { port: string | null; password: string | null } {
  try {
    const output = execFileSync('ps', ['eww', '-ax'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });

    for (const line of output.split('\n')) {
      if (!line.includes('opencode') || !line.includes('serve')) {
        continue;
      }

      const password = line.match(/OPENCODE_SERVER_PASSWORD=(\S+)/)?.[1] ?? null;
      if (!password) {
        continue;
      }

      const port = line.match(/--port=(\d+)/)?.[1] ?? null;
      return { port, password };
    }
  } catch {
    // Process discovery is best-effort; fall back to defaults when it fails.
  }

  return { port: null, password: null };
}

/**
 * Resolves the server CloudCLI should mirror. Explicit environment variables
 * win; otherwise the AgentRemote console's advertised server is used, then the
 * running `opencode serve` process is discovered, and only then does it fall
 * back to the CLI's conventional port with no auth.
 *
 * Exported for the module's tests.
 */
export function resolveServerConfig(): OpenCodeServerConfig {
  const configuredUrl = process.env.OPENCODE_SERVER_URL?.trim();
  const configuredPassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (configuredUrl || configuredPassword) {
    return {
      url: configuredUrl || DEFAULT_SERVER_URL,
      headers: buildAuthHeaders(process.env.OPENCODE_SERVER_USERNAME, configuredPassword),
    };
  }

  // The AgentRemote console advertises its long-lived `opencode serve` instance
  // in a descriptor file. Prefer it over process discovery: the managed server
  // runs without OPENCODE_SERVER_PASSWORD, and discovery keys on that variable,
  // so it would miss the real server and fall back to the default port.
  const sharedUrl = readSharedOpenCodeServerUrl();
  if (sharedUrl) {
    return { url: sharedUrl, headers: {} };
  }

  const discovered = discoverRunningServer();
  if (discovered.password) {
    return {
      url: `http://127.0.0.1:${discovered.port ?? '4096'}`,
      headers: buildAuthHeaders(process.env.OPENCODE_SERVER_USERNAME, discovered.password),
    };
  }

  return { url: DEFAULT_SERVER_URL, headers: {} };
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

  if (!isBusy) {
    clearPendingInteractionsForSession(providerSessionId);
  }

  setExternalSessionActivity(appSessionId, PROVIDER, isBusy, isBusy ? phase : null);
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

/** Registers live and recovered approvals through the same phone delivery path. */
function registerPendingPermission(
  properties: Record<string, unknown>,
  directory: string | undefined,
  protocol: OpenCodePendingPermission['protocol'],
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
    toolName: readString(properties.title) ?? readString(properties.permission)
      ?? readString(properties.action) ?? readString(properties.type) ?? 'Tool',
    input: readRecord(properties.metadata) ?? undefined,
    context: properties.pattern ?? properties.patterns ?? properties.resources,
    receivedAt: new Date(),
    protocol,
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
 */
function registerPendingQuestion(
  requestId: string,
  sessionId: string,
  questions: OpenCodeQuestion[],
  directory?: string,
  protocol: OpenCodePendingQuestion['protocol'] = 'current',
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
    questions,
    receivedAt: new Date(),
    protocol,
  };
  pendingQuestions.set(requestId, entry);

  notifyUserOfQuestion(sessionId, questions[0]?.question ?? null);
  applySessionActivity(sessionId, true);
  sendSessionTaskProgress(appSessionId, 'running', '等待回答');
  broadcastPendingQuestion(entry);
}

/**
 * Reconciles pending questions for one session against the server's list.
 *
 * The event stream does not always carry a usable request id, so a running
 * `question` tool part causes one list call; the request whose `tool.callID`
 * matches the part is the one being rendered.
 */
async function reconcilePendingQuestions(sessionId: string, callId: string | null, directory?: string): Promise<void> {
  const activeClient = client;
  if (!activeClient) {
    return;
  }

  // The part can become `running` a beat before the server registers the
  // request, so retry briefly instead of giving up on the first empty list.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await activeClient.question.list({ directory }, { throwOnError: true });
      const requests = Array.isArray(result.data) ? result.data : [];
      let registered = false;
      for (const request of requests) {
        const requestId = readString(request?.id);
        if (!requestId || pendingQuestions.has(requestId)) {
          continue;
        }
        if (request.sessionID !== sessionId) {
          continue;
        }
        if (callId && readString(request?.tool?.callID) !== callId) {
          continue;
        }
        registerPendingQuestion(requestId, sessionId, normalizeOpenCodeQuestions(request?.questions), directory);
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

/** Tells watchers a question interaction ended and restores the run's progress label. */
function broadcastInteractionSettled(
  appSessionId: string,
  sessionId: string,
  requestId: string,
  kind: 'permission_resolved' | 'permission_cancelled',
): void {
  broadcastChatEvent(createNormalizedMessage({
    kind,
    provider: PROVIDER,
    sessionId: appSessionId,
    requestId,
  }));
  if (busyProviderSessions.has(sessionId)) {
    applySessionActivity(sessionId, true);
    sendSessionTaskProgress(appSessionId, 'running', getBusySessionPhase(sessionId));
  }
}

/** Removes a pending question and tells watchers it was answered or dismissed. */
function settlePendingQuestion(requestId: string, kind: 'permission_resolved' | 'permission_cancelled'): void {
  const entry = pendingQuestions.get(requestId);
  if (!entry) {
    return;
  }

  pendingQuestions.delete(requestId);
  rememberId(resolvedInteractions, requestId);
  broadcastInteractionSettled(entry.appSessionId, entry.sessionId, requestId, kind);
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

/** Extracts the visible question text from a `question` tool part. */
function readQuestionText(part: Record<string, unknown>): string | null {
  const state = readRecord(part.state);
  const input = readRecord(state?.input);
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  for (const entry of questions) {
    const record = readRecord(entry);
    const question = readString(record?.question) ?? readString(record?.header);
    if (question) {
      return question;
    }
  }

  return readString(input?.question);
}

/** Consumed by bridge tests to verify provider event normalization and approval delivery. */
export function handleOpenCodeEvent(event: OpenCodeEventShape): void {
  const payload = event.payload ?? event;
  const properties = readRecord(payload.properties) ?? readRecord(payload.data);
  const sessionId = readString(properties?.sessionID) ?? readString(properties?.sessionId)
    ?? readString(readRecord(properties?.part)?.sessionID);
  if (!sessionId) {
    return;
  }
  const directory = readString(event.directory) ?? undefined;
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
    registerPendingPermission(properties ?? {}, directory,
      payload.type === 'permission.updated' ? 'legacy' : payload.type === 'permission.v2.asked' ? 'v2' : 'current');
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
    broadcastInteractionSettled(entry.appSessionId, entry.sessionId, permissionId, 'permission_resolved');
    return;
  }

  if (payload.type === 'question.asked' || payload.type === 'question.v2.asked') {
    registerPendingQuestion(
      readString(properties?.id) ?? '',
      sessionId,
      normalizeOpenCodeQuestions(properties?.questions),
      directory,
      payload.type === 'question.v2.asked' ? 'v2' : 'current',
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
      if (client) {
        void reconcilePendingQuestions(sessionId, callId, directory);
      } else {
        notifyUserOfQuestion(sessionId, readQuestionText(part));
      }
    }
  }
}

/** Current SDK list responses are arrays; v2 API responses wrap them in `data`. */
function readRequestList(data: unknown): Record<string, unknown>[] {
  const requests = Array.isArray(data) ? data : readRecord(data)?.data;
  return Array.isArray(requests) ? requests.map(readRecord).filter((entry) => entry !== null) : [];
}

/** Restores activity and pending prompts after startup or a stream reconnection. */
async function syncStatusSnapshot(activeClient: OpenCodeClient, signal: AbortSignal): Promise<void> {
  const directories = new Set<string | undefined>([undefined, ...sessionDirectories.values()]);
  for (const session of sessionsDb.getAllSessions()) {
    if (session.provider === PROVIDER && session.project_path) {
      directories.add(session.project_path);
    }
  }
  const seen = new Set<string>();
  let allStatusesRead = true;
  for (const directory of directories) {
    const options = { signal, throwOnError: true as const };
    const results = await Promise.allSettled([
      activeClient.session.status({ directory }, options),
      activeClient.permission.list({ directory }, options),
      activeClient.question.list({ directory }, options),
      activeClient.v2.permission.request.list({ location: { directory } }, options),
      activeClient.v2.question.request.list({ location: { directory } }, options),
    ]);
    if (signal.aborted) {
      return;
    }
    const statusResult = results[0];
    if (statusResult.status === 'fulfilled') {
      for (const [providerSessionId, status] of Object.entries(readRecord(statusResult.value.data) ?? {})) {
        if (directory) sessionDirectories.set(providerSessionId, directory);
        if (readString(readRecord(status)?.type) !== 'idle') {
          seen.add(providerSessionId);
          applySessionActivity(providerSessionId, true);
        }
      }
    } else {
      // A failed directory query cannot establish that an unseen run is idle.
      allStatusesRead = false;
    }

    for (let index = 1; index < results.length; index++) {
      const result = results[index];
      if (result.status !== 'fulfilled') {
        // Older servers do not expose the new v2 lists. Keep listening to
        // their supported event protocol even when one snapshot API fails.
        continue;
      }
      const protocol = index < 3 ? 'current' : 'v2';
      const requests = readRequestList(result.value.data);
      const requestIds = new Set(requests.map((request) => readString(request.id)));
      if (index === 1 || index === 3) {
        for (const [id, entry] of pendingPermissions) {
          if (entry.protocol === protocol && entry.directory === directory && !requestIds.has(id)) {
            pendingPermissions.delete(id);
            broadcastInteractionSettled(entry.appSessionId, entry.sessionId, id, 'permission_cancelled');
          }
        }
        for (const request of requests) registerPendingPermission(request, directory, protocol);
      } else {
        for (const [id, entry] of pendingQuestions) {
          if (entry.protocol === protocol && entry.directory === directory && !requestIds.has(id)) {
            settlePendingQuestion(id, 'permission_cancelled');
          }
        }
        for (const request of requests) {
          registerPendingQuestion(readString(request.id) ?? '', readString(request.sessionID) ?? '',
            normalizeOpenCodeQuestions(request.questions), directory, protocol);
        }
      }
    }
  }

  for (const entry of [...pendingPermissions.values(), ...pendingQuestions.values()]) {
    seen.add(entry.sessionId);
  }
  // An incomplete snapshot must not turn a disconnected, blocked run idle.
  for (const providerSessionId of Array.from(busyProviderSessions)) {
    if (allStatusesRead && !seen.has(providerSessionId)) {
      applySessionActivity(providerSessionId, false);
    }
  }
}

async function runEventLoop(activeClient: OpenCodeClient, signal: AbortSignal): Promise<void> {
  let retryDelay = INITIAL_RETRY_DELAY_MS;
  while (!signal.aborted) {
    try {
      await syncStatusSnapshot(activeClient, signal);
      // `/event` watches only the server's default project. The global stream
      // includes the directory needed to find and answer each project's prompt.
      const { stream } = await activeClient.global.event({ signal, sseMaxRetryAttempts: 1 });
      for await (const event of stream as AsyncGenerator<OpenCodeEventShape>) {
        if (signal.aborted) {
          break;
        }
        retryDelay = INITIAL_RETRY_DELAY_MS;
        if ((event.payload ?? event).type === 'server.connected') {
          // Covers requests raised between the snapshot and stream attachment.
          await syncStatusSnapshot(activeClient, signal);
        }
        handleOpenCodeEvent(event);
      }
      throw new Error('OpenCode event stream ended');
    } catch (error) {
      if (signal.aborted) {
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeBridge] Connection lost, retrying in ${retryDelay}ms:`, message);
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

  const config = resolveServerConfig();
  client = createOpencodeClient({
    baseUrl: config.url,
    headers: config.headers,
  });
  console.log(`[OpenCodeBridge] Watching OpenCode server at ${config.url}`);
  void runEventLoop(client, bridgeAbortController.signal);
}

/** Consumed by the server entrypoint on shutdown. */
export function stopOpenCodeBridge(): void {
  started = false;
  bridgeAbortController?.abort();
  bridgeAbortController = null;
  client = null;
  for (const providerSessionId of busyProviderSessions) {
    setExternalSessionActivity(resolveAppSessionId(providerSessionId), PROVIDER, false);
  }
  busyProviderSessions.clear();
  sessionDirectories.clear();
  resolvingInteractions.clear();
  resolvedInteractions.clear();
  announcedPermissions.clear();
  pendingPermissions.clear();
  pendingQuestions.clear();
}

/**
 * Interactive approval gateway for OpenCode sessions.
 *
 * The server entrypoint hands this to the OpenCode runtime so the chat gateway
 * can surface pending approvals (via `chat.subscribe`) and answer them. It is
 * the only component connected to the OpenCode server's event stream, so the
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
    if (!entry || !client) {
      return;
    }

    const reply = decision.allow ? (decision.rememberEntry ? 'always' : 'once') : 'reject';
    const options = { throwOnError: true as const };
    resolvingInteractions.add(requestId);
    const request = entry.protocol === 'v2'
      ? client.v2.session.permission.reply({ sessionID: entry.sessionId, requestID: requestId, reply, message: decision.message }, options)
      : entry.protocol === 'legacy'
        ? client.permission.respond({ sessionID: entry.sessionId, permissionID: requestId, directory: entry.directory, response: reply }, options)
        : client.permission.reply({ requestID: requestId, directory: entry.directory, reply, message: decision.message }, options);
    void request
      .then(() => {
        rememberId(resolvedInteractions, requestId);
        if (pendingPermissions.delete(requestId)) {
          broadcastInteractionSettled(entry.appSessionId, entry.sessionId, requestId, 'permission_resolved');
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
 * Answers through the endpoint matching the event, retaining failed submissions.
 */
function resolveOpenCodeQuestion(entry: OpenCodePendingQuestion, decision: ProviderPermissionDecision): void {
  if (!client) {
    return;
  }

  resolvingInteractions.add(entry.requestId);
  const options = { throwOnError: true as const };
  const answers = buildQuestionAnswers(entry, decision);
  const request = entry.protocol === 'v2'
    ? decision.allow
      ? client.v2.session.question.reply({ sessionID: entry.sessionId, requestID: entry.requestId, questionV2Reply: { answers } }, options)
      : client.v2.session.question.reject({ sessionID: entry.sessionId, requestID: entry.requestId }, options)
    : decision.allow
      ? client.question.reply({ requestID: entry.requestId, directory: entry.directory, answers }, options)
      : client.question.reject({ requestID: entry.requestId, directory: entry.directory }, options);

  void Promise.resolve(request)
    .then(() => {
      rememberId(resolvedInteractions, entry.requestId);
      if (pendingQuestions.delete(entry.requestId)) {
        broadcastInteractionSettled(entry.appSessionId, entry.sessionId, entry.requestId,
          decision.allow ? 'permission_resolved' : 'permission_cancelled');
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
