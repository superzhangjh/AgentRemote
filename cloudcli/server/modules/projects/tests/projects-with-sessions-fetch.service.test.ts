import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

test('empty projects appear only under their selected provider', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-provider-list-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

  try {
    await initializeDatabase();
    projectsDb.createProjectPath('/workspace/codex-project', 'Codex project', 'codex');
    projectsDb.createProjectPath('/workspace/claude-project', 'Claude project', 'claude');
    projectsDb.createProjectPath('/workspace/legacy-project', 'Legacy project');

    const codexProjects = await getProjectsWithSessions({ skipSynchronization: true, provider: 'codex' });
    const claudeProjects = await getProjectsWithSessions({ skipSynchronization: true, provider: 'claude' });

    assert.deepEqual(codexProjects.map((project) => project.displayName), ['Codex project']);
    assert.equal(codexProjects[0]?.provider, 'codex');
    assert.deepEqual(claudeProjects.map((project) => project.displayName), ['Claude project', 'Legacy project']);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
