import { useState } from 'react';
import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { AddressesSection } from '../parts/account-addresses';
import { ProfileSection } from '../parts/account-profile';
import { SessionsSection, SignOutButton, SignOutProblem, useSignOut } from '../parts/account-sessions';
import { SignInSection } from '../parts/account-sign-in';
import { SettingsHead } from './settings-shell';
import { useWorkspace } from './workspace';

/** The browsers the card of the profile shows: the last ones. « See all » leads to every one. */
const LAST_BROWSERS = 3;

/**
 * My account, the page « Profile » of the settings (FRU-692; before, screen 13 of the mockup of
 * 2026-10-13, FRU-248): four cards in two columns from 1280 px, one column under. The profile and
 * where the person is signed in, then the addresses and how the person signs in.
 *
 * Each card is a part of `parts/account-*.tsx` (FRU-614), with its own state: the page holds only the
 * primary address, which three of them show, and the way out, which the head shows.
 */
export default function Account() {
  useLocale();
  const { me, workspace } = useWorkspace();
  // The primary address (FRU-450): the person can choose another one here, and this page shows it at once.
  const [primary, setPrimary] = useState(me.account.email);
  const { stillIn, leave } = useSignOut();

  return (
    <>
      <SettingsHead
        title={t('Profile')}
        lead={t('Your name on notes, your addresses and how you sign in.')}
        action={<SignOutButton onPress={() => void leave()} />}
      />
      <SignOutProblem stillIn={stillIn} />
      <div className="grid items-start gap-[16px] min-[1280px]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-[16px]">
          <ProfileSection me={me} primary={primary} />
          <SessionsSection workspace={workspace.id} limit={LAST_BROWSERS} />
        </div>
        <div className="flex min-w-0 flex-col gap-[16px]">
          <AddressesSection workspace={workspace.id} onPrimary={setPrimary} />
          <SignInSection workspace={workspace.id} primary={primary} />
        </div>
      </div>
    </>
  );
}
