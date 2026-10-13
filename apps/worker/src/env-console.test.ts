import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GOOGLE, envWith } from './auth-worker.fixture.ts';
import { type WorkerEnv, readConfig } from './env.ts';

/**
 * Three rules of `readConfig` about the console that no test held (FRU-216). Two of them were held
 * by `console-routes.test.ts`, which went with the sign-in of before (FRU-150).
 *
 * Each refusal is read with its diagnostic: a worker that refuses to start for another reason than
 * the one a case is about would pass a case that only asked « refused? ».
 */

/** Why the worker refuses this environment, or `undefined` when it starts. */
function refusal(env: WorkerEnv): string | undefined {
  const config = readConfig(env);

  return config.ok ? undefined : config.missing.join(' | ');
}

const TEM = 'a-project-of-scaleway:a-secret-key-of-scaleway';
const FROM = 'hello@mail.fruitback.test';

describe('the rules of the configuration about the console (FRU-216)', () => {
  it('starts with the environment these cases change one thing of', () => {
    assert.equal(refusal(envWith()), undefined);
  });

  it('refuses Google with no secret of better-auth: nothing would sign the person in', () => {
    const google = `${GOOGLE.clientId}:${GOOGLE.clientSecret}`;

    assert.match(
      refusal(envWith({ FRUITBACK_GOOGLE_OAUTH: google, FRUITBACK_AUTH_SECRET: undefined })) ?? '',
      /^FRUITBACK_AUTH_SECRET \(FRUITBACK_GOOGLE_OAUTH signs a person in with better-auth\)$/,
    );
    // The controls: the same client with the secret starts, and a value that is not a client says so.
    const taken = readConfig(envWith({ FRUITBACK_GOOGLE_OAUTH: google }));
    assert.ok(taken.ok);
    assert.deepEqual(taken.config.google, GOOGLE);
    assert.match(refusal(envWith({ FRUITBACK_GOOGLE_OAUTH: 'no-colon' })) ?? '', /^FRUITBACK_GOOGLE_OAUTH \(/);
    // The diagnostic quotes no secret.
    assert.equal(
      (refusal(envWith({ FRUITBACK_GOOGLE_OAUTH: google, FRUITBACK_AUTH_SECRET: undefined })) ?? '').includes(
        GOOGLE.clientSecret,
      ),
      false,
    );
  });

  it('takes the two settings of the mail or neither: one alone would offer a link that never arrives', () => {
    const both = /^FRUITBACK_MAIL_FROM and FRUITBACK_SCALEWAY_TEM \(both, /;

    assert.match(refusal(envWith({ FRUITBACK_MAIL_FROM: FROM })) ?? '', both);
    assert.match(refusal(envWith({ FRUITBACK_SCALEWAY_TEM: TEM })) ?? '', both);
    // Both, and a key that is not `<project id>:<secret key>`.
    assert.match(refusal(envWith({ FRUITBACK_MAIL_FROM: FROM, FRUITBACK_SCALEWAY_TEM: 'no-colon' })) ?? '', both);
    assert.equal(
      (refusal(envWith({ FRUITBACK_SCALEWAY_TEM: TEM })) ?? '').includes('a-secret-key-of-scaleway'),
      false,
      'the diagnostic quotes no key',
    );

    // The controls: both start, and say where the mail is sent from; neither starts with no mailer.
    const mailed = readConfig(envWith({ FRUITBACK_MAIL_FROM: ` ${FROM} `, FRUITBACK_SCALEWAY_TEM: TEM }));
    assert.ok(mailed.ok);
    assert.deepEqual(
      { from: mailed.config.mail?.from, projectId: mailed.config.mail?.projectId, key: mailed.config.mail?.secretKey },
      { from: FROM, projectId: 'a-project-of-scaleway', key: 'a-secret-key-of-scaleway' },
    );
    const silent = readConfig(envWith());
    assert.ok(silent.ok);
    assert.equal(silent.config.mail, undefined);
  });

  it('takes the address of the console over https, or over http on this machine, and no other', () => {
    const shape = /^FRUITBACK_CONSOLE_URL \(an https:\/\/ address, or http:\/\/ on localhost\)$/;

    for (const refused of [
      'http://app.fruitback.com',
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
      'ftp://app.fruitback.com',
      'javascript:alert(1)',
      'app.fruitback.com',
      'not an address',
    ]) {
      assert.match(refusal(envWith({ FRUITBACK_CONSOLE_URL: refused })) ?? '', shape, refused);
    }
    for (const [given, read] of [
      ['https://app.fruitback.com', 'https://app.fruitback.com'],
      // A link of a sign-in is this address and a path: a trailing slash would double.
      ['https://app.fruitback.com/', 'https://app.fruitback.com'],
      [' https://app.fruitback.com/console// ', 'https://app.fruitback.com/console'],
      ['http://localhost:5178', 'http://localhost:5178'],
      ['http://127.0.0.1:5178', 'http://127.0.0.1:5178'],
      ['http://[::1]:5178', 'http://[::1]:5178'],
    ] as const) {
      const config = readConfig(envWith({ FRUITBACK_CONSOLE_URL: given, ALLOWED_ORIGINS: new URL(read).origin }));
      assert.ok(config.ok, `${given}: ${config.ok ? '' : config.missing.join(', ')}`);
      assert.equal(config.config.consoleUrl, read, given);
    }
  });

  it('refuses accounts with no console: a sign-in would have nowhere to send a person', () => {
    assert.match(
      refusal(envWith({ FRUITBACK_CONSOLE_URL: undefined })) ?? '',
      /^FRUITBACK_CONSOLE_URL \(FRUITBACK_DATABASE_URL is set, and a sign-in opens the console\)$/,
    );
    assert.match(refusal(envWith({ FRUITBACK_CONSOLE_URL: '   ' })) ?? '', /FRUITBACK_CONSOLE_URL/);
  });
});
