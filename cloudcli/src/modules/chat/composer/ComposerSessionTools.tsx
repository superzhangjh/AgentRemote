import { Activity, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ComposerToolsSnapshot } from '@/shared/types';
import { SETTING_ROW_CLASS } from '@/shared/constants';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';

type ComposerSessionToolsProps = {
  /** The active composer's session tools, read from ComposerToolsContext by the quick settings drawer. */
  tools: ComposerToolsSnapshot;
  /** Closes the quick settings drawer before the token cost modal opens, so the modal is not left behind it. */
  onRequestClose?: () => void;
};

/**
 * Used by the quick settings drawer to render the active chat session's token
 * usage and scheduled sending, which used to sit in the composer footer.
 */
export default function ComposerSessionTools({ tools, onRequestClose }: ComposerSessionToolsProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-2">
      <div className={SETTING_ROW_CLASS}>
        <span className="flex items-center gap-2 text-sm text-foreground">
          <Activity className="h-4 w-4 text-muted-foreground" />
          {t('quickSettings.tokenUsage')}
        </span>
        <TokenUsageSummary
          usage={tools.tokenBudget}
          onClick={() => {
            onRequestClose?.();
            tools.onShowTokenUsage();
          }}
        />
      </div>

      <div className={SETTING_ROW_CLASS}>
        <span className="flex items-center gap-2 text-sm text-foreground">
          <Clock className="h-4 w-4 text-muted-foreground" />
          {t('quickSettings.sendLater')}
        </span>
        <ScheduleMessagePopover
          disabled={tools.isScheduleDisabled()}
          onSchedule={tools.onScheduleMessage}
        />
      </div>

      <ScheduledMessageList
        scheduledMessages={tools.scheduledMessages}
        onCancel={tools.onCancelScheduledMessage}
      />
    </div>
  );
}
