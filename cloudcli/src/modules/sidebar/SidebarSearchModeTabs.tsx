import { Activity, Archive, Folder } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { SidebarSearchMode } from '@/shared/types';

type SidebarSearchModeTabsProps = {
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  runningSessionsCount: number;
  t: TFunction;
};

/**
 * The list's three views — projects & conversations, running, archived —
 * as one compact segmented control.
 *
 * Icon-only because it shares its row with the agent switcher: the labels were
 * the widest part of the header, and the two groups together still fit the
 * sidebar width. Each segment keeps a tooltip and an aria-label, and the
 * running view keeps its count badge.
 */
export default function SidebarSearchModeTabs({
  searchMode,
  onSearchModeChange,
  runningSessionsCount,
  t,
}: SidebarSearchModeTabsProps) {
  const runningBadgeText = runningSessionsCount > 99 ? '99+' : String(runningSessionsCount);

  const segmentClass = (isActive: boolean) => cn(
    'flex h-7 w-8 shrink-0 items-center justify-center rounded-md transition-all',
    isActive ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
  );

  return (
    <div className="flex shrink-0 items-center gap-[2px] rounded-lg bg-muted/60 p-[3px]" role="tablist">
      <Tooltip content={`${t('search.modeProjects')} · ${t('search.modeConversations')}`} position="bottom">
        <button
          type="button"
          role="tab"
          aria-selected={searchMode === 'projects'}
          aria-label={`${t('search.modeProjects')} · ${t('search.modeConversations')}`}
          onClick={() => onSearchModeChange('projects')}
          className={segmentClass(searchMode === 'projects')}
        >
          <Folder className="h-3.5 w-3.5" />
        </button>
      </Tooltip>

      <Tooltip content={t('search.runningTooltip', 'Running sessions')} position="bottom">
        <button
          type="button"
          role="tab"
          aria-selected={searchMode === 'running'}
          aria-label={t('search.runningTooltip', 'Running sessions')}
          onClick={() => onSearchModeChange('running')}
          className={cn(
            segmentClass(searchMode === 'running'),
            searchMode === 'running' && 'ring-1 ring-emerald-500/15',
          )}
        >
          <span className="relative flex h-3.5 w-3.5 items-center justify-center">
            <Activity className={cn('h-3.5 w-3.5', runningSessionsCount > 0 && 'text-emerald-500')} />
            {runningSessionsCount > 0 && (
              <span className="absolute -right-2 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-0.5 text-[8px] font-semibold leading-none text-white shadow-sm ring-1 ring-background">
                {runningBadgeText}
              </span>
            )}
          </span>
        </button>
      </Tooltip>

      <Tooltip content={t('search.archiveOnlyTooltip', 'Archive only')} position="bottom">
        <button
          type="button"
          role="tab"
          aria-selected={searchMode === 'archived'}
          aria-label={t('search.archiveOnlyTooltip', 'Archive only')}
          onClick={() => onSearchModeChange('archived')}
          className={segmentClass(searchMode === 'archived')}
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}
