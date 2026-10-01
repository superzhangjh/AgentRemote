import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { OpenCodeProviderAuth } from '@/modules/providers/list/opencode/opencode-auth.provider.js';

type StubServer = {
  url: string;
  close(): Promise<void>;
};

/** Minimal OpenCode HTTP server covering the health and provider endpoints. */
async function startServerStub(handlers: {
  health?: () => { status: number; body: unknown };
  providers?: () => { status: number; body: unknown };
}): Promise<StubServer> {
  const connections = new Set<import('node:net').Socket>();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (request.method === 'GET' && url.pathname === '/global/health') {
      const result = handlers.health?.() ?? { status: 200, body: { healthy: true, version: '1.0.0' } };
      send(result.status, result.body);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/provider') {
      const result = handlers.providers?.() ?? {
        status: 200,
        body: { all: [], default: {}, connected: ['opencode-go'] },
      };
      send(result.status, result.body);
      return;
    }

    send(404, {});
  });

  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      for (const socket of connections) {
        socket.destroy();
      }
      server.close(() => resolve());
    }),
  };
}

async function withServerEnv<T>(url: string, body: () => Promise<T>): Promise<T> {
  const previousUrl = process.env.OPENCODE_SERVER_URL;
  process.env.OPENCODE_SERVER_URL = url;
  try {
    return await body();
  } finally {
    if (previousUrl === undefined) delete process.env.OPENCODE_SERVER_URL;
    else process.env.OPENCODE_SERVER_URL = previousUrl;
  }
}

test('OpenCode auth reports credentials from the server provider list', async () => {
  const stub = await startServerStub({
    providers: () => ({ status: 200, body: { all: [], default: {}, connected: ['opencode-go', 'anthropic'] } }),
  });

  try {
    const status = await withServerEnv(stub.url, () => new OpenCodeProviderAuth().getStatus());
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'server');
    assert.equal(status.email, 'opencode-go, anthropic');
  } finally {
    await stub.close();
  }
});

test('OpenCode auth reports not configured when no provider is connected', async () => {
  const stub = await startServerStub({
    providers: () => ({ status: 200, body: { all: [], default: {}, connected: [] } }),
  });

  try {
    const status = await withServerEnv(stub.url, () => new OpenCodeProviderAuth().getStatus());
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, false);
    assert.equal(status.error, 'OpenCode not configured');
  } finally {
    await stub.close();
  }
});

test('OpenCode auth reports not installed when the server is unreachable', async () => {
  const stub = await startServerStub({});
  await withServerEnv(stub.url, async () => {
    await stub.close();
    const status = await new OpenCodeProviderAuth().getStatus();
    assert.equal(status.installed, false);
    assert.equal(status.authenticated, false);
  });
});
