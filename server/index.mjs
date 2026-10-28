import { createServer } from 'node:http';
import { createApp } from './app.mjs';
import { createRealtime } from './realtime.mjs';

const realtime = createRealtime();
const app = createApp({ broadcast: realtime.broadcast });
const server = createServer(app.handler);
realtime.attach(server, app);
server.listen(Number(process.env.PORT || 3100), process.env.HOST || '127.0.0.1', () => console.log(`Taste Heist → http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3100}`));
server.on('error', error => { console.error(`Could not start Taste Heist: ${error.message}`); realtime.close(); void app.close(); process.exitCode = 1; });
function shutdown() { realtime.close(); server.close(async () => { await app.close(); process.exit(0); }); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
