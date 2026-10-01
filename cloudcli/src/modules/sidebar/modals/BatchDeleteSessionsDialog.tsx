import { useCallback, useEffect, useMemo, useState } from 'react';
import { EyeOff, Loader2, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, SessionWithProvider } from '@/shared/types';
import { createSessionViewModel } from '@/modules/sidebar/utils/sidebarProjectFormatting';

/**
 * Matches the project sessions endpoint's page cap. One page covers a normal
 * project, and anything larger is walked page by page when the dialog opens.
 */
const SESSION_PAGE_SIZE = 200;

/** One session as the project sessions endpoint summarizes it. */
type ProjectSessionSummary = {
  id: string;
  provider?: LLMProvider;
  summary?: string;
  messageCount?: number;
  lastActivity?: string;
};

type ProjectSessionsPagePayload = {
  sessions?: ProjectSessionSummary[];
  sessionMeta?: { hasMore?: boolean; total?: number };
};

type BatchDeleteSessionsDialogProps = {
  project: Project;
  provider: LLMProvider;
  /** Sessions with a run in flight; their checkbox is disabled because a running session cannot be deleted. */
  activeSessionIds: ReadonlySet<string>;
  onConfirm: (sessionIds: string[], hardDelete: boolean) => Promise<void> | void;
  onCancel: () => void;
  t: TFunction;
};

/**
 * Rendered by SidebarModals for the project options sheet's batch delete entry.
 *
 * Loads the project's sessions itself rather than reusing the sidebar's loaded
 * page so the selection covers sessions that were never scrolled into view.
 * Selection is local: it is discarded when the dialog closes.
 */
