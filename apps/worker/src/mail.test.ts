import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  MailError,
  type MailMessage,
  createTemMailer,
  invitationMessage,
  parseTemCredentials,
  providerLinkedMessage,
  signInMessage,
  unlinked,
} from './mail.ts';

/**
 * The mailer of production, and what a message is made of (FRU-215). The cases that held both went
 * with `console-routes.test.ts` (FRU-150). **No request leaves this file**: the mailer is handed a
 * `fetch` that keeps what it was asked.
 */

const SETTINGS = {
  projectId: 'a-project-of-scaleway',
  secretKey: 'a-secret-key-of-scaleway-0123456789',
  from: 'hello@mail.fruitback.test',
};
const MESSAGE: MailMessage = {
  to: 'alice@acme.dev',
  subject: 'A subject',
  text: 'A text, with a link: https://app.fruitback.test/sign-in#a-token',
  html: '<p>An HTML body</p>',
};

type Asked = { url: string; init: RequestInit };

/** A `fetch` that answers as `answer` says, and keeps every request it was given. */
function provider(answer: () => Response | Promise<Response>): { asked: Asked[]; fetcher: typeof fetch } {
  const asked: Asked[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init: init ?? {} });

    return answer();
  }) as typeof fetch;

  return { asked, fetcher };
}

describe('the Scaleway mailer (FRU-98, FRU-215)', () => {
  it('asks Scaleway for one message, with the key in its header and nowhere else', async () => {
    const { asked, fetcher } = provider(() => Response.json({ emails: [{ id: 'sent' }] }));

    await createTemMailer(SETTINGS, fetcher).send(MESSAGE);

    assert.equal(asked.length, 1);
    const [{ url, init }] = asked as [Asked];
    assert.equal(url, 'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails');
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, {
      'Content-Type': 'application/json',
      'X-Auth-Token': SETTINGS.secretKey,
    });
    assert.deepEqual(JSON.parse(String(init.body)), {
      from: { email: SETTINGS.from, name: 'Fruitback' },
      to: [{ email: MESSAGE.to }],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
      project_id: SETTINGS.projectId,
    });
    // The key is a header: an address and a body are what a proxy and a provider write in a log.
    assert.equal(url.includes(SETTINGS.secretKey), false);
    assert.equal(String(init.body).includes(SETTINGS.secretKey), false);
    // A provider that takes the connection and never answers must not hold the route.
    assert.ok(init.signal instanceof AbortSignal);
  });

  it('sends from the region it was given', async () => {
    const { asked, fetcher } = provider(() => Response.json({}));

    await createTemMailer({ ...SETTINGS, region: 'nl-ams' }, fetcher).send(MESSAGE);

    assert.equal(asked[0]?.url, 'https://api.scaleway.com/transactional-email/v1alpha1/regions/nl-ams/emails');
  });

  it('says that the provider refused, with its status, and never the key or what the provider wrote', async () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const { fetcher } = provider(() =>
        Response.json({ message: `denied for ${SETTINGS.secretKey}`, details: 'a body of the provider' }, { status }),
      );

      await assert.rejects(
        () => createTemMailer(SETTINGS, fetcher).send(MESSAGE),
        (error: unknown) => {
          assert.ok(error instanceof MailError, String(status));
          assert.equal(error.message, `The mail provider refused the message: ${status}`);

          return true;
        },
      );
    }
    // The control: an answer that is not a refusal resolves.
    for (const status of [200, 201, 202]) {
      const { fetcher } = provider(() => new Response('{}', { status }));
      await createTemMailer(SETTINGS, fetcher).send(MESSAGE);
    }
  });

  it('says that the provider did not answer, as a MailError and not as what fetch threw', async () => {
    const { fetcher } = provider(() => Promise.reject(new TypeError('fetch failed')));

    await assert.rejects(
      () => createTemMailer(SETTINGS, fetcher).send(MESSAGE),
      (error: unknown) => {
        assert.ok(error instanceof MailError);
        assert.match(error.message, /^The mail provider did not answer: /);
        assert.equal(error.message.includes(SETTINGS.secretKey), false);

        return true;
      },
    );
  });

  it('reads the project and the key around the first colon, and nothing from a value of another shape', () => {
    assert.deepEqual(parseTemCredentials('a-project:a-key'), { projectId: 'a-project', secretKey: 'a-key' });
    // A key can hold a colon; a project id cannot.
    assert.deepEqual(parseTemCredentials(' a-project : a:key '), { projectId: 'a-project', secretKey: 'a:key' });
    for (const value of ['', 'no-colon', ':a-key', 'a-project:']) {
      assert.equal(parseTemCredentials(value), undefined, value);
    }
  });
});

/** Every tag of an HTML body, in order: what a mail reader would build. */
function tagsOf(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z!][a-zA-Z0-9]*)/g)].map((match) => (match[0] ?? '').toLowerCase());
}

/** What somebody can type where a name goes: markup, an attribute that closes, an entity. */
const HOSTILE = `"><img src=x onerror=alert(1)><script>alert('x')</script>&lt;b&gt; & 'q'`;
const ESCAPED = `&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert('x')&lt;/script&gt;&amp;lt;b&amp;gt; &amp; 'q'`;

