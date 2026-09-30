import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, WifiOff } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useConnectionStatus } from '@/shared/hooks/useConnectionStatus';

/**
 * Rendered above the workspace tabs while the realtime connection is down.
 *
 * The sidebar pill is always visible but only when the sidebar is open — on a
 * phone the drawer is closed most of the time, and a session that stops
 * updating otherwise looks like an app bug. This strip makes the cause
 * explicit and offers the retry.
 *
 * Renders nothing while connected, so the header is unchanged in the normal case.
 */
export default function ConnectionBanner() {
  const { t } = useTranslation();
  const { state, isChecking, retry } = useConnectionStatus();

  if (state === 'connected') {
    return null;
  }

  const isOffline = state === 'offline';
  const label = isOffline
    ? t('connection.offlineBanner', '与服务器的连接已断开')
    : t('connection.connectingBanner', '正在重新连接服务器…');

  return (
    <button
      type="button"
      onClick={retry}
      aria-live="polite"
      className={cn(
        'mb-1.5 flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-xs font-medium transition-colors',
        isOffline
          ? 'border-red-500/30 bg-red-500/10 text-red-600 hover:bg-red-500/15 dark:text-red-400'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300',
      )}
    >
      {isOffline ? (
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Loader2 className={cn('h-3.5 w-3.5 shrink-0', isChecking && 'animate-spin')} />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1 text-[11px] font-normal opacity-80">
        <RefreshCw className={cn('h-3 w-3', isChecking && 'animate-spin')} />
        {t('connection.retry', '重试')}
      </span>
    </button>
  );
}
