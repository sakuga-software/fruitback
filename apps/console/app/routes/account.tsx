import { useState } from 'react';
import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { AddressesSection } from '../parts/account-addresses';
import { ProfileSection } from '../parts/account-profile';
import { SessionsSection, SignOutSection } from '../parts/account-sessions';
import { SignInSection } from '../parts/account-sign-in';
import { PageHead, useWorkspace } from './workspace';

/**
 * My account, as screen 13 of the mockup of 2026-10-13 draws it (FRU-248, FRU-249): the profile, how
 * the person signs in, the browsers where the console is signed in, and the end of the workspace for
 * its owner.
 *
 * The name is changed here, and a provider linked or unlinked (FRU-249). Each section is a part of
 * `parts/account-*.tsx` (FRU-614), with its own state: the page holds only the primary address, which
 * three of them show.
 */
export default function Account() {
  useLocale();
  const { me, workspace } = useWorkspace();
  // The primary address (FRU-450): the person can choose another one here, and this page shows it at once.
  const [primary, setPrimary] = useState(me.account.email);

  return (
    <>
      <PageHead title={t('My account')} lead={t('Your name on notes, your addresses, how you sign in, and where.')} />
      {/* The mockup puts 40 px between the head and each section: the head has 28 px under it. */}
      <div className="flex flex-col gap-[40px] pt-[12px]">
        <ProfileSection me={me} primary={primary} />
        <AddressesSection workspace={workspace.id} onPrimary={setPrimary} />
        <SignInSection workspace={workspace.id} primary={primary} />
        <SessionsSection />
        <SignOutSection />
      </div>
    </>
  );
}
