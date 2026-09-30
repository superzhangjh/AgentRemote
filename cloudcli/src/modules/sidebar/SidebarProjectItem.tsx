import { memo, useEffect, useRef, useState } from 'react';
import { Check, Edit3, Folder, Loader2, MoreHorizontal, Pin, SquarePen, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, MCPServerStatus, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import { getProjectLastActivityLabel, getTaskIndicatorStatus } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import TaskIndicator from '@/modules/sidebar/TaskIndicator';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  /** Resolved for this row: only the project being renamed re-renders on a keystroke. */
  isEditing: boolean;
  renameDraft: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onRenameDraftChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

/**
 * Rendered by SidebarProjectList for one project row.
 *
 * Flat by design: a folder icon and the name on one line, sessions as plain
 * lines underneath, and one highlight for the selected project. Everything that
 * used to occupy the second line (session count, last activity, path) moved into
 * the row's tooltip, so a dense list stays readable at a glance.
 *
 * The trailing control carries the two things a project row is used for:
 * collapsed it expands the project (chevron), expanded it starts a new session
 * (the composer-plus icon) — which is also why the expanded list no longer
 * needs its own "new session" button at the top.
 */
function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  isEditing,
  renameDraft,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  tasksEnabled,
  mcpServerStatus,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  activeSessions,
  attentionSessionIds,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  // Project identity is tracked by the DB-assigned `projectId` everywhere
  // after the projectName → projectId migration.
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);
  const mobileRenameInputRef = useRef<HTMLInputElement>(null);
  const [isMobileOptionsOpen, setIsMobileOptionsOpen] = useState(false);

  const lastActivityLabel = getProjectLastActivityLabel(project, currentTime);
  const sessionCount = Number(project.sessionMeta?.total ?? sessions.length);
  // Aggregated so a collapsed project still shows that something is happening
  // inside it: a spinner while any of its sessions runs, an amber dot when one
  // finished unread (the same signal the session rows use).
  const isProcessing = sessions.some((session) => activeSessions.has(session.id));
  const hasUnread = sessions.some((session) => attentionSessionIds.has(session.id));
  const rowTitle = [
    project.displayName,
    project.fullPath,
    sessionCount > 0 ? t('projects.sessionCount', { count: sessionCount, defaultValue: '{{count}} sessions' }) : '',
    lastActivityLabel ? t('projects.lastActiveLabel', { age: lastActivityLabel, defaultValue: '{{age}} ago' }) : '',
  ].filter(Boolean).join(' · ');

  useEffect(() => {
    if (!isEditing || !mobileRenameInputRef.current) {
      return;
    }

    let animationFrame = 0;
    const revealInput = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        mobileRenameInputRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    revealInput();
    window.visualViewport?.addEventListener('resize', revealInput);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.visualViewport?.removeEventListener('resize', revealInput);
    };
  }, [isEditing]);

  const isCompact = useCompactSidebar();

  // Clicking a project row only expands it: the workspace follows the session
  // the user opens (or the new session they start), never a bare project click,
  // which used to clear the open session underneath them.
  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId, renameDraft);
  };

  const startNewSession = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }
    onNewSession(project);
  };

  const iconButtonClass = cn(
    'flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
    isCompact ? 'h-8 w-8' : 'h-6 w-6',
  );

  return (
    <div className={cn(isDeleting && 'opacity-50 pointer-events-none')}>
      <div
        role="button"
        tabIndex={0}
        onClick={isEditing ? undefined : toggleProject}
        onKeyDown={(event) => {
          if (isEditing) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleProject();
          }
        }}
        title={isEditing ? undefined : rowTitle}
        className={cn(
          'relative mx-3 flex cursor-pointer select-none items-center gap-2 rounded-lg pl-1 pr-0 transition-colors',
          isCompact ? 'py-2' : 'py-1.5',
          // The background is owned by one thing only: pinning. Hover and
          // selection deliberately do not touch it.
          //
          // Tinted from `muted-foreground` rather than `muted`: in the light
          // theme `muted` is 91% lightness against a 96% background, which is
          // five points — technically a colour, visually nothing. This reads as
          // the same light grey on the dark theme (15% against 8%).
          isStarred
            ? 'bg-muted-foreground/15 ring-1 ring-inset ring-border/60'
            : 'hover:bg-accent/40',
        )}
      >
        {/* Running swaps the folder glyph itself, so the indicator costs no
            extra room; unread stays a dot in the sidebar gutter, left of
            everything and outside the padding box. */}
        {isProcessing ? (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center"
            title={t('tooltips.processingSessionIndicator', { defaultValue: 'Processing session' })}
          >
            <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
          </span>
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground/80" />
        )}

        {hasUnread && !isProcessing && (
          <span
            className="absolute -left-1.5 top-1/2 h-2 w-2 -translate-y-1/2 animate-pulse rounded-full bg-amber-500"
            title={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
          />
        )}

        {isEditing ? (
          <input
            ref={mobileRenameInputRef}
            type="text"
            value={renameDraft}
            onChange={(event) => onRenameDraftChange(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-primary/40 bg-background px-2 py-1 text-sm text-foreground focus:outline-none"
            placeholder={t('projects.projectNamePlaceholder')}
            autoFocus
            autoComplete="off"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                saveProjectName();
              }
              if (event.key === 'Escape') {
                onCancelEditingProject();
              }
            }}
            style={isCompact ? { fontSize: '16px', WebkitAppearance: 'none' } : undefined}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm">{project.displayName}</span>
        )}

        {isEditing ? (
          <>
            <button
              type="button"
              aria-label={t('tooltips.save', { defaultValue: 'Save' })}
              className={cn(iconButtonClass, 'text-emerald-600 hover:text-emerald-700')}
              onClick={(event) => {
                event.stopPropagation();
                saveProjectName();
              }}
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={t('tooltips.cancel', { defaultValue: 'Cancel' })}
              className={iconButtonClass}
              onClick={(event) => {
                event.stopPropagation();
                onCancelEditingProject();
              }}
            >
              <X className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            {tasksEnabled && <TaskIndicator status={taskStatus} size="xs" className="shrink-0" />}

            <div className="flex shrink-0 items-center gap-0.5">
              {isExpanded && (
                <button
                  type="button"
                  aria-label={t('sessions.newSession')}
                  title={t('sessions.newSession')}
                  className={cn(iconButtonClass, 'text-muted-foreground hover:text-foreground')}
                  onClick={(event) => {
                    event.stopPropagation();
                    startNewSession();
                  }}
                >
                  <SquarePen className={isCompact ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
                </button>
              )}

              <button
                type="button"
                aria-label={t('projects.projectOptions', { defaultValue: 'Project options' })}
                aria-haspopup="dialog"
                aria-expanded={isMobileOptionsOpen}
                className={cn(iconButtonClass, 'text-muted-foreground hover:text-foreground')}
                onClick={(event) => {
                  event.stopPropagation();
                  setIsMobileOptionsOpen(true);
                }}
              >
                <MoreHorizontal className={isCompact ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
              </button>
            </div>
          </>
        )}
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions}
        attentionSessionIds={attentionSessionIds}
        currentTime={currentTime}
        sessionRenameId={sessionRenameId}
        sessionRenameDraft={sessionRenameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onForkSession={onForkSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        t={t}
      />

      <Dialog open={isMobileOptionsOpen} onOpenChange={setIsMobileOptionsOpen}>
        <DialogContent
          animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
          className="bottom-0 left-0 top-auto max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
        >
          <DialogTitle>{project.displayName}</DialogTitle>
          <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

          <p className="mb-4 truncate px-1 text-xs text-muted-foreground" title={project.fullPath}>
            {project.fullPath}
          </p>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => {
                toggleStarProject();
              }}
              className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
            >
              <Pin className={cn('h-5 w-5 flex-shrink-0', isStarred && 'fill-current text-amber-500')} />
              <span className="text-sm font-medium">
                {isStarred
                  ? t('projects.unpin', { defaultValue: '取消置顶' })
                  : t('projects.pin', { defaultValue: '置顶' })}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsMobileOptionsOpen(false);
                onStartEditingProject(project);
              }}
              className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
            >
              <Edit3 className="h-5 w-5 flex-shrink-0" />
              <span className="text-sm font-medium">{t('projects.renameProject')}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsMobileOptionsOpen(false);
                onDeleteProject(project);
              }}
              className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-red-600 transition-colors active:bg-red-500/10 dark:text-red-400"
            >
              <Trash2 className="h-5 w-5 flex-shrink-0" />
              <span className="text-sm font-medium">{t('projects.deleteProject')}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsMobileOptionsOpen(false)}
            className="mb-3 mt-2 min-h-11 w-full rounded-xl text-sm font-medium text-muted-foreground transition-colors active:bg-muted"
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * Both renames are resolved to scalars by SidebarProjectList and the sorted
 * session array is cached per project, so a keystroke changes props on exactly
 * one row and every other row's compare succeeds. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarProjectItem);
