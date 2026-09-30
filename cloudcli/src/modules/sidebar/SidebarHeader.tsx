import { Plus, RefreshCw, Search, X, PanelLeftClose } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Input } from '@/shared/ui';
import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '@/shared/constants';
import { IS_PLATFORM, cn } from '@/shared/utils';
import type { LLMProvider, SidebarSearchMode } from '@/shared/types';
import GitHubStarBadge from '@/modules/sidebar/GitHubStarBadge';
import SidebarAgentSelector from '@/modules/sidebar/SidebarAgentSelector';
import SidebarSearchModeTabs from '@/modules/sidebar/SidebarSearchModeTabs';
import ConnectionStatusButton from '@/modules/sidebar/ConnectionStatusButton';

const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

type SidebarHeaderProps = {
  selectedProvider: LLMProvider;
  onProviderChange: (provider: LLMProvider) => void;
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  runningSessionsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  t: TFunction;
};

/** Module-level, not a nested render function, so the wordmark is not remounted on every SidebarHeader render. */
function LogoBlock({ t }: { t: TFunction }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <img src="/logo.svg" alt="" className="h-7 w-7 flex-shrink-0 rounded-lg shadow-sm" />
      <h1
        className="truncate text-sm font-bold tracking-tight text-foreground"
        style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
      >
        {t('app.title')}
      </h1>
    </div>
  );
}

/**
 * Rendered by SidebarContent at the top of the panel.
 *
 * One responsive layout instead of the previous desktop and touch copies, so
 * the two cannot drift apart. Three tight rows: brand + connection/actions,
 * agent switcher + list-view tabs (one row, as asked), and the search box.
 * Row spacing is deliberately small — this block sits above the project list,
 * which is what the user is looking at.
 */
export default function SidebarHeader({
  selectedProvider,
  onProviderChange,
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  runningSessionsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  t,
}: SidebarHeaderProps) {
  const showSearchTools = (projectsCount > 0 || runningSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'archived'
      ? t('search.archivedPlaceholder', 'Search archived sessions...')
      : searchMode === 'running'
        ? t('search.runningPlaceholder', 'Search running sessions...')
        : t('projects.searchPlaceholder');

  const brand = (
    <div className="flex min-w-0 items-center gap-2.5">
      <LogoBlock t={t} />
    </div>
  );

  return (
    <div className="flex-shrink-0">
      {/* Brand + connection and actions */}
      <div
        className="flex items-center justify-between gap-2 px-3 pb-1 pt-2"
        style={isPWA && isMobile ? { paddingTop: '16px' } : {}}
      >
        {IS_PLATFORM ? (
          <a
            href="https://cloudcli.ai/dashboard"
            className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80 active:opacity-70"
            title={t('tooltips.viewEnvironments')}
          >
            {brand}
          </a>
        ) : (
          brand
        )}

        <div className="flex flex-shrink-0 items-center gap-1">
          <ConnectionStatusButton size="sm" />
          <button
            type="button"
            className={cn(
              'flex items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground',
              isMobile ? 'h-8 w-8 bg-muted/50' : 'h-7 w-7',
            )}
            onClick={onRefresh}
            disabled={isRefreshing}
            title={t('tooltips.refresh')}
            aria-label={t('tooltips.refresh')}
          >
            <RefreshCw className={cn(isMobile ? 'h-4 w-4' : 'h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
          </button>
          <button
            type="button"
            className={cn(
              'flex items-center justify-center rounded-lg transition-transform active:scale-95',
              isMobile
                ? 'h-8 w-8 bg-primary/90 text-primary-foreground'
                : 'h-7 w-7 text-muted-foreground hover:bg-accent/80 hover:text-foreground',
            )}
            onClick={onCreateProject}
            title={t('tooltips.createProject')}
            aria-label={t('tooltips.createProject')}
          >
            <Plus className={isMobile ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
          </button>
          {!isMobile && (
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground"
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
              aria-label={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <GitHubStarBadge />

      {/* Agent switcher and list view on one row */}
      <div className="flex items-center gap-1.5 px-3 pt-1">
        <SidebarAgentSelector
          selectedProvider={selectedProvider}
          onProviderChange={onProviderChange}
        />
        {showSearchTools && (
          <SidebarSearchModeTabs
            searchMode={searchMode}
            onSearchModeChange={onSearchModeChange}
            runningSessionsCount={runningSessionsCount}
            t={t}
          />
        )}
      </div>

      {/* Search */}
      {showSearchTools && (
        <div className="px-3 pt-1.5">
          {/* Own relative box: the icon is centred on the input, not on the
              row including its top padding. */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              type="text"
              placeholder={searchPlaceholder}
              value={searchFilter}
              onChange={(event) => onSearchFilterChange(event.target.value)}
              className="nav-search-input h-8 rounded-lg border-0 pl-8 pr-12 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {searchFilter ? (
              <button
                type="button"
                onClick={onClearSearchFilter}
                aria-label={t('tooltips.clearSearch')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
              >
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            ) : (
              <kbd
                aria-hidden
                title={t('tooltips.openCommandPalette')}
                className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex"
              >
                {MOD_KEY}
                <span>K</span>
              </kbd>
            )}
          </div>
        </div>
      )}

      {/* Solid, inset to the search field's edges */}
      <div className="mx-3 mt-1.5 border-b border-border/60" />
    </div>
  );
}
