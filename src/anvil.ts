/**
 * Programmatic lifecycle manager for an isolated local mainnet fork.
 *
 * Spawns `anvil --fork-url <upstream>` as a child process, waits until its
 * JSON-RPC endpoint is live, and exposes the snapshot / revert cheatcodes that
 * make state diffing possible. Each `AnvilFork` instance is fully isolated:
 * tearing it down discards every state change, so one malicious contract can
 * never contaminate the next scan.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createPublicClient, http, type Hash, type PublicClient } from 'viem';
import { config } from './config.js';
import { sleep } from './util.js';

/** Ask the OS for a free TCP port on loopback (port 0 = ephemeral). */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not allocate a free port'))));
    });
  });
}

export interface AnvilStartOptions {
  /** Override the upstream fork URL. */
  forkUrl?: string;
  /** Pin the fork to a specific block for reproducibility. */
  blockNumber?: bigint;
  /** Suppress anvil's stdout. Defaults to true (we only surface our own logs). */
  quiet?: boolean;
}

/**
 * Probe candidate upstream RPCs and return the first that answers a
 * `eth_blockNumber` within `timeoutMs`. Falls back to the first candidate so
 * anvil can still surface a meaningful connection error if all are down.
 */
async function pickHealthyRpc(candidates: string[], timeoutMs = 5000): Promise<string> {
  if (candidates.length <= 1) return candidates[0] ?? '';
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const json = (await res.json()) as { result?: string };
      if (res.ok && typeof json.result === 'string') {
        console.log(`[anvil] upstream RPC selected: ${url}`);
        return url;
      }
    } catch {
      console.warn(`[anvil] upstream RPC unhealthy, skipping: ${url}`);
    }
  }
  console.warn('[anvil] no healthy upstream RPC found; trying the first candidate anyway');
  return candidates[0]!;
}

export class AnvilFork {
  private proc: ChildProcess | null = null;
  private readonly requestedPort?: number;
  private port: number;
  private url: string;
  public client: PublicClient;

  /**
   * @param opts.port  Bind to this specific port. Omit (the default) to grab a
   *   free ephemeral port at {@link start} time, so multiple forks can run
   *   concurrently without colliding — this is what lets the worker serve
   *   parallel scans, each on its own port/process/state.
   */
  constructor(opts: { port?: number } = {}) {
    this.requestedPort = opts.port;
    this.port = opts.port ?? config.fork.anvilPort;
    this.url = `http://127.0.0.1:${this.port}`;
    // A plain HTTP transport pointed at the local fork. Recreated once the
    // process is up (and once the ephemeral port is known), but initialised here
    // so `.client` is always defined.
    this.client = createPublicClient({ transport: http(this.url) });
  }

