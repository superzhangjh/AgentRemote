import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { ComposerToolsSnapshot } from '@/shared/types';

/**
 * Two contexts instead of one so publishing a snapshot does not re-render the
 * producer: ChatInterface writes through the publish context, while the quick
 * settings drawer reads the value context.
 */
const ComposerToolsContext = createContext<ComposerToolsSnapshot | null>(null);
const ComposerToolsPublishContext = createContext<
  ((snapshot: ComposerToolsSnapshot | null) => void) | null
>(null);

/**
 * Used by the project-workspace shell to host the chat composer tools the
 * quick settings drawer renders, since the drawer and ChatInterface are not
 * ancestor and descendant.
 */
export function ComposerToolsProvider({ children }: { children: ReactNode }) {
  // The composer snapshot currently published by ChatInterface, or null while
  // no chat session is mounted; the drawer hides its session section then.
  const [snapshot, setSnapshot] = useState<ComposerToolsSnapshot | null>(null);

  return (
    <ComposerToolsPublishContext.Provider value={setSnapshot}>
      <ComposerToolsContext.Provider value={snapshot}>{children}</ComposerToolsContext.Provider>
    </ComposerToolsPublishContext.Provider>
  );
}

/** Used by the quick settings content to read the active composer tools, or null when no session is open. */
export function useComposerTools(): ComposerToolsSnapshot | null {
  return useContext(ComposerToolsContext);
}

/**
 * Used by ChatInterface to publish its composer tools while it is mounted.
 * Updates replace the snapshot without an intermediate null, and unmounting
 * clears it so a closed session cannot leave stale controls in the drawer.
 */
export function usePublishComposerTools(snapshot: ComposerToolsSnapshot | null) {
  const publish = useContext(ComposerToolsPublishContext);

  useEffect(() => {
    if (publish) {
      publish(snapshot);
    }
  }, [publish, snapshot]);

  useEffect(() => {
    if (!publish) {
      return;
    }
    return () => publish(null);
  }, [publish]);
}
