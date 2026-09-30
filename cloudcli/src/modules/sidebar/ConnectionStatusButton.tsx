import { useTranslation } from 'react-i18next';
import { Loader2, Wifi, WifiOff } from 'lucide-react';

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
          'relative flex shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors',
          size === 'sm' ? 'h-7 w-7' : 'h-8 w-8 bg-muted/50',
          state === 'connected'
            ? 'hover:bg-accent/80 hover:text-foreground'
            : 'cursor-pointer bg-amber-500/10 hover:bg-amber-500/20',
          state === 'offline' && 'bg-red-500/10 hover:bg-red-500/20',
          className,
        )}
      >
        {isChecking && state !== 'connected' ? (
          <Loader2 className={cn(size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4', 'animate-spin')} />
        ) : state === 'connected' ? (
          <Wifi className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        ) : (
          <WifiOff className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        )}

        <span
          className={cn(
            'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-background',
            STATE_DOT[state],
          )}
          aria-hidden="true"
        />
        {state === 'connecting' && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-ping rounded-full bg-amber-500/70" aria-hidden="true" />
        )}
      </button>
      </Tooltip>
    </div>
  );
}
