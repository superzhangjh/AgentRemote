import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';

type OpenCodeInstance = { id: string; label: string; url: string };

type OpenCodeInstancePickerProps = {
  servers: OpenCodeInstance[];
  selectedId: string;
  error?: string | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, label: string) => void;
};

/** Lets a new chat choose and name its OpenCode instance within the WebUI. */
export default function OpenCodeInstancePicker({
  servers,
  selectedId,
  error,
  disabled,
  onSelect,
  onRename,
}: OpenCodeInstancePickerProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const selected = servers.find((server) => server.id === selectedId);

  const openPicker = () => {
    setName(selected?.label ?? '');
    setOpen(true);
  };

  const saveName = () => {
    const nextName = name.trim();
    if (selected && nextName) onRename(selected.id, nextName);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={openPicker}
        disabled={disabled || servers.length === 0}
        className="mb-2 flex w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-3 py-2 text-left text-sm text-foreground disabled:opacity-60"
        aria-label={t('input.openCodeInstance')}
        title={selected?.label ?? error ?? t('input.noOpenCodeInstances')}
      >
        <span className="shrink-0 text-muted-foreground">{t('input.openCodeInstance')}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{selected?.label ?? error ?? t('input.noOpenCodeInstances')}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md p-5">
        <DialogTitle>{t('input.openCodeInstanceHelp')}</DialogTitle>
        <p className="text-base font-semibold">{t('input.openCodeInstanceHelp')}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t('input.openCodeInstanceNote')}</p>
        <div className="mt-4 max-h-[42dvh] space-y-2 overflow-y-auto">
          {servers.map((server) => (
            <button
              key={server.id}
              type="button"
              onClick={() => { onSelect(server.id); setName(server.label); }}
              aria-pressed={server.id === selectedId}
              className={`flex w-full min-w-0 items-start gap-3 rounded-lg border p-3 text-left ${server.id === selectedId ? 'border-primary bg-primary/10' : 'border-border'}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-medium">{server.label}</span>
                <span className="mt-1 block break-all text-xs text-muted-foreground">{server.url}</span>
              </span>
              {server.id === selectedId && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </button>
          ))}
        </div>

        {selected && (
          <div className="mt-4 space-y-2 border-t border-border pt-4">
            <label htmlFor="open-code-instance-name" className="text-sm font-medium">
              {t('input.nameOpenCodeInstance')}
            </label>
            <div className="flex gap-2">
              <Input
                id="open-code-instance-name"
                value={name}
                maxLength={32}
                onChange={(event) => setName(event.target.value)}
                className="min-w-0 flex-1"
              />
              <button
                type="button"
                onClick={saveName}
                disabled={!name.trim() || name.trim() === selected.label}
                className="shrink-0 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              >
                {t('input.saveOpenCodeInstanceName')}
              </button>
            </div>
          </div>
        )}

        <button type="button" onClick={() => setOpen(false)} className="mt-4 w-full rounded-md border border-input px-3 py-2 text-sm">
          {t('input.closeOpenCodeInstancePicker')}
        </button>
      </DialogContent>
    </Dialog>
  );
}
