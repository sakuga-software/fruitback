-- Rows for restore-drill.sh (FRU-143): at least one in every table of the worker, and not the same
-- number in each, so a table that a restore lost or mixed up shows in the counts.
-- The drill fails on a table with no row: a migration that adds a table adds its rows here.
-- Nothing here is a secret: no digest is the digest of a code, and no key opens anything.

-- The tables of better-auth (FRU-144). The people, their ways to sign in, the workspaces and their
-- members are rows of these tables since FRU-146, written by the store of the accounts: an id of the
-- worker, a verified address, the id of a workspace for its slug, and the columns of the tokens of a
-- provider empty. The other three are written by better-auth only, and no route serves it yet, so
-- the drill writes them: an empty table proves nothing. As the worker writes them (FRU-181): a digest
-- in the place of the token of a session and of a link.

INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt", "locale") VALUES
  ('acc_drill1', 'Alice Martin', 'alice@acme.dev', true, NULL, '2026-10-11 10:00:00+00', '2026-10-11 10:00:00+00', 'fr'),
  ('acc_drill2', '', 'bob@acme.dev', true, NULL, '2026-10-11 10:01:00+00', '2026-10-11 10:01:00+00', NULL);

INSERT INTO "account" ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt") VALUES
  ('lgn_drill1', 'alice@acme.dev', 'email', 'acc_drill1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-11 10:00:00+00', '2026-10-11 10:00:00+00'),
  ('lgn_drill2', '4242', 'github', 'acc_drill1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-11 10:02:00+00', '2026-10-11 10:02:00+00'),
  ('lgn_drill3', 'bob@acme.dev', 'email', 'acc_drill2', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-11 10:01:00+00', '2026-10-11 10:01:00+00');

INSERT INTO "organization" ("id", "name", "slug", "logo", "createdAt", "metadata") VALUES
  ('ws_drill1', 'Acme', 'ws_drill1', NULL, '2026-10-11 10:00:00+00', NULL);

INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES
  ('mem_drill1', 'ws_drill1', 'acc_drill1', 'owner', '2026-10-11 10:00:00+00'),
  ('mem_drill2', 'ws_drill1', 'acc_drill2', 'guest', '2026-10-11 10:01:00+00');

INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at) VALUES
  ('con_drill1', 'ws_drill1', 'rest', 'Hook', 'drill-not-a-sealed-key', 1);

INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES
  ('site_drill1', 'ws_drill1', 'https://acme.dev', 'members', 1),
  ('site_drill2', 'ws_drill1', 'https://two.dev', 'everyone', 2),
  ('site_drill3', 'ws_drill1', 'https://three.dev', 'members', 3),
  ('site_drill4', 'ws_drill1', 'https://four.dev', 'members', 4);

INSERT INTO site_destinations (site_id, position, connector_id, team_id, project_id, label) VALUES
  ('site_drill1', 0, 'con_drill1', NULL, NULL, 'Hook'),
  ('site_drill1', 1, 'con_drill1', 'team_1', NULL, 'Hook, team 1'),
  ('site_drill2', 0, 'con_drill1', NULL, NULL, NULL);

-- The domains of a workspace (FRU-103): one never proven, one proven that covers the previews of a
-- site, one whose proof is lost, and three more so the count is no other table's.
INSERT INTO domains (id, workspace_id, domain, created_at, verified_at, lost_at, checked_at, previews_site_id) VALUES
  ('dom_drill1', 'ws_drill1', 'pending.acme.dev', 1, NULL, NULL, NULL, NULL),
  ('dom_drill2', 'ws_drill1', 'preview.acme.dev', 2, 3, NULL, 3, 'site_drill1'),
  ('dom_drill3', 'ws_drill1', 'lost.acme.dev', 3, 4, 5, 5, 'site_drill2'),
  ('dom_drill4', 'ws_drill1', 'four.acme.dev', 4, NULL, NULL, 4, NULL),
  ('dom_drill5', 'ws_drill1', 'five.acme.dev', 5, 6, NULL, 6, NULL),
  ('dom_drill6', 'ws_drill1', 'six.acme.dev', 6, NULL, NULL, NULL, NULL);

INSERT INTO deliveries (id, connector_id, body, created_at, next_at) VALUES
  ('dlv_drill1', 'con_drill1', '{"note":"one"}', 1, 1),
  ('dlv_drill2', 'con_drill1', '{"note":"two"}', 2, NULL);

INSERT INTO email_links (code_hash, email, created_at, expires_at) VALUES
  ('drill-not-a-digest', 'alice@acme.dev', 1, 2);

INSERT INTO pairings (code_hash, subject, name, email, workspace, created_at, expires_at) VALUES
  ('drill-not-a-digest', 'alice', 'Alice Martin', 'alice@acme.dev', 'ws_drill1', 1, 2);

INSERT INTO sessions (token_hash, subject, workspace, created_at, expires_at, predecessor_hash, root_hash) VALUES
  ('drill-not-a-digest-1', 'alice', 'ws_drill1', 1, 2, NULL, NULL),
  ('drill-not-a-digest-2', 'alice', 'ws_drill1', 1, 2, 'drill-not-a-digest-1', 'drill-not-a-digest-1'),
  ('drill-not-a-digest-3', 'bob', NULL, 1, 2, NULL, NULL),
  ('drill-not-a-digest-4', 'bob', NULL, 1, 2, NULL, NULL),
  ('drill-not-a-digest-5', 'bob', NULL, 1, 2, NULL, NULL);

