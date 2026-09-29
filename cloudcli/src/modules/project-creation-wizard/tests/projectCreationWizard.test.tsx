import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import ProjectCreationWizard from '@/modules/project-creation-wizard/ProjectCreationWizard';

const { createProjectRequest, cloneWorkspaceWithProgress, writeSelectedProvider } = vi.hoisted(() => ({
  createProjectRequest: vi.fn(async (_payload: unknown) => ({ projectId: 'created' })),
  cloneWorkspaceWithProgress: vi.fn(async (_payload: unknown) => ({ projectId: 'cloned' })),
  writeSelectedProvider: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/selectedProvider', () => ({ writeSelectedProvider }));
vi.mock('@/modules/project-creation-wizard/utils/workspaceApi', () => ({
  browseFilesystemFolders: vi.fn(async () => ({ path: '/work/new', suggestions: [] })),
  fetchGithubTokenCredentials: vi.fn(async () => []),
  createProjectRequest,
  cloneWorkspaceWithProgress,
}));

beforeEach(() => vi.clearAllMocks());

test('project creation requires an Agent and sends its name and Agent to the API', async () => {
  const onProjectCreated = vi.fn();
  render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={onProjectCreated} />);

  fireEvent.change(screen.getByPlaceholderText('projectWizard.step2.projectNamePlaceholder'), {
    target: { value: 'New project' },
  });
  fireEvent.change(screen.getByPlaceholderText('/path/to/project/workspace'), {
    target: { value: '/work/new' },
  });
  fireEvent.click(screen.getByText('projectWizard.buttons.next'));
  assert.ok(screen.getByText('projectWizard.errors.selectAgent'));
  assert.equal(createProjectRequest.mock.calls.length, 0);

  fireEvent.change(screen.getByLabelText('projectWizard.step2.agent'), {
    target: { value: 'codex' },
  });
  fireEvent.click(screen.getByText('projectWizard.buttons.next'));
  fireEvent.click(screen.getByText('projectWizard.buttons.createProject'));

  await waitFor(() => assert.equal(createProjectRequest.mock.calls.length, 1));
  assert.deepEqual(createProjectRequest.mock.calls[0][0], {
    path: '/work/new',
    customName: 'New project',
    provider: 'codex',
  });
  assert.deepEqual(writeSelectedProvider.mock.calls[0], ['codex']);
  assert.equal(onProjectCreated.mock.calls.length, 1);
  assert.equal(cloneWorkspaceWithProgress.mock.calls.length, 0);
});

test('cloning sends the chosen name and Agent', async () => {
  render(<ProjectCreationWizard onClose={vi.fn()} />);

  fireEvent.change(screen.getByPlaceholderText('projectWizard.step2.projectNamePlaceholder'), {
    target: { value: 'Cloned project' },
  });
  fireEvent.change(screen.getByPlaceholderText('/path/to/project/workspace'), {
    target: { value: '/work/clone' },
  });
  fireEvent.change(screen.getByLabelText('projectWizard.step2.agent'), {
    target: { value: 'opencode' },
  });
  fireEvent.change(screen.getByPlaceholderText('https://github.com/username/repository'), {
    target: { value: 'https://github.com/example/repo' },
  });
  fireEvent.click(screen.getByText('projectWizard.buttons.next'));
  fireEvent.click(screen.getByText('projectWizard.buttons.createProject'));

  await waitFor(() => assert.equal(cloneWorkspaceWithProgress.mock.calls.length, 1));
  assert.deepEqual(cloneWorkspaceWithProgress.mock.calls[0][0], {
    workspacePath: '/work/clone',
    customName: 'Cloned project',
    provider: 'opencode',
    githubUrl: 'https://github.com/example/repo',
    tokenMode: 'stored',
    selectedGithubToken: '',
    newGithubToken: '',
  });
});
