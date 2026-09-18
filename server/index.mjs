import { createApiServer } from './api.mjs';
const port = Number(process.env.API_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT.');
const { server } = createApiServer();
server.listen(port, '127.0.0.1', () => console.log(`Square Studio local API: http://127.0.0.1:${port}`));
