import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
      // Only an actual `opencode serve` invocation, not an unrelated process
      // that merely inherited the variable and mentions both words.
      if (!/opencode(\.js)?\s+serve/.test(line)) {
        continue;
      }

      const password = line.match(/OPENCODE_SERVER_PASSWORD=(\S+)/)?.[1] ?? null;
      if (!password) {
        continue;
      }

      // The CLI accepts both `--port=1234` and `--port 1234`.
      const port = line.match(/--port[= ](\d+)/)?.[1] ?? null;
      if (!port) {
        continue;
      }
      return { port, password };
    }
  } catch {
    // Process discovery is best-effort; fall back to defaults when it fails.
  }

  return { port: null, password: null };
}

/** Reads a v2 background service's `service.json` descriptor (`url` + `password`). */
function readServiceDescriptor(filePath: string): OpenCodeServerConfig | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const url = readString(parsed.url);
    if (!url) {
      return null;
    }

    const password = typeof parsed.password === 'string' ? parsed.password : '';
    return { url, headers: buildAuthHeaders('opencode', password) };
  } catch {
    return null;
  }
}

/**
 * Discovers the OpenCode v2 background services the desktop apps run.
 *
 * Each service writes `service.json` (url + password) under its own
 * `XDG_STATE_HOME/opencode`. Running `opencode-cli serve --service` processes
 * advertise that state home in their environment, and the default and
 * profile-scoped locations are checked directly as a fallback.
 */
function discoverServiceServers(): OpenCodeServerConfig[] {
  const descriptors: string[] = [];
  const seenHomes = new Set<string>();
  const addDescriptor = (stateHome: string) => {
    if (!stateHome || seenHomes.has(stateHome)) {
      return;
    }
    seenHomes.add(stateHome);
    descriptors.push(path.join(stateHome, 'opencode', 'service.json'));
  };

  try {
    const output = execFileSync('ps', ['eww', '-ax'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    for (const line of output.split('\n')) {
      if (!line.includes('opencode-cli') || !line.includes('serve')) {
        continue;
      }
      const stateHome = line.match(/XDG_STATE_HOME=(\S+)/)?.[1];
      if (stateHome) {
        addDescriptor(stateHome);
        continue;
      }
      const home = line.match(/(?:^|\s)HOME=(\S+)/)?.[1];
      if (home) {
        addDescriptor(path.join(home, '.local', 'state'));
      }
    }
  } catch {
    // Process discovery is best-effort; the fixed locations below still apply.
  }

  const home = os.homedir();
  addDescriptor(path.join(home, '.local', 'state'));
  addDescriptor(path.join(home, '.config'));
  try {
    for (const entry of readdirSync(path.join(home, '.opencode-profiles'))) {
      addDescriptor(path.join(home, '.opencode-profiles', entry, 'state'));
      addDescriptor(path.join(home, '.opencode-profiles', entry, 'config'));
    }
  } catch {
    // No profile directory; nothing more to add.
  }

  const configs: OpenCodeServerConfig[] = [];
  for (const descriptor of descriptors) {
    const config = readServiceDescriptor(descriptor);
    if (config) {
      configs.push(config);
    }
  }
  return configs;
}

/**
 * Resolves every OpenCode server CloudCLI should mirror.
 *
 * Explicit environment variables pin a single server. Otherwise the console's
 * advertised `opencode serve`, the desktop apps' v2 background services, and any
 * `opencode serve` discoverable through the process table are all included, so a
 * turn started on any of them reaches the phone. The v2 API is used against all
 * of them, because both 1.18 and 2.0 expose it.
 */
export function resolveServerConfigs(): OpenCodeServerConfig[] {
  const configuredUrl = process.env.OPENCODE_SERVER_URL?.trim();
  const configuredPassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (configuredUrl || configuredPassword) {
    return [{
      url: configuredUrl || DEFAULT_SERVER_URL,
      headers: buildAuthHeaders(process.env.OPENCODE_SERVER_USERNAME, configuredPassword),
    }];
  }

  const configs: OpenCodeServerConfig[] = [];
  const sharedUrl = readSharedOpenCodeServerUrl();
  if (sharedUrl) {
    configs.push({ url: sharedUrl, headers: {} });
  }
  configs.push(...discoverServiceServers());

  const discovered = discoverRunningServer();
  if (discovered.password) {
    configs.push({
      url: `http://127.0.0.1:${discovered.port ?? '4096'}`,
      headers: buildAuthHeaders(process.env.OPENCODE_SERVER_USERNAME, discovered.password),
    });
  }

  const unique = new Map<string, OpenCodeServerConfig>();
  for (const config of configs) {
    if (!unique.has(config.url)) {
      unique.set(config.url, config);
    }
  }
  if (unique.size === 0) {
    unique.set(DEFAULT_SERVER_URL, { url: DEFAULT_SERVER_URL, headers: {} });
  }
  return [...unique.values()];
}

/** The primary server, used by callers that mirror a single instance. */
export function resolveServerConfig(): OpenCodeServerConfig {
  return resolveServerConfigs()[0];
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
 */
function registerPendingQuestion(
  requestId: string,
  sessionId: string,
  questions: OpenCodeQuestion[],
  serverUrl: string,
  directory?: string,
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
    receivedAt: new Date(),
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
    ?? readString(readRecord(properties?.part)?.sessionID);
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
    broadcastInteractionSettled(entry.appSessionId, entry.sessionId, permissionId, 'permission_resolved');
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
    for (const providerSessionId of Object.keys(readRecord(activeResult[0].value.data) ?? {})) {
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

  // Pending approvals/questions, reconciled per directory.
  const directories = new Set<string | undefined>([undefined, ...sessionDirectories.values()]);
  for (const session of sessionsDb.getAllSessions()) {
    if (session.provider === PROVIDER && session.project_path) {
      directories.add(session.project_path);
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
          broadcastInteractionSettled(entry.appSessionId, entry.sessionId, id, 'permission_cancelled');
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
}

async function runEventLoop(server: OpenCodeServer, signal: AbortSignal): Promise<void> {
  let retryDelay = INITIAL_RETRY_DELAY_MS;
  while (!signal.aborted) {
    try {
      await syncStatusSnapshot(server, signal);
      // The v2 event stream carries every project's events, including the
      // location needed to find and answer each prompt.
      const { stream } = await server.client.v2.event.subscribe({ signal, sseMaxRetryAttempts: 1 });
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
    const options = { throwOnError: true as const };
    resolvingInteractions.add(requestId);
    const request = server.client.v2.session.permission.reply(
      { sessionID: entry.sessionId, requestID: requestId, reply, message: decision.message },
      options,
    );
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
  const server = findServer(entry.serverUrl);
  if (!server) {
    return;
  }

  resolvingInteractions.add(entry.requestId);
  const options = { throwOnError: true as const };
  const answers = buildQuestionAnswers(entry, decision);
  const request = decision.allow
    ? server.client.v2.session.question.reply(
      { sessionID: entry.sessionId, requestID: entry.requestId, questionV2Reply: { answers } },
      options,
    )
    : server.client.v2.session.question.reject(
      { sessionID: entry.sessionId, requestID: entry.requestId },
      options,
    );

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
