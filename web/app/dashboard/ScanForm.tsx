'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

// Persist the last scan result so it survives `router.refresh()` remounts AND a
// full browser refresh — it stays visible until the next scan replaces it.
const LAST_SCAN_KEY = 'bp_last_scan';

// Chains the engine supports (keep in sync with web/lib/validation.ts).
const CHAINS = [
  { key: 'ethereum', name: 'Ethereum' },
  { key: 'bsc', name: 'BNB Smart Chain' },
  { key: 'polygon', name: 'Polygon' },
  { key: 'base', name: 'Base' },
  { key: 'arbitrum', name: 'Arbitrum One' },
  { key: 'avalanche', name: 'Avalanche C-Chain' },
] as const;

interface Report {
  verdict: 'SAFE' | 'SUSPICIOUS' | 'HONEYPOT' | 'ERROR';
  riskScore: number;
  summary: string;
  anomalies: { severity: string; code: string; message: string }[];
  roundTrip: {
    canBuy: boolean;
    canSell: boolean;
    buyTax: number;
    sellTax: number;
    roundTripLoss: number;
  } | null;
}

const verdictStyle: Record<string, { ring: string; text: string; emoji: string; label: string }> = {
  SAFE: { ring: 'border-emerald-500/40 bg-emerald-500/10', text: 'text-emerald-400', emoji: '🟢', label: 'Safe to trade' },
  SUSPICIOUS: { ring: 'border-yellow-500/40 bg-yellow-500/10', text: 'text-yellow-400', emoji: '🟡', label: 'Suspicious' },
  HONEYPOT: { ring: 'border-red-500/40 bg-red-500/10', text: 'text-red-400', emoji: '🔴', label: 'Honeypot — do not buy' },
  ERROR: { ring: 'border-neutral-700 bg-neutral-800/40', text: 'text-neutral-400', emoji: '⚪', label: 'Could not complete' },
};

export default function ScanForm({ initialCredits }: { initialCredits: number }) {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [scannedToken, setScannedToken] = useState('');
  const [credits, setCredits] = useState(initialCredits);
  const [noCredits, setNoCredits] = useState(false);
  const [chain, setChain] = useState('ethereum');

  // Restore the last result on mount so it survives a router.refresh() remount
  // or a full page refresh.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LAST_SCAN_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { token: string; report: Report };
        if (parsed?.report) {
          setReport(parsed.report);
          setScannedToken(parsed.token ?? '');
        }
      }
    } catch {
      // ignore malformed/blocked storage
    }
  }, []);

  async function scan(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setReport(null);
    setNoCredits(false);

    // Client-side shape check: a token address is 0x + 40 hex chars. UX guard
    // only — the server re-validates.
    const trimmed = token.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      setError('Enter a valid token contract address (0x followed by 40 hex characters).');
      return;
    }

    setBusy(true);
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: trimmed, chain }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);

    if (res.status === 402) {
      setNoCredits(true);
      return;
    }
    if (!res.ok) {
      setError(j.error ?? 'Scan failed');
      return;
    }
    setReport(j.report);
    setScannedToken(trimmed);
    setCredits(j.creditsRemaining);
    try {
      localStorage.setItem(LAST_SCAN_KEY, JSON.stringify({ token: trimmed, report: j.report }));
    } catch {
      // ignore storage failures (private mode / quota) — result still shows in-session
    }
    router.refresh();
  }

  const style = report ? verdictStyle[report.verdict] : null;

  return (
    <div className="space-y-6">
      <form onSubmit={scan} className="space-y-3">
        <div>
          <label htmlFor="scan-chain" className="block text-xs text-neutral-300 mb-1">Network</label>
          <select
            id="scan-chain"
            name="chain"
            value={chain}
            onChange={(e) => setChain(e.target.value)}
            className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-4 py-3 text-sm outline-none focus:border-emerald-500"
          >
            {CHAINS.map((c) => (
              <option key={c.key} value={c.key}>{c.name}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-neutral-400">
            Pick the chain the token is deployed on. Wrong network → &ldquo;not a token&rdquo;.
          </p>
        </div>
        <label htmlFor="scan-token" className="sr-only">Token contract address</label>
        <input
          id="scan-token"
          name="token"
          aria-label="Token contract address"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="0x… token contract address"
          className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-4 py-3 font-mono text-sm outline-none focus:border-emerald-500"
        />
        <button
          disabled={busy || !token}
          className="w-full rounded-lg bg-emerald-500 text-neutral-950 py-3 font-semibold disabled:opacity-50 hover:bg-emerald-400"
        >
          {busy ? 'Scanning… (this takes a few seconds)' : `Check this token  ·  ${credits} credits`}
        </button>
      </form>

      {noCredits && (
        <div role="status" aria-live="polite" className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm">
          You&apos;re out of credits. <Link href="/buy" className="underline font-medium">Buy a pack</Link> to keep scanning.
        </div>
      )}
      {error && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}

      {report && style && (
        <div role="status" aria-live="polite" className={`rounded-xl border p-6 ${style.ring}`}>
          <div className="flex items-center gap-3">
            <span className="text-3xl">{style.emoji}</span>
            <div>
              <div className={`text-lg font-bold ${style.text}`}>{style.label}</div>
              <div className="text-xs text-neutral-400">Risk score {report.riskScore}/100</div>
            </div>
          </div>
          {scannedToken && (
            <p className="mt-3 font-mono text-xs text-neutral-500 break-all">Result for {scannedToken}</p>
          )}
          <p className="mt-4 text-sm text-neutral-300">{report.summary}</p>

          {report.roundTrip && (
            <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
              <Metric label="Buyable" value={report.roundTrip.canBuy ? 'Yes' : 'No'} good={report.roundTrip.canBuy} />
              <Metric label="Sellable" value={report.roundTrip.canSell ? 'Yes' : 'No'} good={report.roundTrip.canSell} />
              <Metric
                label="Sell tax"
                value={report.roundTrip.sellTax >= 0 ? `${(report.roundTrip.sellTax * 100).toFixed(1)}%` : 'n/a'}
                good={report.roundTrip.sellTax >= 0 && report.roundTrip.sellTax < 0.1}
              />
            </div>
          )}

          {report.anomalies.length > 0 && (
            <ul className="mt-4 space-y-1 text-xs">
              {report.anomalies.map((a, i) => (
                <li key={i} className={a.severity === 'critical' ? 'text-red-300' : a.severity === 'warning' ? 'text-yellow-300' : 'text-neutral-400'}>
                  • {a.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="rounded-lg bg-neutral-900/60 border border-neutral-800 py-3">
      <div className={`text-base font-semibold ${good ? 'text-emerald-400' : 'text-red-400'}`}>{value}</div>
      <div className="text-neutral-400">{label}</div>
    </div>
  );
}
