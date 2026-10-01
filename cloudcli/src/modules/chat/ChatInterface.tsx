import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '@/modules/task-master';
import { useAuth } from '@/modules/auth';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import { usePublishComposerTools } from '@/modules/chat/context/ComposerToolsContext';
import { api } from '@/shared/api';
import type {
  ChatMessage,
  ComposerToolsSnapshot,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '@/shared/types';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';

type ChatInterfaceProps = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
};

/**
 * Used by the project-workspace module (via the chat barrel) to render a
 * project session's chat tab; it owns the session, provider, realtime and
 * composer state that ChatMessagesPane and ChatComposer render.
 */
function ChatInterface({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');
  const [fastMode, setFastMode] = useState(() => localStorage.getItem('codex-fast-mode') === 'true');
  // The choice is saved before session creation and then pinned to that session by the server.
  const [openCodeServers, setOpenCodeServers] = useState<Array<{ id: string; label: string; url: string }>>([]);
  const [openCodeServerId, setOpenCodeServerId] = useState<string>('');
  const [openCodeServersError, setOpenCodeServersError] = useState<string | null>(null);
  // Existing chats read their pinned instance from the session record before loading its models.
  const [pinnedOpenCodeServer, setPinnedOpenCodeServer] = useState<{ sessionId: string; id: string | null } | null>(null);

  useEffect(() => {
    const sessionId = selectedSession?.id;
    if (!sessionId) return;
    let cancelled = false;
    void api.sessionDetails(sessionId).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json();
      if (!cancelled) setPinnedOpenCodeServer({ sessionId, id: body?.data?.openCodeServerId ?? null });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [selectedSession?.id]);

  const modelOpenCodeServerId = selectedSession
    ? (pinnedOpenCodeServer?.sessionId === selectedSession.id ? pinnedOpenCodeServer.id ?? undefined : undefined)
    : openCodeServerId || undefined;

  const toggleFastMode = useCallback(() => setFastMode((current) => {
    localStorage.setItem('codex-fast-mode', String(!current));
    return !current;
  }), []);
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
  } = useSessionProtectionActions();

  const { user } = useAuth();
  const sessionStore = useSessionStore(user ? String(user.id ?? user.username) : null);
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    loadedOpenCodeServerId,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
    openCodeServerId: modelOpenCodeServerId,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessages,
    loadFullTranscript,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  useEffect(() => {
    if (provider !== 'opencode' || selectedSession?.id || currentSessionId) return;
    let cancelled = false;
    const refresh = () => { void api.providers.openCodeServers().then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const servers = (Array.isArray(body?.data) ? body.data as Array<{ id: string; label: string; url: string }> : [])
        .map((server) => ({
          ...server,
          label: localStorage.getItem(`open-code-server-label:${server.id}`) || server.label,
        }));
      if (cancelled) return;
      setOpenCodeServers(servers);
      setOpenCodeServersError(servers.length ? null : t('input.noOpenCodeInstances'));
      const preferred = localStorage.getItem('preferred-open-code-server');
      const desktopServers = servers.filter((server) => server.id.startsWith('service:'));
      const defaults = desktopServers.length ? desktopServers : servers;
      setOpenCodeServerId(defaults.find((server) => server.id === preferred)?.id ?? defaults[0]?.id ?? '');
    }).catch(() => {
      if (!cancelled) {
        setOpenCodeServers([]);
        setOpenCodeServerId('');
        setOpenCodeServersError(t('input.openCodeInstancesFailed'));
      }
    }); };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener('agentremote:resume', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('agentremote:resume', refresh);
    };
  }, [provider, selectedSession?.id, currentSessionId, t]);

  const handleSelectOpenCodeServer = useCallback((id: string) => {
    setOpenCodeServerId(id);
    localStorage.setItem('preferred-open-code-server', id);
  }, []);

  const handleRenameOpenCodeServer = useCallback((id: string, label: string) => {
    localStorage.setItem(`open-code-server-label:${id}`, label);
    setOpenCodeServers((current) => current.map((item) => item.id === id ? { ...item, label } : item));
  }, []);
  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    openCodeServerId,
    openCodeModelsReady: loadedOpenCodeServerId === openCodeServerId
      && !providerModelsLoading
      && currentProviderModelOptions.some((option) => option.value === currentProviderModel),
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    fastMode,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await requestLatestMessages(selectedSession.id, isActive);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  // The socket's own reconnect event only fires when the connection actually
  // dropped. A WebView that was merely frozen comes back with a live socket
  // and a transcript that is minutes behind — including permission prompts
  // that were raised and maybe answered elsewhere while it was hidden. Run the
  // same bounded tail sync and re-subscribe on resume, throttled because the
  // shell event, `focus` and `visibilitychange` arrive together.
  const lastResumeCatchUpRef = useRef(0);
  useEffect(() => {
    const catchUp = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      const now = Date.now();
      if (now - lastResumeCatchUpRef.current < 5_000) {
        return;
      }
      lastResumeCatchUpRef.current = now;
      void handleWebSocketReconnect();
    };

    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('focus', catchUp);
    window.addEventListener('agentremote:resume', catchUp);
    return () => {
      document.removeEventListener('visibilitychange', catchUp);
      window.removeEventListener('focus', catchUp);
      window.removeEventListener('agentremote:resume', catchUp);
    };
  }, [handleWebSocketReconnect]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  /**
   * Branches the conversation into a new session that ends at this message,
   * then opens it. The session being viewed is left exactly as it was.
   */
  const handleForkFromMessage = useCallback(async (message: ChatMessage) => {
    const anchorId = message.transcriptAnchorId;
    const sourceSessionId = selectedSession?.id;
    if (!anchorId || !sourceSessionId) return;

    try {
      const response = await api.forkSession(sourceSessionId, { upToAnchorId: anchorId });
      const payload = await response.json();
      const forkedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      onNavigateToSession?.(forkedSessionId);
    } catch (error) {
      console.error('Error forking session:', error);
    }
  }, [onNavigateToSession, selectedSession?.id]);

  const { scheduledMessages, schedule: scheduleMessage, cancel: cancelScheduledMessage, refresh: refreshScheduledMessages } =
    useScheduledMessages(currentSessionId || selectedSession?.id || null);

  // The schedule lives on the server, so another client may have created,
  // cancelled, sent or failed one for this session while it was open here.
  // Refetch the list on the announcement rather than trying to patch it in
  // place: the delta carries no row state, only "this session's list changed".
  const scheduledMessagesSessionId = currentSessionId || selectedSession?.id || null;
  useEffect(() => {
    if (!scheduledMessagesSessionId) {
      return undefined;
    }

    return subscribe((event) => {
      if (event.kind !== 'scheduled_messages_updated') return;
      if (event.sessionId !== scheduledMessagesSessionId) return;
      void refreshScheduledMessages();
    });
  }, [refreshScheduledMessages, scheduledMessagesSessionId, subscribe]);

  // A suspended WebView misses the announcement entirely, so catch up when the
  // view becomes visible again instead of leaving a stale banner on screen.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshScheduledMessages();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refreshScheduledMessages]);

  /**
   * Hands the composer's current text to the server to send later, and clears
   * the box as a send would — the message has left the composer either way.
   */
  const handleScheduleMessage = useCallback(async (scheduledFor: Date) => {
    const content = input.trim();
    if (!content) return;

    const scheduled = await scheduleMessage({
      content,
      scheduledFor,
      options: { model: currentProviderModel, effort: currentProviderEffort, fastMode: provider === 'codex' && fastMode, permissionMode },
    });
    if (scheduled) {
      setInput('');
    }
  }, [currentProviderEffort, currentProviderModel, fastMode, input, permissionMode, provider, scheduleMessage, setInput]);

  // The callbacks below depend on the composer's live `input`, which changes on
  // every keystroke. They are held in refs so the snapshot the quick settings
  // drawer reads stays referentially stable between token/turn updates and only
  // republishes when it actually has new data.
  const scheduleMessageRef = useRef(handleScheduleMessage);
  scheduleMessageRef.current = handleScheduleMessage;
  const showTokenUsageRef = useRef(showCostModal);
  showTokenUsageRef.current = showCostModal;
  const scheduleDisabledRef = useRef(true);
  scheduleDisabledRef.current = !input.trim();

  const composerTools = useMemo<ComposerToolsSnapshot>(() => ({
    tokenBudget,
    onShowTokenUsage: () => showTokenUsageRef.current(),
    scheduledMessages,
    onScheduleMessage: (scheduledFor) => scheduleMessageRef.current(scheduledFor),
    onCancelScheduledMessage: cancelScheduledMessage,
    isScheduleDisabled: () => scheduleDisabledRef.current,
  }), [cancelScheduledMessage, scheduledMessages, tokenBudget]);

  usePublishComposerTools(composerTools);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectedSession?.id]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }


  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          // Wheel and touch also reveal older cached rows when a short
          // transcript does not emit a scroll event.
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          providerModels={providerModels}
          setProviderModel={setStoredProviderModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          visibleMessages={visibleMessages}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          // Editing replaces the turn and everything after it, so it is only
          // offered when the session is idle — a half-truncated transcript with
          // a live stream writing into it is not recoverable.
          onEditMessage={supportsMessageEditing && !isProcessing ? beginEditMessage : undefined}
          onForkFromMessage={supportsSessionForking ? handleForkFromMessage : undefined}
          onLoadFullTranscript={loadFullTranscript}
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={selectPermissionMode}
          providerLabel={selectedProviderLabel}
          openCodeServers={provider === 'opencode' && !selectedSession && !currentSessionId && openCodeServers.filter((server) => server.id.startsWith('service:')).length > 1
            ? openCodeServers.filter((server) => server.id.startsWith('service:'))
            : undefined}
          selectedOpenCodeServerId={openCodeServerId}
          onSelectOpenCodeServer={handleSelectOpenCodeServer}
          onRenameOpenCodeServer={handleRenameOpenCodeServer}
          openCodeServersError={openCodeServersError}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          modelsLoading={providerModelsLoading}
          fastMode={fastMode}
          onToggleFastMode={provider === 'codex' ? toggleFastMode : undefined}
          isEditingSentMessage={Boolean(editingAnchorId)}
          onCancelEditMessage={cancelEditMessage}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
