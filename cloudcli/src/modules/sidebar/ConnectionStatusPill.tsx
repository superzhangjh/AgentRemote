import { useTranslation } from 'react-i18next';
import { Loader2, Wifi, WifiOff } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useConnectionStatus } from '@/shared/hooks/useConnectionStatus';
import { Tooltip } from '@/shared/ui';

type ConnectionStatusPillProps = {
  className?: string;
  /** Hides the address line in the tooltip; the sidebar shows it inline instead. */
  compact?: boolean;
};

const STATE_STYLES = {
  connected: {
    dot: 'bg-emerald-500',
    text: 'text-muted-foreground',
    ring: 'border-border/60 bg-muted/40',
  },
  connecting: {
    dot: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
    ring: 'border-amber-500/30 bg-amber-500/10',
  },
  offline: {
    dot: 'bg-red-500',
    text: 'text-red-600 dark:text-red-400',
    ring: 'border-red-500/30 bg-red-500/10',
  },
} as const;

/**
 * Shows whether this client is talking to its CloudCLI server.
 *
 * Sits in the sidebar header because it answers a question the rest of the UI
 * silently depends on: when sessions stop updating, "服务正常吗" is the first
 * thing to check, and before this there was nowhere to check it.
 */
export default function ConnectionStatusPill({ className, compact = false }: ConnectionStatusPillProps) {
  const { t } = useTranslation();
  const { state, isOnline, serverVersion, latencyMs, isChecking, retry } = useConnectionStatus();

  const label = state === 'connected'
    ? t('connection.connected', '已连接')
    : state === 'offline'
      ? t('connection.offline', '网络已断开')
      : t('connection.connecting', '连接中…');

  const detailLines = [
    serverVersion ? `${t('connection.serverVersion', '服务版本')}: ${serverVersion}` : null,
    latencyMs !== null ? `${t('connection.latency', '延迟')}: ${latencyMs} ms` : null,
    !isOnline ? t('connection.deviceOffline', '设备当前没有网络连接') : null,
    state !== 'connected' ? t('connection.retryHint', '点击立即重连') : null,
  ].filter((line): line is string => Boolean(line));

  return (
    <Tooltip
      position="bottom"
      content={
        <span className="block space-y-0.5 text-left">
          {detailLines.length > 0
            ? detailLines.map((line) => <span key={line} className="block">{line}</span>)
            : <span>{t('connection.connectedHint', '实时连接正常')}</span>}
        </span>
      }
    >
      <button
        type="button"
        onClick={state === 'connected' ? undefined : retry}
        aria-live="polite"
        aria-label={label}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors',
          STATE_STYLES[state].ring,
          state !== 'connected' && 'cursor-pointer hover:bg-accent/60',
          className,
        )}
      >
        <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
          <span className={cn('h-2 w-2 rounded-full', STATE_STYLES[state].dot)} />
          {state === 'connecting' && (
            <span className="absolute inset-0 animate-ping rounded-full bg-amber-500/60" />
          )}
        </span>
        <span className={cn('min-w-0 flex-1 truncate font-medium', STATE_STYLES[state].text)}>{label}</span>
        {isChecking && state !== 'connected' ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : state === 'connected' ? (
          <Wifi className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <WifiOff className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        {!compact && typeof window !== 'undefined' && (
          <span className="hidden shrink-0 truncate text-[10px] text-muted-foreground/60 md:inline">
            {window.location.host}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
