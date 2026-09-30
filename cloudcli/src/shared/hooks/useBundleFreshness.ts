import { useCallback, useEffect, useState } from 'react';

/**
 * Detects that the server is serving a different frontend bundle than the one
 * this page loaded, and reloads into it.
 *
 * A phone shell keeps its WebView alive across app switches, so a client can
 * run yesterday's build for days while the server serves today's — every fix
 * looks like it did not work. The served `index.html` is never cached by the
 * service worker (hashed assets are, HTML is network-only), so comparing the
 * entry script name is a reliable "is my bundle current" signal.
 *
 * The reload happens while the page is hidden, so the user never watches the
 * app blank and repaint; a visible client with a stale bundle gets a banner
 * instead.
 */
const BUNDLE_CHECK_INTERVAL_MS = 60_000;

const readEntryScript = (root: ParentNode): string | null => {
  const src = root.querySelector('script[type="module"][src]')?.getAttribute('src') ?? '';
  return src.trim() || null;
};

export function useBundleFreshness() {
  // The bundle this page is running, read once: script tags do not change
  // under a live document.
  const [runningBundle] = useState<string | null>(() =>
    typeof document === 'undefined' ? null : readEntryScript(document),
  );
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isReloading, setIsReloading] = useState(false);

  const checkForNewBundle = useCallback(async () => {
    if (!runningBundle) {
      return;
    }

    try {
      const response = await fetch(`/?bundle-check=${Date.now()}`, {
        cache: 'no-store',
        headers: { Accept: 'text/html' },
      });
      if (!response.ok) {
        return;
      }

      const servedBundle = readEntryScript(
        new DOMParser().parseFromString(await response.text(), 'text/html'),
      );
      if (servedBundle && servedBundle !== runningBundle) {
        setUpdateAvailable(true);
      }
    } catch {
      // Offline or the server is restarting; the connection indicator owns that
      // story, and the next check will pick the change up.
    }
  }, [runningBundle]);

  useEffect(() => {
    void checkForNewBundle();

    const interval = window.setInterval(() => {
      void checkForNewBundle();
    }, BUNDLE_CHECK_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkForNewBundle();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('agentremote:resume', onVisible);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('agentremote:resume', onVisible);
    };
  }, [checkForNewBundle]);

  // Swap the bundle out of sight. Chat state lives on the server and the
  // socket re-subscribes on reconnect, so a hidden reload costs nothing.
  useEffect(() => {
    if (!updateAvailable) {
      return undefined;
    }

    const reloadWhileHidden = () => {
      if (document.visibilityState === 'hidden') {
        setIsReloading(true);
        window.location.reload();
      }
    };

    reloadWhileHidden();
    document.addEventListener('visibilitychange', reloadWhileHidden);
    return () => document.removeEventListener('visibilitychange', reloadWhileHidden);
  }, [updateAvailable]);

  const reload = useCallback(() => {
    setIsReloading(true);
    window.location.reload();
  }, []);

  return { updateAvailable, isReloading, reload };
}
