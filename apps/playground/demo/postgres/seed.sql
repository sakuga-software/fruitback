-- The workspace and the site of the public demonstration, for a worker whose notes are in
-- PostgreSQL (FRU-223). Prepared, not in use: docs/decisions/dev-loop.md says what is decided.
--
-- A worker with a database serves the sites of its workspaces and nothing else, and the page of
-- the demonstration names the site `playground` (apps/playground/app/fruitback.tsx). The console
-- makes a site for a person who signed in, and nobody signs in to the demonstration: these two
-- rows are what the console would have written, with no member.
--
-- Run it once the worker has made its tables (its first request does). It can run again: a row
-- that is there is left as it is. `:origin` is the address of the page, with no path.
--
--   psql -v ON_ERROR_STOP=1 -v origin=https://demo.fruitback.com -f seed.sql
INSERT INTO organization (id, name, slug, "createdAt")
VALUES ('ws_demo', 'Demonstration', 'ws_demo', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO sites (id, workspace_id, origin, visibility, created_at)
VALUES ('playground', 'ws_demo', :'origin', 'everyone', (extract(epoch FROM now()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;
