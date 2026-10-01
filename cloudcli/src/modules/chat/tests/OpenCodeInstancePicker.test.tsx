import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { test, vi } from 'vitest';

import OpenCodeInstancePicker from '@/modules/chat/composer/OpenCodeInstancePicker';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof requestAnimationFrame;
}

test('OpenCode selection and naming stay inside the WebUI dialog', () => {
  const onSelect = vi.fn();
  const onRename = vi.fn();
  const servers = [
    { id: 'a', label: 'A very long OpenCode account name that should fit in the dialog', url: 'http://127.0.0.1:4101' },
    { id: 'b', label: 'Account B', url: 'http://127.0.0.1:4102' },
  ];
  const { rerender } = render(
    <OpenCodeInstancePicker servers={servers} selectedId="a" onSelect={onSelect} onRename={onRename} />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'input.openCodeInstance' }));
  const dialog = screen.getByRole('dialog');
  assert.ok(within(dialog).getByText(servers[0].label));
  fireEvent.click(screen.getByRole('button', { name: /Account B/ }));
  assert.equal(onSelect.mock.calls[0][0], 'b');

  rerender(<OpenCodeInstancePicker servers={servers} selectedId="b" onSelect={onSelect} onRename={onRename} />);
  fireEvent.change(screen.getByLabelText('input.nameOpenCodeInstance'), { target: { value: 'Second account' } });
  fireEvent.click(screen.getByRole('button', { name: 'input.saveOpenCodeInstanceName' }));
  assert.deepEqual(onRename.mock.calls[0], ['b', 'Second account']);
});
