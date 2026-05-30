/**
 * CLI entrypoint for a one-shot honeypot scan.
 *
 *   npm run scan -- <tokenAddress> [--buy 1] [--json-only]
 *
 * Example (Ethereum mainnet USDC — should come back SAFE):
 *   npm run scan -- 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
 */
import { isAddress } from 'viem';
import { runScan } from './scan.js';
import { printReport, saveReport } from './report.js';
import { toJson } from './util.js';
import { config } from './config.js';

interface CliArgs {
  token: string;
  buyEth: number;
  jsonOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let buyEth = config.wallet.buyEth;
  let jsonOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--buy') buyEth = Number(argv[++i]);
    else if (a === '--json-only') jsonOnly = true;
    else positional.push(a);
  }
  const token = positional[0] ?? '';
  return { token, buyEth, jsonOnly };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.token || !isAddress(args.token)) {
    console.error('Usage: npm run scan -- <tokenAddress> [--buy <eth>] [--json-only]');
    console.error('  <tokenAddress> must be a valid 0x-prefixed address.');
    process.exit(2);
  }

  const report = await runScan({ token: args.token, buyEth: args.buyEth, mode: 'simulate' });

  if (args.jsonOnly) {
    console.log(toJson(report));
  } else {
    printReport(report);
    const path = await saveReport(report);
    console.log(`Report written to ${path}`);
  }

  // Exit code encodes the verdict so CI / scripts can gate on it.
  const code = report.verdict === 'HONEYPOT' ? 1 : report.verdict === 'ERROR' ? 3 : 0;
  process.exit(code);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(3);
});