  /** Spawn anvil and resolve only once the RPC endpoint answers. */
  async start(opts: AnvilStartOptions = {}): Promise<void> {
    if (this.proc) throw new Error('AnvilFork already started');

    // Allocate a free ephemeral port unless an explicit one was requested.
    if (this.requestedPort === undefined) {
      this.port = await findFreePort();
      this.url = `http://127.0.0.1:${this.port}`;
      this.client = createPublicClient({ transport: http(this.url) });
    }

    // Guard: never silently reconnect to a stray process squatting on our port.
    // (A classic Windows footgun: an orphaned anvil keeps the port and the next
    //  run unknowingly talks to its stale, mutated state.)
    if (await this.portIsAnswering()) {
      throw new Error(
        `[anvil] port ${this.port} is already serving JSON-RPC. ` +
          `A previous fork was likely not shut down. Free it (e.g. taskkill /IM anvil.exe /F) and retry.`,
      );
    }

    const blockNumber = opts.blockNumber ?? config.fork.blockNumber;

    // FORK_RPC_URL may list several endpoints (comma-separated). Free public RPCs
    // are flaky, so we probe them and fork from the first one that actually
    // answers — cheap insurance against a dead endpoint failing the whole run.
    const candidates = (opts.forkUrl ?? config.fork.rpcUrl)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const forkUrl = await pickHealthyRpc(candidates);

    const args = [
      '--fork-url', forkUrl,
      '--port', String(this.port),
      '--chain-id', String(config.fork.chainId),
      // Resilience against flaky free RPCs: anvil fetches fork state lazily, so a
      // single dropped upstream request mid-transaction can otherwise surface as
      // a spurious "revert" and a FALSE honeypot verdict. These make anvil itself
      // retry/back-off instead of failing the EVM call.
      '--retries', '10',
      '--timeout', '45000',
      '--fork-retry-backoff', '1000',
      '--no-rate-limit',
    ];
    if (blockNumber !== undefined) args.push('--fork-block-number', String(blockNumber));

    console.log(`[anvil] spawning: ${config.fork.anvilBin} ${args.join(' ')}`);

    // IMPORTANT: do NOT use shell:true. On Windows a shell wrapper means our
    // kill() only terminates cmd.exe, orphaning anvil.exe on the port. We spawn
    // the binary directly and kill the whole tree in stop().
    this.proc = spawn(config.fork.anvilBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.on('error', (e) => {
      console.error(
        `[anvil] failed to spawn. Is Foundry installed and ANVIL_BIN correct? (${config.fork.anvilBin})`,
        e.message,
      );
    });
    if (!opts.quiet) {
      this.proc.stdout?.on('data', (d) => process.stdout.write(`[anvil] ${d}`));
    }
    this.proc.stderr?.on('data', (d) => process.stderr.write(`[anvil:err] ${d}`));
    this.proc.on('exit', (code) => {
      if (code && code !== 0) console.error(`[anvil] exited with code ${code}`);
      this.proc = null;
    });

    await this.waitUntilReady();
    this.client = createPublicClient({ transport: http(this.url) });
    const block = await this.client.getBlockNumber();
    console.log(`[anvil] fork live at ${this.url} (forked block ${block})`);
  }

  /** Returns true if something already answers JSON-RPC on our port. */
  private async portIsAnswering(): Promise<boolean> {
    try {
      const probe = createPublicClient({ transport: http(this.url) });
      await probe.getChainId();
      return true;
    } catch {
      return false;
    }
  }

  private async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const probe = createPublicClient({ transport: http(this.url) });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error('[anvil] process died during startup');
      try {
        await probe.getChainId();
        return;
      } catch {
        await sleep(250);
      }
    }
    throw new Error(`[anvil] RPC did not become ready within ${timeoutMs}ms`);
  }

  /** Take an EVM snapshot. The returned id can later be passed to {@link revert}. */
  async snapshot(): Promise<Hash> {
    return (await this.rpc('evm_snapshot', [])) as Hash;
  }

  /** Revert the fork to a prior snapshot id. Returns true on success. */
  async revert(id: Hash): Promise<boolean> {
    return (await this.rpc('evm_revert', [id])) as boolean;
  }

  /** Set an account's ETH balance directly (anvil cheatcode). */
  async setBalance(address: string, wei: bigint): Promise<void> {
    await this.rpc('anvil_setBalance', [address, `0x${wei.toString(16)}`]);
  }

  /** Mine `n` blocks (used to advance past deadlines if needed). */
  async mine(n = 1): Promise<void> {
    await this.rpc('anvil_mine', [`0x${n.toString(16)}`]);
  }

  /** Raw JSON-RPC passthrough for anvil-specific cheatcodes viem doesn't model. */
  async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`[anvil] ${method} failed: ${json.error.message}`);
    return json.result;
  }

  get endpoint(): string {
    return this.url;
  }

  /** Kill the child process tree and free the port. Safe to call repeatedly. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      p.once('exit', finish);

      if (process.platform === 'win32' && p.pid !== undefined) {
        // taskkill /T terminates the entire tree, so even if a shell wrapper
        // ever sits in between, anvil.exe itself is reaped (no port orphan).
        spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        p.kill('SIGTERM');
      }

      // Hard-kill fallback if it ignores termination.
      setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish();
      }, 3000);
    });
    console.log('[anvil] stopped');
  }
}
