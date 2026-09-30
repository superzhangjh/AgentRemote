import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useConnectionStatus } from '@/shared/hooks/useConnectionStatus';
import { Tooltip } from '@/shared/ui';

type ConnectionStatusButtonProps = {
  /** Matches the size of the header action buttons it sits beside (h-7 desktop, h-8 touch). */
  size?: 'sm' | 'md';
  className?: string;
};

const STATE_DOT = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500',
  offline: 'bg-red-500',
} as const;

/**
 * Whether this client is talking to its CloudCLI server.
 *
 * Sits in the sidebar's top action row beside refresh and new project, because
 * it answers the question the rest of the UI silently depends on: when
 * sessions stop updating, "服务正常吗" is the first thing to check and before
 * this there was nowhere to check it. The dot carries the state at a glance;
 * the tooltip carries the detail (version, latency); tapping it reconnects.
 */
export default function ConnectionStatusButton({ size = 'md', className }: ConnectionStatusButtonProps) {
  const { t } = useTranslation();
  const { state, isOnline, serverVersion, latencyMs, isChecking, retry } = useConnectionStatus();

  const label = state === 'connected'
    ? t('connection.connected', '已连接')
    : state === 'offline'
      ? t('connection.offline', '网络已断开')
      : t('connection.connecting', '连接中…');

  const detailLines = [
    !!serverVersion && `${t('connection.serverVersion', '服务版本')}: ${serverVersion}`,
    latencyMs !== null && `${t('connection.latency', '延迟')}: ${latencyMs} ms`,
    !isOnline && t('connection.deviceOffline', '设备当前没有网络连接'),
    state !== 'connected' ? t('connection.retryHint', '点击立即重连') : t('connection.connectedHint', '实时连接正常'),
  ].filter((line): line is string => Boolean(line));

  return (
    <div className="shrink-0">
      <Tooltip
        position="bottom"
        content={
        <span className="block space-y-0.5 text-left">
          {detailLines.map((line) => <span key={line} className="block">{line}</span>)}
        </span>
      }
    >
      <button
        type="button"
        onClick={state === 'connected' ? undefined : retry}
        aria-live="polite"
        aria-label={label}
        title={label}
        className={cn(
          'flex shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium transition-colors',
          size === 'sm' ? 'h-7' : 'h-8 px-2.5',
          state === 'connected'
            ? 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            : 'cursor-pointer',
          state === 'connecting' && 'border-amber-500/30 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400',
          state === 'offline' && 'border-red-500/30 bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400',
          className,
        )}
      >
        <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
          <span className={cn('h-2 w-2 rounded-full', STATE_DOT[state])} />
          {state === 'connecting' && (
            <span className="absolute inset-0 animate-ping rounded-full bg-amber-500/60" aria-hidden="true" />
          )}
        </span>
        <span className="whitespace-nowrap">{label}</span>
        {isChecking && state !== 'connected' && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
      </button>
      </Tooltip>
    </div>
  );
}
