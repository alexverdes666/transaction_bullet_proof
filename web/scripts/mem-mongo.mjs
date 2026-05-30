// Dev-only: start an in-memory MongoDB on a fixed port for smoke testing.
import { MongoMemoryServer } from 'mongodb-memory-server';

const server = await MongoMemoryServer.create({ instance: { port: 27017, dbName: 'bptest' } });
console.log('MEM_MONGO_URI=' + server.getUri());
console.log('READY');

process.on('SIGINT', async () => { await server.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await server.stop(); process.exit(0); });
// Keep alive.
setInterval(() => {}, 1 << 30);
