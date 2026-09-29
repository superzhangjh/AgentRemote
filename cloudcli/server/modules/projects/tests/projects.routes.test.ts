import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import projectsRouter from '@/modules/projects/projects.routes.js';
import { AppError } from '@/shared/utils.js';

test('project creation routes require a supported provider', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(error instanceof AppError ? error.statusCode : 500).json({
      code: error instanceof AppError ? error.code : 'UNKNOWN_ERROR',
    });
  });

  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}/api/projects`;

    const createWithoutProvider = await fetch(`${baseUrl}/create-project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/project' }),
    });
    assert.equal(createWithoutProvider.status, 400);
    assert.equal((await createWithoutProvider.json() as { code: string }).code, 'PROVIDER_REQUIRED');

    const createWithUnknownProvider = await fetch(`${baseUrl}/create-project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/project', provider: 'unknown' }),
    });
    assert.equal(createWithUnknownProvider.status, 400);
    assert.equal((await createWithUnknownProvider.json() as { code: string }).code, 'UNSUPPORTED_PROVIDER');

    const cloneWithoutProvider = await fetch(`${baseUrl}/clone-progress?path=/workspace&githubUrl=https://example.com/repo.git`);
    assert.match(await cloneWithoutProvider.text(), /provider is required/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
