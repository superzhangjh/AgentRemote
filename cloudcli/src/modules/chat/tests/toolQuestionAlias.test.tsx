import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import {
  formatToolDisplayName,
  getToolConfig,
  isDismissedQuestionResult,
  resolveCanonicalToolName,
  shouldHideToolResult,
} from '@/modules/chat/tools/configs/toolConfigs';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

test('the native OpenCode question tool renders through the shared question card', () => {
  assert.equal(resolveCanonicalToolName('question'), 'AskUserQuestion');
  assert.equal(formatToolDisplayName('question'), 'Question');
  assert.equal(getToolConfig('question'), getToolConfig('AskUserQuestion'));

  render(
    <ToolRenderer
      toolName="question"
      toolInput={{ questions: [{ header: 'Next', question: 'Continue?', options: [{ label: 'Yes' }] }] }}
      mode="input"
    />,
  );

  assert.ok(screen.getAllByText('Next').length > 0);
});

test('a dismissed question reads as skipped and hides the raw error text', () => {
  const dismissed = { content: 'The user dismissed this question', isError: true };

  assert.equal(isDismissedQuestionResult('question', dismissed), true);
  assert.equal(shouldHideToolResult('question', dismissed), true);
  // Only the ask-the-user tools are softened this way.
  assert.equal(isDismissedQuestionResult('Bash', dismissed), false);
  assert.equal(shouldHideToolResult('Bash', { content: 'exit 1', isError: true }), false);
});

test('an answered question card shows the chosen label in its header', () => {
  render(
    <ToolRenderer
      toolName="question"
      toolInput={{
        questions: [{ header: 'Next', question: 'Continue?', options: [{ label: 'Yes' }] }],
        answers: { 'Continue?': 'Yes' },
      }}
      mode="input"
    />,
  );

  assert.ok(screen.getByText('Next — Yes'));
});

test('a question card stays expanded on compact mobile layouts', () => {
  render(
    <ToolRenderer
      toolName="question"
      compactToolDetails
      toolInput={{ questions: [{ header: 'Next', question: 'Continue?', options: [{ label: 'Yes' }] }] }}
      mode="input"
    />,
  );

  // The question body only renders while the section is open.
  assert.ok(screen.getAllByText('Continue?').length > 0);
});
