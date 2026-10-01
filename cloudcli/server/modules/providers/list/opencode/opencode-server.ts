import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import type { AnyRecord, OpenCodeServerConfig } from '@/shared/types.js';
import { readObjectRecord, resolveOpenCodeServerConfigs } from '@/shared/utils.js';

export type { OpenCodeServerConfig };

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

/** One OpenCode server plus a client bound to it. */
export type OpenCodeServer = {
  config: OpenCodeServerConfig;
  client: OpenCodeClient;
};

/** The primary server, used by callers that address a single instance. */
function resolveOpenCodeServerConfig(): OpenCodeServerConfig {
  return resolveOpenCodeServerConfigs()[0];
}

/** Used by the session service to validate a choice and by the runtime to honor it on every turn. */
export function findOpenCodeServerConfig(id: string): OpenCodeServerConfig | undefined {
  return resolveOpenCodeServerConfigs().find((config) => config.id === id);
}

/** Used by the runtime to resume older imported sessions that have no pinned server. */
export async function findOpenCodeSessionServerConfig(sessionId: string): Promise<OpenCodeServerConfig | undefined> {
  for (const { config, client } of createOpenCodeServerClients()) {
    try {
      await client.v2.session.get({ sessionID: sessionId }, { throwOnError: true });
      return config;
    } catch {
      // This instance does not own the session.
    }
  }
  return undefined;
}

/** Used by the providers route to show desktop accounts whose app is still open. */
export async function listOpenCodeServers(
  desktopProcesses?: string,
): Promise<Array<{ id: string; label: string; url: string }>> {
  let processTable = desktopProcesses;
  if (process.platform === 'darwin' && processTable === undefined) {
    try {
      processTable = execFileSync('ps', ['eww', '-ax'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    } catch {
      // A failed process scan should not make every account unavailable.
    }
  }
  const defaultStateHome = path.join(os.homedir(), '.local', 'state');
  const visibleConfigs = resolveOpenCodeServerConfigs().filter((config) => {
    if (!processTable || !config.desktopStateHome) return true;
    return processTable.split('\n').some((line) => {
      if (!/\/Contents\/MacOS\/OpenCode(?:\s|$)/.test(line)) return false;
      const stateHome = line.match(/(?:^|\s)XDG_STATE_HOME=(\S+)/)?.[1];
      return stateHome === config.desktopStateHome
        || (!stateHome && config.desktopStateHome === defaultStateHome);
    });
  });
  const servers = await Promise.all(visibleConfigs.map(async (config) => {
    try {
      const result = await createClient(config).v2.session.active({
        throwOnError: true,
        signal: AbortSignal.timeout(3000),
      });
      if (!readObjectRecord(readObjectRecord(result.data)?.data)) return null;
      return { id: config.id ?? config.url, label: config.label ?? 'OpenCode', url: config.url };
    } catch {
      return null;
    }
  }));
  return servers
    .filter((server): server is NonNullable<typeof server> => server !== null)
    // A desktop service uses that app's own login. Offer those first so a
    // separate console-managed CLI does not silently become the phone default.
    .sort((left, right) => Number(right.id.startsWith('service:')) - Number(left.id.startsWith('service:')));
}

/** Creates one SDK client bound to the given server configuration. */
function createClient(config: OpenCodeServerConfig): OpenCodeClient {
  return createOpencodeClient({ baseUrl: config.url, headers: config.headers });
}

/**
 * Creates an OpenCode SDK client for the primary server.
 *
 * Consumed by the OpenCode runtime (one client per run), the model catalog, and
 * the token-usage reader. Each caller owns its client so it controls the
 * connection lifetime.
 */
export function createOpenCodeServerClient(
  config: OpenCodeServerConfig = resolveOpenCodeServerConfig(),
): OpenCodeClient {
  return createClient(config);
}

/**
 * Creates a client for every OpenCode server CloudCLI can discover.
 *
 * Consumed by the session synchronizer and the session reader, which must cover
 * sessions started on any server (the console-managed `opencode serve` or a
 * desktop app's background service) rather than only the primary one.
 */
export function createOpenCodeServerClients(): OpenCodeServer[] {
  return resolveOpenCodeServerConfigs().map((config) => ({ config, client: createClient(config) }));
}

/**
 * Reads one session's info from whichever discovered server owns it.
 *
 * The v2 endpoint is tried first, then the 1.18 compatibility endpoint; both
 * return the same `{ model, tokens, title, ... }` fields. Returns null when no
 * server knows the session. Consumed by the model-catalog and token-usage
 * readers, which otherwise could not tell which of several servers holds a
 * session.
 */
export async function readOpenCodeSessionInfo(
  providerSessionId: string,
  directory?: string,
): Promise<AnyRecord | null> {
  for (const { client } of createOpenCodeServerClients()) {
    try {
      const result = await client.v2.session.get(
        { sessionID: providerSessionId },
        { throwOnError: true },
      );
      // v2 wraps the body once more (`{ data: { data: info } }`).
      const info = readObjectRecord(readObjectRecord(result.data)?.data);
      if (info) {
        return info;
      }
    } catch {
      // Fall through to the compatibility endpoint below.
    }

    try {
      const result = await client.session.get(
        { sessionID: providerSessionId, directory },
        { throwOnError: true },
      );
      const info = readObjectRecord(result.data);
      if (info) {
        return info;
      }
    } catch {
      // This server does not know the session; try the next.
    }
  }

  return null;
}
