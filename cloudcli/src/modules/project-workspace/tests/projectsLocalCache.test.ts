import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import { readCachedProjects, writeCachedProjects } from '@/modules/project-workspace/utils/projectsLocalCache';

const buildSession = (index: number): ProjectSession => ({
  id: `session-${index}`,
  summary: `Session ${index}`,
});

const buildProject = (sessions: ProjectSession[]): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions,
  sessionMeta: { hasMore: false, total: sessions.length },
});

beforeEach(() => {
  localStorage.clear();
});

test('a written snapshot is readable for the same provider only', () => {
  const project = buildProject([buildSession(1)]);
  writeCachedProjects('opencode', [project]);

  assert.deepEqual(readCachedProjects('opencode')[0]?.projectId, 'project-1');
  assert.deepEqual(readCachedProjects('claude'), []);
});

test('sessions per project are capped so one project cannot exhaust the quota', () => {
  const sessions = Array.from({ length: 150 }, (_, index) => buildSession(index));
  writeCachedProjects('opencode', [buildProject(sessions)]);

  assert.equal(readCachedProjects('opencode')[0]?.sessions?.length, 100);
});

test('a corrupt snapshot is ignored instead of crashing the renderer', () => {
  localStorage.setItem('cloudcli-projects-cache-v1-opencode', '{not json');
  assert.deepEqual(readCachedProjects('opencode'), []);
});

test('a snapshot written under another provider is ignored', () => {
  writeCachedProjects('opencode', [buildProject([{ ...buildSession(1), __provider: 'codex' }])]);
  assert.deepEqual(readCachedProjects('opencode'), []);
});

test('an empty snapshot clears the previous cache so deletions do not revive', () => {
  writeCachedProjects('opencode', [buildProject([buildSession(1)])]);
  assert.equal(readCachedProjects('opencode').length, 1);

  writeCachedProjects('opencode', []);

  assert.deepEqual(readCachedProjects('opencode'), []);
  assert.equal(localStorage.getItem('cloudcli-projects-cache-v1-opencode'), null);
});
