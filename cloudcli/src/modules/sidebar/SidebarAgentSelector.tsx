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
 * Icon-only segments that share their row with the list-view tabs: four logos
 * fit beside them without either group wrapping, the active segment keeps the
 * raised pill styling, and each segment carries the agent name as its tooltip
 * and aria-label.
 */
export default function SidebarAgentSelector({ selectedProvider, onProviderChange }: SidebarAgentSelectorProps) {
  const { t } = useTranslation('sidebar');

  return (
    <PillBar
      className="min-w-0"
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
            className={cn('h-7 w-8 shrink-0 justify-center px-0 py-0')}
          >
            <LLMProviderLogo provider={provider} className="h-4 w-4 shrink-0" />
          </Pill>
        );
      })}
    </PillBar>
  );
}
