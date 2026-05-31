'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

// Persist the last scan result so it survives `router.refresh()` remounts AND a
// full browser refresh — it stays visible until the next scan replaces it.
const LAST_SCAN_KEY = 'bp_last_scan';

interface TokenInfo {
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  imageUrl?: string;
  priceUsd?: string;
  liquidityUsd?: number;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  dexId?: string;
  pairUrl?: string;
  websites?: string[];
  socials?: { type: string; url: string }[];
  detectedChainName?: string;
  detectedVia?: string;
  explorerUrl?: string;
}

interface Report {
  verdict: 'SAFE' | 'SUSPICIOUS' | 'HONEYPOT' | 'ERROR';
  riskScore: number;
  summary: string;
  chain?: string;
  chainName?: string;
  tokenInfo?: TokenInfo;
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

function fmtUsd(n?: number): string | null {
  if (n === undefined || n === null || !Number.isFinite(n)) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
function fmtPrice(s?: string): string | null {
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return '$0';
  if (n < 0.000001) return `$${n.toExponential(2)}`;
  if (n < 1) return `$${n.toPrecision(3)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}
function fmtAge(ms?: number): string | null {
  if (!ms) return null;
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 0) return null;
  const date = new Date(ms).toISOString().slice(0, 10);
  if (days === 0) return `today (${date})`;
  if (days < 30) return `${days}d ago (${date})`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago (${date})`;
  return `${(days / 365).toFixed(1)}y ago (${date})`;
}
function fmtSupply(raw?: string, decimals?: number, symbol?: string): string | null {
  if (!raw) return null;
  try {
    const d = decimals ?? 18;
    const v = Number(BigInt(raw) / (d > 0 ? 10n ** BigInt(d) : 1n));
    if (!Number.isFinite(v)) return null;
    const s = v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v.toLocaleString();
    return symbol ? `${s} ${symbol}` : s;
  } catch {
    return null;
  }
}

export default function ScanForm({ initialCredits }: { initialCredits: number }) {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [scannedToken, setScannedToken] = useState('');
  const [credits, setCredits] = useState(initialCredits);
  const [noCredits, setNoCredits] = useState(false);

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
      /* ignore malformed/blocked storage */
    }
  }, []);

  async function scan(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setReport(null);
    setNoCredits(false);

    const trimmed = token.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      setError('Enter a valid token contract address (0x followed by 40 hex characters).');
      return;
    }

    setBusy(true);
    // No chain sent — the engine auto-detects which network the token is on.
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: trimmed }),
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
      /* ignore storage failures */
    }
    router.refresh();
  }

  const style = report ? verdictStyle[report.verdict] : null;
  const info = report?.tokenInfo;

  return (
    <div className="space-y-6">
      <form onSubmit={scan} className="space-y-3">
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
        <p className="text-xs text-neutral-400">
          Just paste the address — we auto-detect the network (Ethereum, BNB Chain, Polygon, Base, Arbitrum, Avalanche).
        </p>
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
          {/* Header: token identity + verdict */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              {info?.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={info.imageUrl} alt="" width={44} height={44} className="rounded-full bg-neutral-800 shrink-0" />
              ) : (
                <div className="w-11 h-11 rounded-full bg-neutral-800 grid place-items-center text-neutral-500 text-lg shrink-0">?</div>
              )}
              <div className="min-w-0">
                <div className="font-semibold truncate">
                  {info?.name ?? 'Unknown token'}{' '}
                  {info?.symbol && <span className="text-neutral-400">({info.symbol})</span>}
                </div>
                <div className="flex items-center gap-2 text-xs text-neutral-400">
                  {(report.chainName ?? info?.detectedChainName) && (
                    <span className="rounded bg-neutral-800 px-2 py-0.5">{report.chainName ?? info?.detectedChainName}</span>
                  )}
                  {info?.dexId && <span className="capitalize">{info.dexId}</span>}
                </div>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-2xl">{style.emoji}</div>
              <div className={`text-sm font-bold ${style.text}`}>{style.label}</div>
              <div className="text-xs text-neutral-400">Risk {report.riskScore}/100</div>
            </div>
          </div>

          <p className="mt-4 text-sm text-neutral-300">{report.summary}</p>

          {/* Market stats */}
          {info && (fmtPrice(info.priceUsd) || fmtUsd(info.liquidityUsd) || fmtUsd(info.marketCap ?? info.fdv) || fmtAge(info.pairCreatedAt) || fmtSupply(info.totalSupply, info.decimals, info.symbol)) && (
            <dl className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              {fmtPrice(info.priceUsd) && <Stat label="Price" value={fmtPrice(info.priceUsd)!} />}
              {fmtUsd(info.liquidityUsd) && <Stat label="Liquidity" value={fmtUsd(info.liquidityUsd)!} />}
              {fmtUsd(info.marketCap ?? info.fdv) && <Stat label={info.marketCap ? 'Market cap' : 'FDV'} value={fmtUsd(info.marketCap ?? info.fdv)!} />}
              {fmtAge(info.pairCreatedAt) && <Stat label="Trading since" value={fmtAge(info.pairCreatedAt)!} />}
              {fmtSupply(info.totalSupply, info.decimals, info.symbol) && <Stat label="Total supply" value={fmtSupply(info.totalSupply, info.decimals, info.symbol)!} />}
            </dl>
          )}

          {/* Round-trip safety metrics */}
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

          {/* Links */}
          {info && (info.explorerUrl || info.pairUrl || (info.websites && info.websites.length) || (info.socials && info.socials.length)) && (
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {info.explorerUrl && <ExtLink href={info.explorerUrl}>Explorer ↗</ExtLink>}
              {info.pairUrl && <ExtLink href={info.pairUrl}>DexScreener ↗</ExtLink>}
              {info.websites?.[0] && <ExtLink href={info.websites[0]}>Website ↗</ExtLink>}
              {info.socials?.map((s, i) => <ExtLink key={i} href={s.url}>{s.type} ↗</ExtLink>)}
            </div>
          )}

          <div className="mt-4 border-t border-neutral-800 pt-3 text-xs text-neutral-500 font-mono break-all">
            {scannedToken}
            {info?.detectedVia && info.detectedVia !== 'none' && (
              <span className="ml-2 not-italic text-neutral-600">· detected via {info.detectedVia === 'dexscreener' ? 'DexScreener' : 'on-chain probe'}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-neutral-900/60 border border-neutral-800 px-3 py-2">
      <div className="text-neutral-400">{label}</div>
      <div className="font-semibold text-neutral-100 truncate">{value}</div>
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

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-emerald-400 hover:text-emerald-300 underline">
      {children}
    </a>
  );
}
