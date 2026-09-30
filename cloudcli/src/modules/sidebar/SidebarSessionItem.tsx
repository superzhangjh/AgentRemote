import { memo, useState } from 'react';
import { Check, Edit2, GitBranch, Loader2, MoreHorizontal, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Dialog, DialogContent, DialogTitle, Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import { PROVIDER_LABELS, createSessionViewModel, formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';
import { useProviderSessionIdCopy } from '@/modules/sidebar/hooks/useProviderSessionIdCopy';
import SessionOptions from '@/modules/sidebar/SessionOptions';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  isProcessing: boolean;
  needsAttention: boolean;
  currentTime: Date;
  /** Resolved for this row, so a keystroke elsewhere does not invalidate it. */
  isEditing: boolean;
  renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Branches this session into an independent one; absent when its provider cannot. */
  onForkSession?: (session: SessionWithProvider) => void;
  t: TFunction;
};

/**
 * Rendered by SidebarProjectSessions for one session row.
 *
 * Flat by design, matching the project rows: the title is the row, and the
 * provider logo and message count that used to sit beside it are redundant here
 * — the list is already filtered to one agent, and a badge per row made a dense
 * transcript list look like a dashboard. The count and age moved into the
 * tooltip; the status indicator and the options sheet stayed, because both are
 * what the row is used for beyond opening the session.
 */
function SidebarSessionItem({
  project,
  session,
  selectedSession,
  isProcessing,
  needsAttention,
  currentTime,
  isEditing,
  renameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  t,
}: SidebarSessionItemProps) {
  const isCompact = useCompactSidebar();
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const compactSessionAge = formatCompactAge(sessionView.sessionTime, currentTime);
  const [isMobileOptionsOpen, setIsMobileOptionsOpen] = useState(false);
  const showAttentionIndicator = needsAttention && !isSelected;
  const showRecentIndicator = !showAttentionIndicator && !isProcessing && sessionView.isActive;
  const providerLabel = PROVIDER_LABELS[session.__provider];

  // The desktop controls live in SessionOptions, which owns the rename panel and
  // its outside-click dismissal. The mobile rename sits inside the bottom sheet,
  // which owns its own.
  const { copyState, copyLabel, setOptionsOpen, handleCopyAction, isCopyPending, CopyStateIcon } =
    useProviderSessionIdCopy(session.id, providerLabel);

  const selectSession = () => {
    onProjectSelect(project);
    onSessionSelect(session, project.projectId);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project.projectId, session.id, renameDraft, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(session.id, sessionView.sessionName);
  };

  const setMobileOptionsOpen = (open: boolean) => {
    setIsMobileOptionsOpen(open);
    setOptionsOpen(open);
    if (!open && isEditing) {
      onCancelEditingSession();
    }
  };

  const startMobileRename = () => {
    onStartEditingSession(project.projectId, session.id, sessionView.sessionName);
  };

  const saveMobileRename = () => {
    saveEditedSession();
    setMobileOptionsOpen(false);
  };

  const rowTitle = [
    sessionView.sessionName,
    providerLabel,
    sessionView.messageCount > 0
      ? t('sessions.messageCount', { count: sessionView.messageCount, defaultValue: '{{count}} messages' })
      : '',
    compactSessionAge ? t('projects.lastActiveLabel', { age: compactSessionAge, defaultValue: '{{age}} ago' }) : '',
  ].filter(Boolean).join(' · ');

  const statusIndicator = isProcessing ? (
    <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
      <span className="flex shrink-0 items-center justify-center">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />
      </span>
    </Tooltip>
  ) : showAttentionIndicator ? (
    <Tooltip
      content={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
      position="top"
    >
      <span role="status" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
    </Tooltip>
  ) : showRecentIndicator ? (
    <Tooltip content={t('tooltips.activeSessionIndicator')} position="top">
      <span role="status" className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
    </Tooltip>
  ) : null;

  return (
    <div className="group relative">
      <a
        href={`/session/${session.id}`}
        className={cn(
          'flex items-center gap-2 rounded-md text-sm transition-colors',
          isCompact ? 'py-2 pl-2 pr-1' : 'py-1.5 pl-2 pr-1',
          isSelected
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
        )}
        title={rowTitle}
        // Left-click keeps in-app navigation; Ctrl/Cmd/middle-click and the
        // native right-click menu use the href to open a new tab/window.
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          selectSession();
        }}
      >
        <span className="min-w-0 flex-1 truncate">{sessionView.sessionName}</span>

        {isCompact ? (
          <>
            {statusIndicator}
            <button
              type="button"
              aria-label={t('sessions.sessionOptions', { defaultValue: 'Session options' })}
              aria-haspopup="dialog"
              aria-expanded={isMobileOptionsOpen}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted active:scale-95"
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                setMobileOptionsOpen(true);
              }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </>
        ) : (
          <span className={cn('flex shrink-0 items-center', !isEditing && 'group-hover:opacity-0')}>
            {statusIndicator}
          </span>
        )}
      </a>

      {!isCompact && (
        <SessionOptions
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 transform transition-all duration-200',
            // The status dot keeps the row's right edge until the pointer is
            // on it; while renaming, the panel must stay put.
            !isEditing && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
          sessionId={session.id}
          sessionName={sessionView.sessionName}
          provider={session.__provider}
          projectId={project.projectId}
          isProcessing={isProcessing}
          isEditing={isEditing}
          renameDraft={renameDraft}
          onRenameDraftChange={onRenameDraftChange}
          onStartEditingSession={onStartEditingSession}
          onCancelEditingSession={onCancelEditingSession}
          onSaveEditingSession={onSaveEditingSession}
          onDeleteSession={onDeleteSession}
          onFork={onForkSession ? () => onForkSession(session) : undefined}
          t={t}
        />
      )}

      {isCompact && (
        <Dialog open={isMobileOptionsOpen} onOpenChange={setMobileOptionsOpen}>
          <DialogContent
            aria-describedby="mobile-session-options-description"
            animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
            className="bottom-0 left-0 top-auto max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
          >
            <DialogTitle>{sessionView.sessionName}</DialogTitle>
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

            <p id="mobile-session-options-description" className="mb-4 truncate px-1 text-xs text-muted-foreground">
              {providerLabel}
              {sessionView.messageCount > 0 ? ` · ${sessionView.messageCount}` : ''}
            </p>

            {isEditing ? (
              <div className="mb-3 space-y-2">
                <label htmlFor={`mobile-session-rename-${session.id}`} className="block px-1 text-xs font-medium text-muted-foreground">
                  {t('sessions.renameSession')}
                </label>
                <input
                  id={`mobile-session-rename-${session.id}`}
                  type="text"
                  value={renameDraft}
                  onChange={(event) => onRenameDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveMobileRename();
                    }
                  }}
                  className="w-full rounded-xl border-2 border-primary/40 bg-background px-3 py-3 text-foreground shadow-sm focus:border-primary focus:outline-none"
                  autoFocus
                  autoComplete="off"
                  // 16px keeps iOS Safari from zooming the viewport on focus.
                  style={{ fontSize: '16px' }}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveMobileRename}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-transform active:scale-95"
                  >
                    <Check className="h-5 w-5 flex-shrink-0" />
                    {t('tooltips.save', { defaultValue: 'Save' })}
                  </button>
                  <button
                    type="button"
                    onClick={onCancelEditingSession}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-muted/35 px-4 py-3 text-sm font-medium text-foreground transition-colors active:bg-muted"
                  >
                    <X className="h-5 w-5 flex-shrink-0" />
                    {t('tooltips.cancel', { defaultValue: 'Cancel' })}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={startMobileRename}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                >
                  <Edit2 className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm font-medium">{t('sessions.renameSession')}</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopyAction}
                  disabled={isCopyPending}
                  className={cn(
                    'flex min-h-12 w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                    copyState === 'copied'
                      ? 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'
                      : copyState === 'error'
                        ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                        : 'border-border bg-muted/35 text-foreground active:bg-muted',
                  )}
                >
                  {isCopyPending ? (
                    <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <CopyStateIcon className="h-5 w-5 flex-shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{copyLabel}</span>
                    {copyState === 'error' && (
                      <span className="mt-0.5 block text-xs">Tap to try again.</span>
                    )}
                  </span>
                </button>

                {onForkSession && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOptionsOpen(false);
                      onForkSession(session);
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                  >
                    <GitBranch className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">
                      {t('sessions.forkSession', { defaultValue: 'Fork session' })}
                    </span>
                  </button>
                )}

                {!isProcessing && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOptionsOpen(false);
                      requestDeleteSession();
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-red-600 transition-colors active:bg-red-500/10 dark:text-red-400"
                  >
                    <Trash2 className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">{t('sessions.deleteSession')}</span>
                  </button>
                )}
              </div>
            )}

            {!isEditing && (
              <button
                type="button"
                onClick={() => setMobileOptionsOpen(false)}
                className="mb-3 mt-2 min-h-11 w-full rounded-xl text-sm font-medium text-muted-foreground transition-colors active:bg-muted"
              >
                {t('buttons.cancel', { defaultValue: 'Cancel' })}
              </button>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * SidebarProjectSessions hands every row but the one being renamed a constant
 * draft, and the session objects come from a per-project cache, so the compare
 * succeeds for the rest. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarSessionItem);
