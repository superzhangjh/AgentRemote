import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import { AppError } from '@/shared/utils.js';

/**
 * Minimal JSON-RPC client for `codex app-server`.
 *
 * Codex's SDK wraps `codex exec`, while `app-server` exposes the native
 * thread, turn, model, and fork APIs over JSON-RPC. Using app-server for turns
 * makes threads created from CloudCLI visible to other Codex clients.
 */

/** How long a single request may take before the child is killed. */
const REQUEST_TIMEOUT_MS = 30_000;

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type AppServerConnection = {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  respond(id: number | string, result: unknown): void;
  onMessage(listener: (message: JsonRpcMessage) => void): () => void;
};

/**
 * One fork of a Codex thread.
 *
 * `path` is returned by the server rather than reconstructed: the rollout
 * lands in today's date directory, not next to the file it was copied from,
 * so deriving it from the source path would be wrong roughly every day.
 */
export type CodexThreadFork = {
  threadId: string;
  path: string;
};

/**
 * Resolves the `codex` launcher shipped in node_modules.
 *
 * Deliberately not the `codex` on PATH: a machine can have a second, older
 * install, and the protocol this speaks is only guaranteed against the
 * version this package depends on.
 */
function resolveCodexLauncher(): string {
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve('@openai/codex/bin/codex.js');
  } catch {
    throw new AppError('The Codex CLI package is not installed, so Codex conversations cannot be branched.', {
      code: 'CODEX_APP_SERVER_UNAVAILABLE',
      statusCode: 501,
    });
  }
}

/**
 * Runs one exchange against a freshly spawned `codex app-server`.
 *
 * A process per operation rather than a pooled long-lived one: the handshake
 * costs a fraction of a second, forking happens at most once per user action,
 * and a shared child would need lifecycle handling — restarts, back-pressure,
 * a crash taking every pending fork with it — for no measurable gain next to
 * the model turn that follows.
 */
