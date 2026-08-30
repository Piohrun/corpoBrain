import { serve } from '@hono/node-server';
import { createApp } from './app.ts';

const port = Number(process.env.CORPOBRAIN_PORT ?? 4747);
const hostname = '127.0.0.1'; // never bind externally

serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  console.log(`corpobrain listening on http://${info.address}:${info.port}`);
});
