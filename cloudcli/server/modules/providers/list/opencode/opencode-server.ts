import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import { readSharedOpenCodeServerUrl } from '@/shared/utils.js';

/**
 * Address and auth headers for the OpenCode server the provider talks to.
 */
export type OpenCodeServerConfig = {
  url: string;
  headers: Record<string, string>;
};

/** The loopback port `opencode serve` binds when nothing else is configured. */
const DEFAULT_OPENCODE_SERVER_URL = 'http://127.0.0.1:4096';

/**
 * Builds the HTTP Basic auth header OpenCode uses when
 * `OPENCODE_SERVER_PASSWORD` is set. The username defaults to `opencode`,
 * matching the CLI, and the username is only consulted alongside a password.
 */
function buildOpenCodeAuthHeaders(
  username: string | undefined,
  password: string | undefined,
): Record<string, string> {
  if (!password) {
    return {};
  }

  const token = Buffer.from(`${username?.trim() || 'opencode'}:${password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${token}` };
}

/**
 * Resolves the OpenCode server the provider connects to.
 *
 * Explicit `OPENCODE_SERVER_URL` / `OPENCODE_SERVER_PASSWORD` environment
 * variables win, then the AgentRemote console's shared descriptor file, and
 * only then the CLI's conventional loopback port with no auth. Consumed by the
 * OpenCode runtime, session reader, and session synchronizer.
 */
export function resolveOpenCodeServerConfig(): OpenCodeServerConfig {
  const configuredUrl = process.env.OPENCODE_SERVER_URL?.trim();
  const configuredPassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (configuredUrl || configuredPassword) {
    return {
      url: configuredUrl || DEFAULT_OPENCODE_SERVER_URL,
      headers: buildOpenCodeAuthHeaders(process.env.OPENCODE_SERVER_USERNAME, configuredPassword),
    };
  }

  const sharedUrl = readSharedOpenCodeServerUrl();
  if (sharedUrl) {
    return { url: sharedUrl, headers: {} };
  }

  return { url: DEFAULT_OPENCODE_SERVER_URL, headers: {} };
}

/**
 * Creates an OpenCode SDK client for a resolved server configuration.
 *
 * Each caller owns its client so it controls the connection lifetime; the
 * OpenCode runtime creates one per run, while the long-lived `opencode-bridge`
 * keeps its own because it also performs process-table discovery.
 */
export function createOpenCodeServerClient(
  config: OpenCodeServerConfig = resolveOpenCodeServerConfig(),
) {
  return createOpencodeClient({ baseUrl: config.url, headers: config.headers });
}