async function withAppServer<T>(
  run: (connection: AppServerConnection) => Promise<T>,
): Promise<T> {
  const launcher = resolveCodexLauncher();
  const child = spawn(process.execPath, [launcher, 'app-server'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // The server logs sandbox and skill warnings to stderr on every start. They
  // are not failures and drowning the app log in them helps nobody, so stderr
  // is only kept around to explain a spawn that dies.
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  let nextRequestId = 1;
  const pending = new Map<number | string, (response: JsonRpcMessage) => void>();
  const listeners = new Set<(message: JsonRpcMessage) => void>();
  let exitReason: string | null = null;

  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // Server-to-client notifications and any non-JSON banner are not
      // replies to anything this client asked for.
      return;
    }
    if (message.method) {
      for (const listener of listeners) {
        listener(message);
      }
      return;
    }
    if (message.id === undefined) {
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const failPending = (reason: string) => {
    exitReason = reason;
    for (const resolve of pending.values()) {
      resolve({ error: { message: reason } });
    }
    pending.clear();
    for (const listener of listeners) {
      listener({ method: '$appServerExited', params: { reason } });
    }
  };

  child.on('error', (error) => failPending(error.message));
  child.on('exit', (code, signal) => {
    failPending(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
  });
  // A child that dies mid-request leaves its pipes broken, and the next write
  // raises EPIPE on the stream rather than at the call site. Without a
  // listener that is an unhandled 'error' event, which takes the whole server
  // down over one failed fork.
  child.stdin?.on('error', (error) => failPending(error.message));
  child.stdout?.on('error', (error) => failPending(error.message));
  child.stderr?.on('error', () => {});

  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (exitReason) {
        reject(new AppError(`Codex app-server is not running: ${exitReason}`, {
          code: 'CODEX_APP_SERVER_UNAVAILABLE',
          statusCode: 502,
        }));
        return;
      }

      const id = nextRequestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppError(`Codex app-server did not answer "${method}" within ${REQUEST_TIMEOUT_MS}ms.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT',
          statusCode: 504,
        }));
      }, REQUEST_TIMEOUT_MS);

      pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) {
          reject(new AppError(response.error.message || `Codex app-server rejected "${method}".`, {
            code: 'CODEX_APP_SERVER_ERROR',
            statusCode: 502,
            details: { method, rpcCode: response.error.code },
          }));
          return;
        }
        resolve(response.result);
      });

      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const connection: AppServerConnection = {
    request,
    notify(method, params) {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    respond(id, result) {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  try {
    // Turn pagination is gated behind the experimental API capability and lets
    // native activity checks inspect only the newest turn.
    await request('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
      capabilities: { experimentalApi: true },
    });
    connection.notify('initialized', {});

    return await run(connection);
  } catch (error) {
    if (error instanceof AppError && exitReason) {
      throw new AppError(`${error.message}${stderr ? ` — ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`, {
        code: error.code,
        statusCode: error.statusCode,
      });
    }
    throw error;
  } finally {
    reader.close();
    child.kill();
  }
}

/** Used by Codex runtime, model, and session providers for native app-server operations. */
export const codexAppServer = {
  /** Reads the model catalogue supported by the installed Codex CLI. */
  async listModels(): Promise<unknown[]> {
    return withAppServer(async (connection) => {
      const result = await connection.request('model/list', {}) as { data?: unknown } | undefined;
      return Array.isArray(result?.data) ? result.data : [];
    });
  },

  /**
   * Starts or resumes a native app-server thread and streams one turn until
   * Codex reports a terminal turn notification. Keeping the server alive for
   * the whole turn is what lets it deliver item deltas and interactive
   * approval requests over the same connection.
   */
  async runTurn(input: {
    threadId?: string | null;
    cwd: string;
    model?: string;
    effort?: string;
    fastMode?: boolean;
    sandboxMode: 'workspace-write' | 'danger-full-access';
    approvalPolicy: 'on-request' | 'never';
    turnInput: unknown[];
    signal: AbortSignal;
    onThread(thread: { id: string; path?: string }): void;
    onNotification(message: JsonRpcMessage): void;
    onServerRequest(message: JsonRpcMessage): Promise<unknown>;
  }): Promise<void> {
    return withAppServer(async (connection) => {
      let threadId = input.threadId || '';
      let turnId = '';
      let interruptRequested = false;
      let terminal = false;
      let terminalError: Error | null = null;
      let resolveTerminal!: () => void;
      const finished = new Promise<void>((resolve) => { resolveTerminal = resolve; });

      const interrupt = () => {
        if (terminal) {
          return;
        }
        if (!threadId || !turnId) {
          interruptRequested = true;
          return;
        }
        void connection.request('turn/interrupt', { threadId, turnId }).catch((error) => {
          // A failed interrupt must release the caller; withAppServer will
          // close this process in its finally block instead of hanging here.
          console.warn('[Codex] Failed to interrupt app-server turn:', error);
          terminal = true;
          resolveTerminal();
        });
      };
      const abortHandler = () => interrupt();
      input.signal.addEventListener('abort', abortHandler, { once: true });

      const unsubscribe = connection.onMessage((message) => {
        if (!message.method) {
          return;
        }
        if (message.method === '$appServerExited') {
          terminalError = new AppError('Codex app-server exited during the turn.', {
            code: 'CODEX_APP_SERVER_UNAVAILABLE',
            statusCode: 502,
          });
          terminal = true;
          resolveTerminal();
          return;
        }
        const params = message.params as { threadId?: string; turnId?: string; turn?: { id?: string; status?: string } } | undefined;
        if (params?.threadId && threadId && params.threadId !== threadId) {
          return;
        }
        if (message.id !== undefined) {
          void input.onServerRequest(message).then(
            (result) => connection.respond(message.id as number | string, result),
            (error) => {
              console.warn('[Codex] Failed to handle app-server request:', error);
              connection.respond(message.id as number | string, {});
            },
          );
          return;
        }

        if (message.method === 'turn/started' && params?.turn?.id) {
          turnId = params.turn.id;
          if (interruptRequested) {
            interrupt();
          }
        }

        input.onNotification(message);
        if (
          message.method === 'turn/failed'
          || (message.method === 'turn/completed' && params?.turn?.status !== 'inProgress')
        ) {
          terminal = true;
          resolveTerminal();
        }
      });

      try {
        const threadMethod = threadId ? 'thread/resume' : 'thread/start';
        const threadParams = {
          cwd: input.cwd,
          ...(threadId ? { threadId } : {}),
          ...(!threadId ? { threadSource: 'appServer' } : {}),
          ...(!threadId ? { ephemeral: false } : {}),
          ...(input.model ? { model: input.model } : {}),
          config: { service_tier: input.fastMode ? 'fast' : 'default' },
          sandbox: input.sandboxMode,
          approvalPolicy: input.approvalPolicy,
        };
        const threadResult = await connection.request(threadMethod, threadParams) as {
          thread?: { id?: unknown; path?: unknown };
        } | undefined;
        threadId = typeof threadResult?.thread?.id === 'string' ? threadResult.thread.id : threadId;
        const path = typeof threadResult?.thread?.path === 'string' ? threadResult.thread.path : undefined;
        if (!threadId) {
          throw new AppError('Codex app-server returned no thread id.', {
            code: 'CODEX_APP_SERVER_ERROR',
            statusCode: 502,
          });
        }
        input.onThread({ id: threadId, path });

        if (input.signal.aborted) {
          return;
        }

        const turnResult = await connection.request('turn/start', {
          threadId,
          cwd: input.cwd,
          input: input.turnInput,
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        }) as { turn?: { id?: unknown; status?: unknown } } | undefined;
        turnId = typeof turnResult?.turn?.id === 'string' ? turnResult.turn.id : turnId;
        if (input.signal.aborted || interruptRequested) {
          interrupt();
        }
        if (turnResult?.turn?.status && turnResult.turn.status !== 'inProgress') {
          terminal = true;
          resolveTerminal();
        }

        if (!terminal) {
          await finished;
        }
        if (terminalError) {
          throw terminalError;
        }
      } finally {
        unsubscribe();
        input.signal.removeEventListener('abort', abortHandler);
      }
    });
  },

  /** Reads Codex's native activity flag without hydrating the transcript. */
  async getThreadActivity(threadId: string): Promise<boolean> {
    return withAppServer(async (connection) => {
      const [threadResult, turnsResult] = await Promise.allSettled([
        connection.request('thread/read', { threadId }),
        connection.request('thread/turns/list', {
          threadId,
          limit: 1,
          sortDirection: 'desc',
        }),
      ]);
      const thread = threadResult.status === 'fulfilled'
        ? (threadResult.value as {
          thread?: { status?: { type?: unknown } };
        } | undefined)?.thread
        : undefined;
      const turns = turnsResult.status === 'fulfilled'
        ? (turnsResult.value as { data?: Array<{ status?: unknown }> } | undefined)?.data ?? []
        : [];
      if (thread?.status?.type === 'active' || turns[0]?.status === 'inProgress') {
        return true;
      }
      if (thread?.status?.type === 'idle' || (turnsResult.status === 'fulfilled' &&
        (!turns.length || ['completed', 'interrupted', 'failed'].includes(String(turns[0]?.status))))) {
        return false;
      }
      // notLoaded is local to this new app-server, not proof that another
      // Codex process is idle. Let the caller inspect the persisted lifecycle.
      throw new AppError('Codex thread activity is unavailable.', {
        code: 'CODEX_THREAD_ACTIVITY_UNAVAILABLE',
        statusCode: 503,
      });
    });
  },

  /**
   * Copies a thread into a new one that ends at `lastTurnId`, or copies the
   * whole thread when it is omitted.
   *
   * `lastTurnId` is inclusive of the turn it names, which is the same
   * convention the app's edit anchor uses ("the last row to keep").
   *
   * `cwd` decides the working directory recorded in the copy's `session_meta`,
   * and that field is what the session indexer keys a session's project off —
   * omitting it would file every fork under whatever directory this server
   * happens to be running from.
   */
  async forkThread(input: {
    threadId: string;
    lastTurnId?: string;
    cwd: string;
  }): Promise<CodexThreadFork> {
    return withAppServer(async (connection) => {
      const result = await connection.request('thread/fork', {
        threadId: input.threadId,
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }) as { thread?: { id?: unknown; path?: unknown } } | undefined;

      const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
      const path = typeof result?.thread?.path === 'string' ? result.thread.path : '';
      if (!threadId || !path) {
        throw new AppError('Codex reported a fork without a thread id or transcript path.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      // Confirmed rather than trusted: both callers are about to point a
      // database row at this file, and a row naming a transcript that is not
      // there is a session that can never be opened.
      try {
        await stat(path);
      } catch {
        throw new AppError('Codex reported a fork but wrote no transcript for it.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      return { threadId, path };
    });
  },
};
