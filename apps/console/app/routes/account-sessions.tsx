import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { SessionsSection, SignOutEverywhere, SignOutProblem, useSignOut } from '../parts/account-sessions';
import { SettingsHead } from './settings-shell';
import { useWorkspace } from './workspace';

/**
 * The page « Sessions » of the settings (FRU-692): every browser where the person is signed in, of
 * the console and of the extension, and « Sign out everywhere ». The profile shows the last three.
 */
export default function AccountSessions() {
  useLocale();
  const { workspace } = useWorkspace();
  const { stillIn, leaveEverywhere } = useSignOut();

  return (
    <>
      <SettingsHead
        title={t('Sessions')}
        lead={t('Disconnect a browser you no longer use. It stops showing notes at once.')}
        action={<SignOutEverywhere onConfirm={() => void leaveEverywhere()} />}
      />
      <SignOutProblem stillIn={stillIn} />
      <div className="max-w-[800px]">
        <SessionsSection workspace={workspace.id} />
      </div>
    </>
  );
}
