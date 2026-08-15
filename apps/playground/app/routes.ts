import { type RouteConfig, index, route } from '@react-router/dev/routes';

/**
 * Two routes, because a pin belongs to a page. Navigating between them is what asks the question a
 * single page never does: the canonical URL changes, so the seeds do too.
 */
export default [index('routes/pricing.tsx'), route('checkout', 'routes/checkout.tsx')] satisfies RouteConfig;