/** The four characters that open markup, an attribute or an entity, written as text. Not the code of `mail.ts`. */
function asText(value: string): string {
  return value.replace(/[&<>"]/g, (mark) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[mark] ?? mark);
}

describe('what a message is made of (FRU-98, FRU-104, FRU-215)', () => {
  const invitation = {
    inviter: 'Alice Martin',
    workspace: 'Acme',
    role: 'member',
    link: 'https://app.fruitback.test/invitations',
    days: 7,
  };

  for (const locale of ['en', 'fr']) {
    it(`writes each thing a person typed as text in the HTML of an invitation, never as markup, in ${locale}`, () => {
      const plain = invitationMessage('bob@acme.dev', invitation, locale);
      // Each field alone, so that one field left as it is cannot hide behind another. A name is
      // also written so that no mail client makes a link of it (FRU-209, `unlinked`): what the
      // message holds of a name is that form, as text.
      const fields: [name: string, typed: string, message: MailMessage][] = [
        [
          'the name of the workspace',
          unlinked(HOSTILE),
          invitationMessage('bob@acme.dev', { ...invitation, workspace: HOSTILE }, locale),
        ],
        [
          'the name of the inviter',
          unlinked(HOSTILE),
          invitationMessage('bob@acme.dev', { ...invitation, inviter: HOSTILE }, locale),
        ],
        ['the address', HOSTILE, invitationMessage(HOSTILE, invitation, locale)],
        [
          'the link',
          `https://x.test/?${HOSTILE}`,
          invitationMessage('bob@acme.dev', { ...invitation, link: `https://x.test/?${HOSTILE}` }, locale),
        ],
      ];

      for (const [name, typed, message] of fields) {
        assert.equal(message.html.includes(typed), false, name);
        assert.ok(message.html.includes(asText(typed)), name);
        assert.doesNotMatch(message.html, /<img|<script|onerror=alert\(1\)>/, name);
        // The same elements as a message with nothing hostile in it: no tag was added, none closed.
        assert.deepEqual(tagsOf(message.html), tagsOf(plain.html), name);
        // The text is text: it is sent as it was typed.
        assert.ok(message.text.includes(typed), name);
      }
      // The link is in an attribute and in the text of the message: both hold its escaped form only.
      const linked = fields[3]?.[2].html ?? '';
      assert.equal(linked.split(ESCAPED).length - 1, 2);
    });

    it(`writes the link of a sign-in as text in its HTML, never as markup, in ${locale}`, () => {
      const plain = signInMessage('alice@acme.dev', 'https://app.fruitback.test/sign-in#a-token', 15, locale);
      const message = signInMessage('alice@acme.dev', `https://app.fruitback.test/sign-in#${HOSTILE}`, 15, locale);

      assert.equal(message.html.includes(HOSTILE), false);
      assert.equal(message.html.split(ESCAPED).length - 1, 2, 'in the button and under it');
      assert.deepEqual(tagsOf(message.html), tagsOf(plain.html));
      assert.ok(message.text.includes(HOSTILE));
      // The address it goes to is not in the body: only the provider is told.
      assert.equal(message.to, 'alice@acme.dev');
    });
  }

  it('carries no picture and no address of another server: a message that is opened tells nobody', () => {
    for (const message of [
      signInMessage('alice@acme.dev', 'https://app.fruitback.test/sign-in#a-token', 15),
      invitationMessage('bob@acme.dev', invitation),
    ]) {
      assert.doesNotMatch(message.html, /<img|<link|<script|<iframe|url\(|@import/i);
      const addresses = [...message.html.matchAll(/https?:\/\/[^\s"<]+/g)].map((match) => new URL(match[0]).origin);
      assert.deepEqual([...new Set(addresses)], ['https://app.fruitback.test']);
    }
  });

  it('says the subject and the words of the language asked for, and English for any other', () => {
    assert.match(signInMessage('a@b.dev', 'https://x.test/#t', 15, 'fr-FR').subject, /Votre lien/);
    assert.match(signInMessage('a@b.dev', 'https://x.test/#t', 15, 'de').subject, /Your Fruitback sign-in link/);
    assert.match(signInMessage('a@b.dev', 'https://x.test/#t', 15).text, /It works once, for 15 minutes\./);
    // The subject of an invitation is fixed (FRU-209): it holds nothing a person wrote.
    assert.equal(
      invitationMessage('b@b.dev', { ...invitation, workspace: HOSTILE, inviter: HOSTILE }, 'fr').subject,
      'Vous êtes invité dans un espace de travail sur Fruitback',
    );
    assert.equal(invitationMessage('b@b.dev', invitation).subject, 'You are invited to a workspace on Fruitback');
    assert.match(invitationMessage('b@b.dev', { ...invitation, role: 'admin' }).text, /as an admin\./);
    assert.match(invitationMessage('b@b.dev', invitation).text, /as a member\.[\s\S]*It waits for 7 days\./);
  });
});

describe('the alert of a link (FRU-415)', () => {
  const linked = { provider: 'Google', address: 'x@y.dev', link: 'https://app.fruitback.test/w/w1/account' };

  for (const [locale, lead, undo] of [
    ['en', 'The Google account x@\u200By.\u200Bdev was linked to your Fruitback account.', 'unlink it'],
    ['fr', 'Le compte Google x@\u200By.\u200Bdev a été lié à votre compte Fruitback.', 'déliez-le'],
  ] as const) {
    it(`names the provider account and the way to undo it, in ${locale}, with no link made of the address`, () => {
      const message = providerLinkedMessage('alice@acme.dev', linked, locale);
      assert.equal(message.to, 'alice@acme.dev');
      assert.ok(message.text.includes(lead), message.text);
      assert.ok(message.text.includes(undo), message.text);
      assert.ok(message.text.includes(linked.link));
      assert.ok(message.html.includes(`href="${linked.link}"`));
      // The address of the provider is no link in a mail client, and no markup.
      assert.equal(message.text.includes('x@y.dev'), false);
      const hostile = providerLinkedMessage('alice@acme.dev', { ...linked, address: HOSTILE }, locale);
      assert.equal(hostile.html.includes(unlinked(HOSTILE)), false);
      assert.ok(hostile.html.includes(asText(unlinked(HOSTILE))));
    });
  }
});
