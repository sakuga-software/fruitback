import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('setup', 'routes/setup.tsx'),
  route('sign-in', 'routes/sign-in.tsx'),
  layout('routes/workspace.tsx', [
    route('w/:workspace/sites', 'routes/sites.tsx'),
    route('w/:workspace/connectors', 'routes/connectors.tsx'),
    route('w/:workspace/members', 'routes/members.tsx'),
    route('w/:workspace/account', 'routes/account.tsx'),
  ]),
] satisfies RouteConfig;
