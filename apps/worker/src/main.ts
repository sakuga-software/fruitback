import { startServer } from './server';

/**
 * Container entry point, kept apart from `server.ts` so importing the server in a test does not bind
 * a port as a side effect.
 */
startServer();
