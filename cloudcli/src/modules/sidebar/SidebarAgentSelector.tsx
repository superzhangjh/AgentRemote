import { useTranslation } from 'react-i18next';

import { LLMProviderLogo, Pill, PillBar } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider } from '@/shared/types';

type SidebarAgentSelectorProps = {
  selectedProvider: LLMProvider;
  onProviderChange: (provider: LLMProvider) => void;
};

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

const providerName = (provider: LLMProvider) =>
  provider === 'opencode' ? 'OpenCode' : provider === 'codex' ? 'Codex' : provider === 'cursor' ? 'Cursor' : 'Claude';

/**
 * Switches which Agent the unified project and conversation tree shows.
 *
 * A segmented bar rather than the previous dropdown: with four agents the whole
 * set fits, the active one is always readable without opening anything, and
 * switching costs one tap instead of two. The inactive segments are logo-only
 * so four of them fit the sidebar width without truncating a name; the active
 * segment carries its label, which is also the one the user is reading.
 */
export default function SidebarAgentSelector({ selectedProvider, onProviderChange }: SidebarAgentSelectorProps) {
  const { t } = useTranslation('sidebar');

  return (
    <PillBar
      className="mt-2 w-full"
      role="radiogroup"
      aria-label={t('agentSelector.label', 'Agent')}
    >
      {PROVIDERS.map((provider) => {
        const isActive = selectedProvider === provider;
        const label = providerName(provider);

        return (
          <Pill
            key={provider}
            isActive={isActive}
            onClick={() => onProviderChange(provider)}
            role="radio"
            aria-checked={isActive}
            aria-label={label}
            title={label}
            className={cn(
              'justify-center gap-1.5 py-1.5 text-xs',
              isActive ? 'min-w-0 flex-1 px-2' : 'w-9 px-0',
            )}
          >
            <LLMProviderLogo provider={provider} className="h-3.5 w-3.5 shrink-0" />
            {isActive && <span className="truncate">{label}</span>}
          </Pill>
        );
      })}
    </PillBar>
  );
}