-- A session of an account (FRU-238): of the account, of no workspace, with the label of its browser.
INSERT INTO sessions (token_hash, subject, workspace, created_at, expires_at, account_id, browser, connection_id) VALUES
  ('drill-not-a-digest-6', 'acc_drill1', NULL, 1, 2, 'acc_drill1', 'Chrome on macOS', 'drill-connection-1');

-- A request of the extension that a person approved and the extension claimed (FRU-238).
INSERT INTO connect_requests (request_hash, claim_hash, word, browser, created_at, expires_at, outcome, account_id, answered_at, claimed_at, misses) VALUES
  ('drill-not-a-digest-request', 'drill-not-a-digest-claim', 'PLUM 47', 'Chrome on macOS', 1, 2, 'approved', 'acc_drill1', 1, 1, 1);

INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "browser", "userId", "activeOrganizationId") VALUES
  ('ses_drill1', '2026-10-18 10:00:00+00', 'drill-not-a-digest', '2026-10-11 10:00:00+00', '2026-10-11 10:00:00+00', NULL, NULL, 'Firefox on Linux', 'acc_drill1', 'ws_drill1');

INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES
  ('ver_drill1', 'drill-not-a-digest', 'alice@acme.dev', '2026-10-11 10:15:00+00', '2026-10-11 10:00:00+00', '2026-10-11 10:00:00+00');

INSERT INTO "invitation" ("id", "organizationId", "email", "role", "status", "expiresAt", "createdAt", "inviterId") VALUES
  ('inv_drill1', 'ws_drill1', 'carol@acme.dev', 'member', 'pending', '2026-10-18 10:00:00+00', '2026-10-11 10:00:00+00', 'acc_drill1'),
  ('inv_drill2', 'ws_drill1', 'dana@client.fr', 'guest', 'pending', '2026-10-18 10:00:00+00', '2026-10-11 10:03:00+00', 'acc_drill1');

-- The guest of one site (FRU-250): the site an invitation of a guest names, and the site shared with
-- Bob, who is a guest.
INSERT INTO invitation_sites (invitation_id, site_id) VALUES
  ('inv_drill2', 'site_drill3');
INSERT INTO site_shares (workspace_id, account_id, site_id, created_at) VALUES
  ('ws_drill1', 'acc_drill2', 'site_drill1', 1);

-- The picture of a note (FRU-44): the first bytes of a PNG, enough for a row that the drill compares.
INSERT INTO screenshots (id, workspace_id, account_id, site_id, content, width, height, created_at) VALUES
  ('shot_drill1', 'ws_drill1', 'acc_drill1', 'site_drill1', '\x89504e470d0a1a0a0000000d49484452', 120, 60, 1);

-- The notes the worker keeps itself, and the replies to them (FRU-218). An explicit number, as the
-- copy of a SQLite file writes them, and the sequence moved after it: a restore that left the
-- sequence at 1 would give the next note the number of one that exists. Three notes and two replies.
INSERT INTO seeds (id, client_id, page_url, stage, seed, created_at, updated_at) VALUES
  (1, 'site_drill1', 'https://staging.acme.dev/pricing', 'seeded', '{"id":"sd_drill1","note":"The price is cut off on a phone."}', 1, 1),
  (2, 'site_drill1', 'https://staging.acme.dev/pricing', 'ripe', '{"id":"sd_drill2","note":"Done."}', 2, 3),
  (7, NULL, 'https://staging.acme.dev/', 'seeded', '{"id":"sd_drill7","note":"A note that names no site."}', 4, 4);
SELECT setval(pg_get_serial_sequence('seeds', 'id'), 7);

INSERT INTO seed_comments (seed_id, author, body, created_at) VALUES
  (1, 'Alice Martin', 'We see it too.', 5),
  (1, NULL, 'Fixed in the next deployment.', 6);

-- What the replicas share (FRU-67): a count of the rate limiter. Nothing of it must survive a
-- restore, and the drill compares it like any other row.
INSERT INTO kv (key, value, expires_at) VALUES
  ('fruitback:drill:count', '3', 1);

-- The index of the notes (FRU-237): a note that went to a connector, and one the worker keeps.
INSERT INTO note_index (site_id, seed_id, workspace_id, page_url, excerpt, stage, channel, author_kind, author_account_id, place, connector_id, reference, reference_url, created_at, checked_at) VALUES
  ('site_drill1', 'sd_drill1', 'ws_drill1', 'https://staging.acme.dev/pricing', 'The price is cut off on a phone.', 'seeded', 'script', 'visitor', NULL, 'fruitback', NULL, 'FB-1', NULL, 1, 1),
  ('site_drill1', 'sd_drill9', 'ws_drill1', 'https://staging.acme.dev/', 'Sent to the hook.', 'ripe', 'extension', 'member', 'acc_drill1', 'connector', 'con_drill1', 'hook-1', NULL, 2, 3);

-- The day a member was last seen in the workspace (FRU-249).
INSERT INTO last_seen (member_id, day) VALUES
  ('mem_drill1', '2026-10-11');

-- A read of an administrator in a workspace they are not a member of (FRU-261): its trace, which the
-- owners of the workspace read.
INSERT INTO admin_reads (id, workspace_id, admin_account_id, admin_email, what, at) VALUES
  ('read_drill1', 'ws_drill1', 'acc_drill1', 'alice@acme.dev', 'workspace', 1760000000000);

-- An action of an administrator of the instance (FRU-280): its trace, which the administrators read.
INSERT INTO admin_actions (id, at, actor_account_id, actor_email, action, target_account_id, target_email, workspace_id, detail) VALUES
  ('ada_drill1', 1760000000000, 'acc_drill1', 'alice@acme.dev', 'admin-named', 'acc_drill2', 'bob@acme.dev', NULL, NULL);