export default function BatchDeleteSessionsDialog({
  project,
  provider,
  activeSessionIds,
  onConfirm,
  onCancel,
  t,
}: BatchDeleteSessionsDialogProps) {
  // Null while the fetch runs; replaced by the full list or left null with
  // `loadFailed` when the walk throws. A separate loading flag would only
  // duplicate that.
  const [sessions, setSessions] = useState<SessionWithProvider[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Checked rows for the pending delete; cleared implicitly when the dialog unmounts.
  const [selectedSessionIds, setSelectedSessionIds] = useState<ReadonlySet<string>>(new Set());
  // Keeps the action buttons disabled while the batch request is in flight —
  // the dialog stays mounted until the controller clears the pending deletion.
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Captured once for row titles; the dialog is short-lived so the ages do not
  // need to tick.
  const currentTime = useMemo(() => new Date(), []);

  const loadSessions = useCallback(async () => {
    setSessions(null);
    setLoadFailed(false);

    try {
      const collected: SessionWithProvider[] = [];
      let offset = 0;

      for (;;) {
        const response = await api.projectSessions(project.projectId, {
          limit: SESSION_PAGE_SIZE,
          offset,
          provider,
        });
        if (!response.ok) {
          throw new Error(`Failed to load sessions: HTTP ${response.status}`);
        }

        const payload = (await response.json()) as ProjectSessionsPagePayload;
        const pageSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        for (const session of pageSessions) {
          collected.push({
            id: session.id,
            summary: session.summary,
            messageCount: session.messageCount,
            lastActivity: session.lastActivity,
            __provider: session.provider ?? provider,
            __projectId: project.projectId,
          });
        }

        if (!payload.sessionMeta?.hasMore || pageSessions.length === 0) {
          break;
        }
        offset += pageSessions.length;
      }

      setSessions(collected);
    } catch (error) {
      console.error('[Sidebar] Failed to load sessions for batch deletion:', error);
      setLoadFailed(true);
    }
  }, [project.projectId, provider]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const selectableSessions = useMemo(
    () => (sessions ?? []).filter((session) => !activeSessionIds.has(session.id)),
    [activeSessionIds, sessions],
  );
  const isAllSelected = selectableSessions.length > 0
    && selectableSessions.every((session) => selectedSessionIds.has(session.id));

  const toggleSession = (sessionId: string) => {
    setSelectedSessionIds((previous) => {
      const next = new Set(previous);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedSessionIds(isAllSelected
      ? new Set()
      : new Set(selectableSessions.map((session) => session.id)));
  };

  const confirm = (hardDelete: boolean) => {
    if (selectedSessionIds.size === 0 || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    void onConfirm([...selectedSessionIds], hardDelete);
  };

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) {
        onCancel();
      }
    }}>
      <DialogContent
        aria-describedby="batch-delete-sessions-description"
        animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
        className="bottom-0 left-0 top-auto flex max-h-[85vh] max-w-none translate-x-0 translate-y-0 flex-col rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
      >
        <DialogTitle>{t('batchDelete.title', { defaultValue: 'Batch delete sessions' })}</DialogTitle>
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

        <p
          id="batch-delete-sessions-description"
          className="mb-3 truncate px-1 text-xs text-muted-foreground"
          title={project.fullPath}
        >
          {project.displayName}
        </p>

        {sessions === null && !loadFailed && (
          <div className="space-y-2 pb-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-11 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        )}

        {loadFailed && (
          <div className="space-y-3 pb-4">
            <p className="px-1 text-sm text-muted-foreground">
              {t('batchDelete.loadFailed', { defaultValue: 'Could not load sessions.' })}
            </p>
            <Button variant="outline" className="w-full" onClick={() => void loadSessions()}>
              {t('batchDelete.retry', { defaultValue: 'Retry' })}
            </Button>
          </div>
        )}

        {sessions !== null && sessions.length === 0 && (
          <p className="pb-4 pl-1 text-sm text-muted-foreground">
            {t('batchDelete.empty', { defaultValue: 'This project has no sessions.' })}
          </p>
        )}

        {sessions !== null && sessions.length > 0 && (
          <>
            <div className="flex items-center justify-between px-1 pb-2">
              <button
                type="button"
                className="text-sm font-medium text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
                onClick={toggleAll}
                disabled={isSubmitting || selectableSessions.length === 0}
              >
                {isAllSelected
                  ? t('batchDelete.clearSelection', { defaultValue: 'Clear selection' })
                  : t('batchDelete.selectAll', { defaultValue: 'Select all' })}
              </button>
              <span className="text-xs text-muted-foreground">
                {t('batchDelete.selectedCount', {
                  count: selectedSessionIds.size,
                  defaultValue: '{{count}} selected',
                })}
              </span>
            </div>

            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pb-3">
              {sessions.map((session) => {
                const isRunning = activeSessionIds.has(session.id);
                const sessionName = createSessionViewModel(session, currentTime, t).sessionName;

                return (
                  <label
                    key={session.id}
                    className={cn(
                      'flex min-h-11 items-center gap-3 rounded-xl border border-border bg-muted/35 px-3 py-2',
                      isRunning ? 'cursor-not-allowed opacity-55' : 'cursor-pointer active:bg-muted',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-primary"
                      checked={selectedSessionIds.has(session.id)}
                      disabled={isRunning || isSubmitting}
                      onChange={() => toggleSession(session.id)}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm" title={sessionName}>
                      {sessionName}
                    </span>
                    {isRunning && (
                      <span className="shrink-0 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                        {t('batchDelete.running', { defaultValue: 'Running' })}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            <p className="px-1 pb-3 text-[11px] text-muted-foreground">
              {t('batchDelete.archiveNotice', {
                defaultValue: 'Archiving keeps the transcript; permanent deletion removes it from disk.',
              })}
            </p>
          </>
        )}

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            className="w-full justify-start"
            disabled={selectedSessionIds.size === 0 || isSubmitting}
            onClick={() => confirm(false)}
          >
            {isSubmitting
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <EyeOff className="mr-2 h-4 w-4" />}
            {t('batchDelete.archiveSelected', { defaultValue: 'Archive selected' })}
          </Button>
          <Button
            variant="destructive"
            className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
            disabled={selectedSessionIds.size === 0 || isSubmitting}
            onClick={() => confirm(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('batchDelete.deleteSelected', { defaultValue: 'Delete selected permanently' })}
          </Button>
          <Button variant="ghost" className="w-full" disabled={isSubmitting} onClick={onCancel}>
            {t('actions.cancel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
