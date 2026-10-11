-- Rows for restore-drill.sh (FRU-143): at least one in every table of the worker, and not the same
-- number in each, so a table that a restore lost or mixed up shows in the counts.
-- The drill fails on a table with no row: a migration that adds a table adds its rows here.
-- Nothing here is a secret: no digest is the digest of a code, and no key opens anything.

INSERT INTO accounts (id, email, name, locale, created_at) VALUES
  ('acc_drill1', 'alice@acme.dev', 'Alice Martin', 'fr', 1),
  ('acc_drill2', 'bob@acme.dev', NULL, NULL, 2);

INSERT INTO logins (provider, subject, account_id, created_at) VALUES
  ('email', 'alice@acme.dev', 'acc_drill1', 1),
  ('github', '4242', 'acc_drill1', 2),
  ('email', 'bob@acme.dev', 'acc_drill2', 3);

INSERT INTO workspaces (id, name, created_at) VALUES ('ws_drill1', 'Acme', 1);

INSERT INTO members (workspace_id, account_id, role, created_at) VALUES
  ('ws_drill1', 'acc_drill1', 'owner', 1),
  ('ws_drill1', 'acc_drill2', 'guest', 2);

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

-- The tables of better-auth (FRU-144). No route of the worker writes them yet, so the drill does:
-- an empty table proves nothing. As the worker writes them (FRU-181): a digest in the place of the
-- token of a session and of a link, and the columns of the tokens of a provider empty.

INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") VALUES
  ('usr_drill1', 'Alice Martin', 'alice@acme.dev', true, NULL, '2026-10-11 10:00:00+00', '2026-10-11 10:00:00+00'),
  ('usr_drill2', 'Bob', 'bob@acme.dev', false, NULL, '2026-10-11 10:01:00+00', '2026-10-11 10:01:00+00');

INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId", "activeOrganizationId") VALUES
  ('ses_drill1', '2026-10-18 10:00:00+00', 'drill-not-a-digest', '2026-10-11 10:00:00+00', '2026-10-11 10:00:00+00', NULL, NULL, 'usr_drill1', 'org_drill1');

INSERT INTO "account" ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt") VALUES
  ('acn_drill1', '4242', 'github', 'usr_drill1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-11 10:00:00+00', '2026-10-11 10:00:00+00'),
  ('acn_drill2', '108', 'google', 'usr_drill1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-11 10:02:00+00', '2026-10-11 10:02:00+00'),
  ('acn_drill3', '4343', 'github', 'usr_drill2', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-11 10:01:00+00', '2026-10-11 10:01:00+00');

INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES
  ('ver_drill1', 'drill-not-a-digest', 'alice@acme.dev', '2026-10-11 10:15:00+00', '2026-10-11 10:00:00+00', '2026-10-11 10:00:00+00');

INSERT INTO "organization" ("id", "name", "slug", "logo", "createdAt", "metadata") VALUES
  ('org_drill1', 'Acme', 'acme', NULL, '2026-10-11 10:00:00+00', NULL);

INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES
  ('mbr_drill1', 'org_drill1', 'usr_drill1', 'owner', '2026-10-11 10:00:00+00'),
  ('mbr_drill2', 'org_drill1', 'usr_drill2', 'guest', '2026-10-11 10:01:00+00');

INSERT INTO "invitation" ("id", "organizationId", "email", "role", "status", "expiresAt", "createdAt", "inviterId") VALUES
  ('inv_drill1', 'org_drill1', 'carol@acme.dev', 'member', 'pending', '2026-10-18 10:00:00+00', '2026-10-11 10:00:00+00', 'usr_drill1');
