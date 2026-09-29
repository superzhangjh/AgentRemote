import assert from 'node:assert/strict';

import { test } from 'vitest';

import { filterProjects } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { Project } from '@/shared/types';

const projects: Project[] = [
  {
    projectId: 'one',
    displayName: 'Workspace',
    fullPath: '/work/one',
    sessions: [
      { id: 'a', summary: 'Fix login' },
      { id: 'b', summary: 'Add dashboard' },
    ],
  },
  {
    projectId: 'two',
    displayName: 'Another',
    fullPath: '/work/two',
    sessions: [{ id: 'c', summary: 'Release notes' }],
  },
];

test('unified project search finds a conversation and keeps it under its project', () => {
  const matches = filterProjects(projects, 'login');
  assert.deepEqual(matches.map((project) => project.projectId), ['one']);
  assert.deepEqual(matches[0].sessions?.map((session) => session.id), ['a']);
  assert.equal(matches[0].sessionMeta?.total, 1);
});

test('matching a project name keeps all its conversations', () => {
  assert.equal(filterProjects(projects, 'Workspace')[0], projects[0]);
});
