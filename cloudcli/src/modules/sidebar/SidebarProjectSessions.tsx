import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  t: TFunction;
};

/** Kept in step with the wrapper's `duration-200` so the rows leave after the collapse animation. */
const COLLAPSE_ANIMATION_MS = 220;

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="px-2 py-1.5">
          <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
        </div>
      ))}
    </>
  );
}

/**
 * Rendered by SidebarProjectItem to show an expanded project's sessions,
 * delegating each row to SidebarSessionItem.
 *
 * The panel is always rendered as a 0fr/1fr grid track so opening and closing
 * animate; the rows themselves are dropped once the collapse finishes, which is
 * what keeps a fully collapsed sidebar from carrying every session of every
 * project in the DOM.
 *
 * No "new session" button here: starting one is the project row's trailing
 * control now (it is what the expanded row shows in place of the chevron), so
 * the list is only the list.
 */
export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  attentionSessionIds,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  t,
}: SidebarProjectSessionsProps) {
  // Set on open and cleared a moment after closing, so the rows exist for the
  // whole animation without outliving it.
  const [isFullyCollapsed, setIsFullyCollapsed] = useState(!isExpanded);

  useEffect(() => {
    if (isExpanded) {
      setIsFullyCollapsed(false);
      return undefined;
    }

    const timer = window.setTimeout(() => setIsFullyCollapsed(true), COLLAPSE_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [isExpanded]);

  const hasSessions = sessions.length > 0;
  const showRows = isExpanded || !isFullyCollapsed;

  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
      aria-hidden={!isExpanded}
    >
      <div className="overflow-hidden">
        <div className="pb-1 pl-7 pr-2">
          {showRows && (
            !initialSessionsLoaded ? (
              <SessionListSkeleton />
            ) : !hasSessions ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
            ) : (
              <>
                {sessions.map((session) => (
                  <SidebarSessionItem
                    key={session.id}
                    project={project}
                    session={session}
                    selectedSession={selectedSession}
                    isProcessing={activeSessions.has(session.id)}
                    needsAttention={attentionSessionIds.has(session.id)}
                    currentTime={currentTime}
                    onRenameDraftChange={onRenameDraftChange}
                    isEditing={session.id === sessionRenameId}
                    renameDraft={session.id === sessionRenameId ? sessionRenameDraft : ''}
                    onStartEditingSession={onStartEditingSession}
                    onCancelEditingSession={onCancelEditingSession}
                    onSaveEditingSession={onSaveEditingSession}
                    onProjectSelect={onProjectSelect}
                    onSessionSelect={onSessionSelect}
                    onDeleteSession={onDeleteSession}
                    onForkSession={onForkSession}
                    t={t}
                  />
                ))}

                {hasMoreSessions && (
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-60"
                    onClick={() => onLoadMoreSessions(project.projectId)}
                    disabled={isLoadingMoreSessions}
                  >
                    {isLoadingMoreSessions ? t('sessions.loadingSessions') : t('sessions.showMore')}
                  </button>
                )}
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}
