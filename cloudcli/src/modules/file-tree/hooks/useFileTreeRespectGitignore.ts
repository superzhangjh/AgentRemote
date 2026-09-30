import { useCallback, useState } from 'react';

const FILE_TREE_RESPECT_GITIGNORE_STORAGE_KEY = 'file-tree-respect-gitignore';

/**
 * Whether the file tree hides what `.gitignore` excludes.
 *
 * On by default: a project's ignored output (`dist/`, logs, local env files)
 * is noise most of the time. Users who keep source they need to see in a
 * `.gitignore`d folder can turn it off, and the choice sticks per browser.
 *
 * Turning it off does not expose dependency directories: the server keeps
 * hard-excluding `node_modules`, `.git` and the other build/cache directory
 * names it always hides.
 */
export function useFileTreeRespectGitignore() {
  // Read once during initialization instead of syncing from an effect, so the
  // first fetch already uses the persisted choice.
  const [respectGitignore, setRespectGitignore] = useState(() => {
    try {
      return localStorage.getItem(FILE_TREE_RESPECT_GITIGNORE_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });

  const changeRespectGitignore = useCallback((next: boolean) => {
    setRespectGitignore(next);

    try {
      localStorage.setItem(FILE_TREE_RESPECT_GITIGNORE_STORAGE_KEY, next ? 'true' : 'false');
    } catch {
      // Keep runtime state even when persistence fails.
    }
  }, []);

  return { respectGitignore, changeRespectGitignore };
}
