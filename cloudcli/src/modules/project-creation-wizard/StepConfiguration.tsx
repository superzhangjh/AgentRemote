import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import { shouldShowGithubAuthentication } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { GithubTokenCredential, LLMProvider, TokenMode } from '@/shared/types';
import GithubAuthenticationCard from '@/modules/project-creation-wizard/GithubAuthenticationCard';
import WorkspacePathField from '@/modules/project-creation-wizard/WorkspacePathField';

type StepConfigurationProps = {
  workspacePath: string;
  customName: string;
  provider: LLMProvider | '';
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  availableTokens: GithubTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onCustomNameChange: (customName: string) => void;
  onProviderChange: (provider: LLMProvider | '') => void;
  onGithubUrlChange: (githubUrl: string) => void;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedGithubTokenChange: (tokenId: string) => void;
  onNewGithubTokenChange: (tokenValue: string) => void;
  onAdvanceToConfirm: () => void;
};

/** Rendered by ProjectCreationWizard as step 1, collecting the workspace path, clone URL and GitHub authentication. */
export default function StepConfiguration({
  workspacePath,
  customName,
  provider,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  isCreating,
  onWorkspacePathChange,
  onCustomNameChange,
  onProviderChange,
  onGithubUrlChange,
  onTokenModeChange,
  onSelectedGithubTokenChange,
  onNewGithubTokenChange,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();
  const showGithubAuth = shouldShowGithubAuthentication(githubUrl);

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="project-name" className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.projectName')}
        </label>
        <Input
          id="project-name"
          type="text"
          value={customName}
          onChange={(event) => onCustomNameChange(event.target.value)}
          placeholder={t('projectWizard.step2.projectNamePlaceholder')}
          className="w-full"
          disabled={isCreating}
          required
        />
      </div>

      <div>
        <label htmlFor="project-agent" className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.agent')}
        </label>
        <select
          id="project-agent"
          value={provider}
          onChange={(event) => onProviderChange(event.target.value as LLMProvider | '')}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          disabled={isCreating}
          required
        >
          <option value="">{t('projectWizard.step2.selectAgent')}</option>
          <option value="claude">Claude</option>
          <option value="cursor">Cursor</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </select>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.newPath')}
        </label>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.newHelp')}
        </p>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.githubUrl')}
        </label>
        <Input
          type="text"
          value={githubUrl}
          onChange={(event) => onGithubUrlChange(event.target.value)}
          placeholder="https://github.com/username/repository"
          className="w-full"
          disabled={isCreating}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.githubHelp')}
        </p>
      </div>

      {showGithubAuth && (
        <GithubAuthenticationCard
          tokenMode={tokenMode}
          selectedGithubToken={selectedGithubToken}
          newGithubToken={newGithubToken}
          availableTokens={availableTokens}
          loadingTokens={loadingTokens}
          tokenLoadError={tokenLoadError}
          onTokenModeChange={onTokenModeChange}
          onSelectedGithubTokenChange={onSelectedGithubTokenChange}
          onNewGithubTokenChange={onNewGithubTokenChange}
        />
      )}
    </div>
  );
}
