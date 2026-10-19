import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

/**
 * The page that mounts the kit once, for the specs that measure it (FRU-232). It is a route of the
 * development server only: a build has no `/kit`, and `kit-route.test.ts` holds that.
 *
 * `/kit/frame` is the rail of a workspace with every section of the mockup (FRU-234), on the same
 * terms: `frame.test.ts` holds it.
 */
const kit =
  process.env.NODE_ENV === 'production'
    ? []
    : [
        route('kit', 'kit-gallery.tsx'),
        route('kit/entry', 'kit-entry-gallery.tsx'),
        route('kit/frame', 'frame-probe.tsx'),
      ];

export default [
  index('routes/home.tsx'),
  route('setup', 'routes/setup.tsx'),
  route('sign-in', 'routes/sign-in.tsx'),
  route('invitations', 'routes/invitations.tsx'),
  route('connect/:request', 'routes/connect.tsx'),
  layout('routes/workspace.tsx', [
    route('w/:workspace/sites', 'routes/sites.tsx'),
    route('w/:workspace/notes', 'routes/notes.tsx'),
    route('w/:workspace/connectors', 'routes/connectors.tsx'),
    route('w/:workspace/members', 'routes/members.tsx'),
    route('w/:workspace/account', 'routes/account.tsx'),
  ]),
  layout('routes/admin.tsx', [route('admin', 'routes/admin-instance.tsx')]),
  ...kit,
] satisfies RouteConfig;
