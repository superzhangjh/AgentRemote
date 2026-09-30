import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// jsdom does not guarantee requestAnimationFrame; the panel's mount animation
// uses it during the first effect, so provide a synchronous shim.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof requestAnimationFrame;
}

function decisionAnswers(onDecision: ReturnType<typeof vi.fn>): Record<string, string> {
  const [, decision] = onDecision.mock.calls[0] as [string, { updatedInput: { answers: Record<string, string> } }];
  return decision.updatedInput.answers;
}

test('clicking a single-select option and submitting records the chosen label', () => {
  const onDecision = vi.fn();
  render(
    <AskUserQuestionPanel
      request={{
        requestId: 'req-1',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which language?',
              header: 'Language',
              options: [{ label: 'TypeScript' }, { label: 'Python' }],
            },
          ],
        },
      }}
      onDecision={onDecision}
    />,
  );

  fireEvent.click(screen.getByText('TypeScript'));
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));

  assert.equal(onDecision.mock.calls.length, 1);
  assert.equal(onDecision.mock.calls[0][0], 'req-1');
  assert.deepEqual(decisionAnswers(onDecision), { 'Which language?': 'TypeScript' });
  assert.equal((onDecision.mock.calls[0][1] as { allow: boolean }).allow, true);
});

test('a multi-select question joins multiple clicked labels with ", "', () => {
  const onDecision = vi.fn();
  render(
    <AskUserQuestionPanel
      request={{
        requestId: 'req-2',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Pick some?',
              multiSelect: true,
              options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
            },
          ],
        },
      }}
      onDecision={onDecision}
    />,
  );

  fireEvent.click(screen.getByText('A'));
  fireEvent.click(screen.getByText('C'));
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));

  assert.deepEqual(decisionAnswers(onDecision), { 'Pick some?': 'A, C' });
});

test('the Other option submits the typed custom answer', () => {
  const onDecision = vi.fn();
  render(
    <AskUserQuestionPanel
      request={{
        requestId: 'req-3',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            { question: 'Which language?', options: [{ label: 'TypeScript' }, { label: 'Python' }] },
          ],
        },
      }}
      onDecision={onDecision}
    />,
  );

  fireEvent.click(screen.getByText('Other...'));
  fireEvent.change(screen.getByPlaceholderText('chat:misc.typeAnswer'), {
    target: { value: 'Rust' },
  });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));

  assert.deepEqual(decisionAnswers(onDecision), { 'Which language?': 'Rust' });
});

test('Skip submits an empty answer map', () => {
  const onDecision = vi.fn();
  render(
    <AskUserQuestionPanel
      request={{
        requestId: 'req-4',
        toolName: 'AskUserQuestion',
        input: {
          questions: [{ question: 'Which language?', options: [{ label: 'TypeScript' }] }],
        },
      }}
      onDecision={onDecision}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /skip/i }));

  assert.deepEqual(decisionAnswers(onDecision), {});
});
