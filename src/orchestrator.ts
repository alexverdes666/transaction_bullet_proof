/**
 * Master orchestration script.
 *
 *   [Start Anvil Fork]
 *     -> [Node State Snapshot]
 *       -> [Launch Python/Camoufox to drive the dApp Approve+Swap]
 *         -> [Node captures the resulting tx & diffs state]
 *           -> [Output clean JSON report]
 *
 * Usage:
 *   npm run orchestrate -- <tokenAddress> [--url <dappUrl>] [--simulate]
 *
 * If --url is omitted, the built-in local mock dApp is served and used, so the
 * full Node<->Python<->browser loop runs end-to-end with zero external setup.
 * --simulate skips the browser entirely and uses the deterministic engine.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isAddress, parseEther } from 'viem';
import { AnvilFork } from './anvil.js';
import { config } from './config.js';
import { testAccount } from './clients.js';
import { fundWallet } from './wallet.js';
import { runScan } from './scan.js';
import { startMockDapp, type MockDappHandle } from './mockDappServer.js';
import { printReport, saveReport } from './report.js';
import type { ExternalContext } from './scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PY_SERVICE = join(__dirname, '..', 'python', 'browser_service.py');

interface Args {
  token: string;
  url: string | null;
  simulate: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let url: string | null = null;
  let simulate = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--url') url = argv[++i] ?? null;
    else if (a === '--simulate') simulate = true;
    else positional.push(a);
  }
  return { token: positional[0] ?? '', url, simulate };
}

/** Spawn the Python/Camoufox browser service and resolve when it exits 0. */
function runBrowser(ctx: ExternalContext, dappUrl: string): Promise<void> {
  const buyWei = '0x' + parseEther(String(config.wallet.buyEth)).toString(16);
  const env = {
    ...process.env,
    SANDBOX_DAPP_URL: dappUrl,
    SANDBOX_RPC: ctx.rpcUrl,
    SANDBOX_ACCOUNT: ctx.wallet,
    SANDBOX_TOKEN: ctx.token,
    SANDBOX_ROUTER: config.dex.router,
    SANDBOX_WETH: config.dex.weth,
    SANDBOX_BUY_WEI: buyWei,
    SANDBOX_HEADLESS: config.python.headless ? '1' : '0',
  };
  console.log(`[orchestrator] launching Camoufox: ${config.python.bin} ${PY_SERVICE}`);
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(config.python.bin, [PY_SERVICE], {
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    proc.on('error', (e) =>
      reject(new Error(`failed to launch python (${config.python.bin}): ${e.message}`)),
    );
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`browser service exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.token || !isAddress(args.token)) {
    console.error('Usage: npm run orchestrate -- <tokenAddress> [--url <dappUrl>] [--simulate]');
    process.exit(2);
  }

  const fork = new AnvilFork();
  let dapp: MockDappHandle | null = null;

  try {
    // [1] Start the isolated fork up-front so we can share it across phases.
    await fork.start({ quiet: true });

    let report;
    if (args.simulate) {
      // Deterministic engine path (no browser).
      report = await runScan({ token: args.token, mode: 'simulate', fork });
    } else {
      // Browser path. Serve the local mock dApp unless an external URL is given.
      let dappUrl = args.url;
      if (!dappUrl) {
        dapp = await startMockDapp();
        const params = new URLSearchParams({
          rpc: fork.endpoint,
          account: testAccount.address,
          router: config.dex.router,
          weth: config.dex.weth,
          token: args.token,
          buyWei: '0x' + parseEther(String(config.wallet.buyEth)).toString(16),
        });
        dappUrl = `${dapp.url}/?${params.toString()}`;
        console.log(`[orchestrator] serving mock dApp at ${dappUrl}`);
      }

      // Fund the wallet before the browser drives transactions against it.
      await fundWallet(fork, testAccount.address);

      report = await runScan({
        token: args.token,
        mode: 'external',
        fork,
        externalInteraction: (ctx) => runBrowser(ctx, dappUrl!),
      });
    }

    printReport(report);
    const path = await saveReport(report);
    console.log(`Report written to ${path}`);
    process.exitCode = report.verdict === 'HONEYPOT' ? 1 : report.verdict === 'ERROR' ? 3 : 0;
  } catch (e) {
    console.error('[orchestrator] fatal:', (e as Error).message);
    process.exitCode = 3;
  } finally {
    if (dapp) await dapp.stop();
    await fork.stop();
  }
}

main();
