/**
 * Rendering + persistence for a {@link HoneypotReport}: a human-readable
 * terminal summary and a JSON artifact under reports/.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HoneypotReport } from './types.js';
import { formatUnits, toJson } from './util.js';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function verdictColor(v: HoneypotReport['verdict']): string {
  switch (v) {
    case 'SAFE':
      return C.green;
    case 'SUSPICIOUS':
      return C.yellow;
    case 'HONEYPOT':
      return C.red;
    default:
      return C.dim;
  }
}

export function printReport(r: HoneypotReport): void {
  const vc = verdictColor(r.verdict);
  const line = '─'.repeat(64);
  console.log(`\n${C.bold}${line}${C.reset}`);
  console.log(`${C.bold} HONEYPOT SCAN — ${r.target}${C.reset}`);
  console.log(`${C.bold}${line}${C.reset}`);
  console.log(` Verdict   : ${vc}${C.bold}${r.verdict}${C.reset}  ${C.dim}(risk ${r.riskScore}/100)${C.reset}`);
  console.log(` Summary   : ${r.summary}`);
  console.log(` Fork      : chain ${r.fork.chainId} @ block ${r.fork.blockNumber}`);
  console.log(` Duration  : ${r.durationMs} ms`);

  if (r.roundTrip) {
    const rt = r.roundTrip;
    console.log(`\n ${C.cyan}Round-trip simulation${C.reset}`);
    console.log(`   buyable=${rt.canBuy}  sellable=${rt.canSell}`);
    console.log(
      `   ETH spent   : ${formatUnits(rt.ethSpent, 18)}  ->  tokens recv: ${formatUnits(rt.tokensReceived, rt.tokenDecimals)} ${rt.tokenSymbol}`,
    );
    console.log(
      `   tokens sold : ${formatUnits(rt.tokensSold, rt.tokenDecimals)} ${rt.tokenSymbol}  ->  ETH recv: ${formatUnits(rt.ethReceived, 18)}`,
    );
    console.log(
      `   buyTax=${fmtPct(rt.buyTax)}  sellTax=${fmtPct(rt.sellTax)}  roundTripLoss=${fmtPct(rt.roundTripLoss)}`,
    );
    if (rt.revertReason) console.log(`   ${C.red}revert: ${rt.revertReason}${C.reset}`);
  }

  if (r.balanceDiff.length) {
    console.log(`\n ${C.cyan}Balance diff${C.reset}`);
    for (const d of r.balanceDiff) {
      const sign = d.delta > 0n ? '+' : '';
      const col = d.delta > 0n ? C.green : d.delta < 0n ? C.red : C.dim;
      console.log(
        `   ${d.symbol.padEnd(8)} ${col}${sign}${formatUnits(d.delta, d.decimals)}${C.reset} ${C.dim}(${formatUnits(d.before, d.decimals)} -> ${formatUnits(d.after, d.decimals)})${C.reset}`,
      );
    }
  }

  if (r.storageDiff.length) {
    console.log(`\n ${C.cyan}Storage slot diff${C.reset}`);
    for (const s of r.storageDiff) {
      console.log(`   ${s.label}`);
      console.log(`     ${C.dim}${s.slot}${C.reset}`);
      console.log(`     ${s.before} -> ${s.after}`);
    }
  }

  if (r.anomalies.length) {
    console.log(`\n ${C.cyan}Anomalies${C.reset}`);
    for (const a of r.anomalies) {
      const col = a.severity === 'critical' ? C.red : a.severity === 'warning' ? C.yellow : C.dim;
      console.log(`   ${col}[${a.severity.toUpperCase()}] ${a.code}${C.reset} — ${a.message}`);
    }
  }
  console.log(`${C.bold}${line}${C.reset}\n`);
}

function fmtPct(frac: number): string {
  if (frac < 0) return 'n/a';
  return `${(frac * 100).toFixed(1)}%`;
}

/** Persist the report as JSON and return the file path. */
export async function saveReport(r: HoneypotReport, dir = 'reports'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const safe = r.target.toLowerCase();
  const stamp = r.generatedAt.replace(/[:.]/g, '-');
  const path = join(dir, `${safe}_${stamp}.json`);
  await writeFile(path, toJson(r), 'utf8');
  return path;
}
