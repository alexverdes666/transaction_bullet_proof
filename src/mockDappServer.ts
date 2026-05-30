/**
 * Serves the static mock swap dApp (src/web/mock-dapp.html).
 *
 * Run standalone:  npm run mock-dapp
 * Or embed via {@link startMockDapp} from the orchestrator.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'web', 'mock-dapp.html');

export interface MockDappHandle {
  server: Server;
  url: string;
  stop: () => Promise<void>;
}

export async function startMockDapp(port = config.control.mockDappPort): Promise<MockDappHandle> {
  const html = await readFile(HTML_PATH, 'utf8');
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${port}`;
  return {
    server,
    url,
    stop: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Allow running directly as a standalone static server.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  startMockDapp().then((h) => {
    console.log(`[mock-dapp] serving ${HTML_PATH}`);
    console.log(`[mock-dapp] open ${h.url}/?rpc=http://127.0.0.1:8545&...`);
  });
}
