import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useBundleFreshness } from '@/shared/hooks/useBundleFreshness';

/**
 * Shown when the server is serving a newer frontend build than this page is
 * running, with a one-tap reload.
 *
 * Needed because a phone shell can keep its WebView alive for days: without
 * this, a deployed fix silently does nothing on the device that is still
 * holding the old bundle. When the page is hidden the reload happens on its
 * own, so this banner is mostly a desktop aid.
 */
export default function BundleUpdateBanner() {
  const { t } = useTranslation();
  const { updateAvailable, isReloading, reload } = useBundleFreshness();

  if (!updateAvailable) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={reload}
      aria-live="polite"
      className="mb-1.5 flex w-full items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-left text-xs font-medium text-blue-600 transition-colors hover:bg-blue-500/15 dark:text-blue-300"
    >
      <RefreshCw className={cn('h-3.5 w-3.5 shrink-0', isReloading && 'animate-spin')} />
      <span className="min-w-0 flex-1 truncate">
        {t('connection.newBundle', '界面已更新')}
      </span>
      <span className="shrink-0 text-[11px] font-normal opacity-80">
        {t('connection.reloadNow', '点此刷新')}
      </span>
    </button>
  );
}
