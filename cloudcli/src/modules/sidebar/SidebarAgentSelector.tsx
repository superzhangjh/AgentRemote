import { useRef } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import { LLMProviderLogo } from '@/shared/ui';
import type { LLMProvider } from '@/shared/types';

type SidebarAgentSelectorProps = {
  selectedProvider: LLMProvider;
  onProviderChange: (provider: LLMProvider) => void;
};

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

const providerName = (provider: LLMProvider) =>
  provider === 'opencode' ? 'OpenCode' : provider === 'codex' ? 'Codex' : provider === 'cursor' ? 'Cursor' : 'Claude';

/** Used by SidebarHeader to switch the Agent shown in the unified project and conversation tree. */
export default function SidebarAgentSelector({ selectedProvider, onProviderChange }: SidebarAgentSelectorProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  return (
    <details
      ref={detailsRef}
      className="group relative mt-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          detailsRef.current?.removeAttribute('open');
        }
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm text-foreground marker:hidden hover:bg-accent/60 [&::-webkit-details-marker]:hidden">
        <LLMProviderLogo provider={selectedProvider} className="h-4 w-4" />
        <span className="min-w-0 flex-1">{providerName(selectedProvider)}</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute inset-x-0 top-full z-30 mt-1 rounded-lg border border-border bg-popover p-1 shadow-lg" role="group" aria-label="Agent">
        {PROVIDERS.map((provider) => (
          <button
            key={provider}
            type="button"
            aria-pressed={selectedProvider === provider}
            onClick={() => {
              onProviderChange(provider);
              detailsRef.current?.removeAttribute('open');
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
          >
            <LLMProviderLogo provider={provider} className="h-4 w-4" />
            <span className="flex-1">{providerName(provider)}</span>
            {selectedProvider === provider && <Check className="h-4 w-4 text-primary" />}
          </button>
        ))}
      </div>
    </details>
  );
}
