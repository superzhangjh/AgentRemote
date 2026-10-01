import { createOpenCodeServerClient } from '@/modules/providers/list/opencode/opencode-server.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readStringArray } from '@/shared/utils.js';

/**
 * Auth status for OpenCode, read through the server SDK.
 *
 * The server owns both installation and credentials: a successful health probe
 * means an OpenCode server is running, and `provider.list().connected` names
 * every provider it can route to (including ones configured only through
 * environment API keys). Reading the credentials file directly, as this adapter
 * used to, missed env-key installs and duplicated the server's own view.
 */
export class OpenCodeProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const client = createOpenCodeServerClient();

    try {
      const health = await client.global.health({ throwOnError: true });
      if (readObjectRecord(health.data)?.healthy !== true) {
        return notInstalled('OpenCode server is not healthy');
      }
    } catch {
      return notInstalled('OpenCode server is not reachable');
    }

    try {
      const result = await client.provider.list({}, { throwOnError: true });
      const connected = readStringArray(readObjectRecord(result.data)?.connected) ?? [];
      if (connected.length > 0) {
        return {
          installed: true,
          provider: 'opencode',
          authenticated: true,
          // The field is display-only in the app; listing the connected
          // providers is more useful than a single credential source.
          email: connected.join(', '),
          method: 'server',
        };
      }
    } catch (error) {
      return {
        installed: true,
        provider: 'opencode',
        authenticated: false,
        email: null,
        method: null,
        error: error instanceof Error ? error.message : 'Failed to read OpenCode providers',
      };
    }

    return {
      installed: true,
      provider: 'opencode',
      authenticated: false,
      email: null,
      method: null,
      error: 'OpenCode not configured',
    };
  }
}

function notInstalled(error: string): ProviderAuthStatus {
  return {
    installed: false,
    provider: 'opencode',
    authenticated: false,
    email: null,
    method: null,
    error,
  };
}
