import { memo, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { PaletteOpsProvider } from '@/modules/command-palette';
import { ProjectsStateProvider } from '@/modules/project-workspace/context/ProjectsStateContext';
import {
  SessionProtectionProvider,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { useVisualViewportKeyboardOffset } from '@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset';
import ProjectWorkspaceShell from '@/modules/project-workspace/ProjectWorkspaceShell';
import { readSelectedProvider, writeSelectedProvider } from '@/shared/selectedProvider';
import type { LLMProvider } from '@/shared/types';

const MemoizedProjectWorkspaceRouteContent = memo(ProjectWorkspaceRouteContent);

/** This module's only public export: rendered by App for the "/" and "/session/:sessionId" routes. */
export default function ProjectWorkspaceRoute() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const notificationProvider = searchParams.get('notificationProvider');
  const targetProvider = notificationProvider ?? searchParams.get('provider');
  const sessionProvider = ['claude', 'cursor', 'codex', 'opencode'].includes(targetProvider ?? '')
    ? targetProvider as LLMProvider : undefined;
  useEffect(() => {
    if (sessionProvider && readSelectedProvider() !== sessionProvider) {
      writeSelectedProvider(sessionProvider);
    }
    if (!notificationProvider) return;

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('notificationProvider');
    if (sessionProvider) nextSearchParams.set('provider', sessionProvider);
    setSearchParams(nextSearchParams, { replace: true });
  }, [notificationProvider, sessionProvider, searchParams, setSearchParams]);

  // Gate every notification navigation, including a repeated provider/target.
  // Keeping a previously handled provider here let later taps reuse the old
  // workspace while the provider switch and session lookup were still pending.
  if (notificationProvider) {
    return null;
  }

  return (
    <SessionProtectionProvider sessionId={sessionId}>
      <PaletteOpsProvider>
        <MemoizedProjectWorkspaceRouteContent sessionProvider={sessionProvider} />
      </PaletteOpsProvider>
    </SessionProtectionProvider>
  );
}

function ProjectWorkspaceRouteContent({ sessionProvider }: { sessionProvider?: LLMProvider }) {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe } = useWebSocket();
  const {
    isSessionProcessing,
    markSessionProcessing,
    markSessionIdle,
  } = useSessionProtectionActions();

  useVisualViewportKeyboardOffset();

  useEffect(() => subscribe((event) => {
    if (event.kind !== 'session_activity') return;

    const sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
    if (!sessionId || typeof event.isProcessing !== 'boolean') return;

    if (event.isProcessing) {
      // `statusText` distinguishes a plain run from one blocked on an approval
      // or a question, so the activity indicator does not read as "stuck".
      const statusText = typeof event.statusText === 'string' ? event.statusText : undefined;
      markSessionProcessing(sessionId, { canInterrupt: true, statusText });
    } else {
      markSessionIdle(sessionId);
    }
  }), [markSessionIdle, markSessionProcessing, subscribe]);

  return (
    <ProjectsStateProvider
      sessionId={sessionId}
      sessionProvider={sessionProvider}
      navigate={navigate}
      subscribe={subscribe}
      isMobile={isMobile}
      isSessionProcessing={isSessionProcessing}
    >
      <ProjectWorkspaceShell
        isMobile={isMobile}
        ws={ws}
        sendMessage={sendMessage}
        navigate={navigate}
      />
    </ProjectsStateProvider>
  );
}
