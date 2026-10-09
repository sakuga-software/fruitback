import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { redeemLink } from '../api';
import { Mark } from '../ui';
import { t } from '../i18n';

/**
 * Where a sign-in link lands. The code is after the `#`, so it never reached a server: it is read
 * here, spent once, and removed from the address bar so a reload or a shared screen does not show it.
 */
export default function SignIn() {
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  // The code of a link the worker did not answer for. The link is not spent, so it can be tried again.
  const [waiting, setWaiting] = useState<string | undefined>();

  const redeem = useCallback(
    (code: string) => {
      setWaiting(undefined);
      void redeemLink(code).then((redeemed) => {
        if (redeemed.ok) return navigate('/', { replace: true });
        if (redeemed.status === 0) return setWaiting(code);
        setFailed(true);
      });
    },
    [navigate],
  );

  useEffect(() => {
    const code = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname);
    if (code === '') return setFailed(true);

    redeem(code);
  }, [redeem]);

  if (waiting !== undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-setup px-4">
        <div className="w-full max-w-sm rounded-[14px] border border-line bg-surface p-7 text-center">
          <h1 className="text-lg font-bold">{t('You are not signed in yet')}</h1>
          <p className="mt-2 text-sm text-muted">{t('Fruitback did not answer. Your link still works.')}</p>
          <button
            type="button"
            className="mt-5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white"
            onClick={() => redeem(waiting)}
          >
            {t('Try again')}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-setup px-4">
      <div className="w-full max-w-sm rounded-[14px] border border-line bg-surface p-7 text-center">
        <div className="mb-3 flex justify-center">
          <Mark size={20} />
        </div>
        {failed ? (
          <>
            <h1 className="text-lg font-bold">{t('This link no longer works')}</h1>
            <p className="mt-2 text-sm text-muted">
              {t('A link works once, for fifteen minutes. Ask for another one.')}
            </p>
            <Link
              to="/setup"
              className="mt-5 inline-block rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white"
            >
              {t('Send a new link')}
            </Link>
          </>
        ) : (
          <p className="text-sm text-muted">{t('Signing you in…')}</p>
        )}
      </div>
    </main>
  );
}
