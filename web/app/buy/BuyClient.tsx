'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Pack {
  id: string;
  name: string;
  credits: number;
  priceTokens: number;
}
interface Order {
  id: string;
  reference: string;
  credits: number;
  amount: string; // base units
  tokenSymbol: string;
  tokenDecimals: number;
  tokenAddress: string;
  chainId: number;
  treasury: string;
  expiresAt: string;
}

function fmtAmount(base: string, decimals: number): string {
  const b = BigInt(base);
  const d = BigInt(10) ** BigInt(decimals);
  const whole = b / d;
  const frac = (b % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — fail quietly.
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${label}`}
      className="shrink-0 text-xs rounded-md border border-neutral-700 px-2 py-1 hover:border-neutral-500"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export default function BuyClient({ packs, tokenSymbol }: { packs: Pack[]; tokenSymbol: string; tokenDecimals: number }) {
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [status, setStatus] = useState<'pending' | 'paid' | 'expired' | 'failed'>('pending');
  const [pendingPackId, setPendingPackId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function buy(packId: string) {
    setPendingPackId(packId);
    setError('');
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packId }),
    });
    const j = await res.json().catch(() => ({}));
    setPendingPackId(null);
    if (!res.ok) { setError(j.error ?? 'Could not create order'); return; }
    setOrder(j.order);
    setStatus('pending');
  }

  // Poll the order for on-chain confirmation.
  useEffect(() => {
    if (!order || status !== 'pending') return;
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/orders/${order.id}`);
      const j = await res.json().catch(() => ({}));
      if (j.status && j.status !== 'pending') {
        setStatus(j.status);
        if (j.status === 'paid') router.refresh();
      }
    }, 6000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [order, status, router]);

  if (order) {
    return (
      <div role="status" aria-live="polite" className="rounded-xl border border-neutral-800 bg-neutral-900 p-6 space-y-4">
        {status === 'paid' ? (
          <>
            <div className="text-2xl">✅</div>
            <h2 className="text-lg font-bold text-emerald-400">Payment confirmed</h2>
            <p className="text-sm text-neutral-300">{order.credits} credits have been added to your account.</p>
            <button onClick={() => router.push('/dashboard')} className="rounded-md bg-emerald-500 text-neutral-950 px-4 py-2 text-sm font-semibold">
              Back to dashboard
            </button>
          </>
        ) : status === 'expired' ? (
          <>
            <h2 className="text-lg font-bold text-yellow-400">Order expired</h2>
            <p className="text-sm text-neutral-400">This payment window closed. Start a new order.</p>
            <button onClick={() => setOrder(null)} className="rounded-md border border-neutral-700 px-4 py-2 text-sm">New order</button>
          </>
        ) : (
          <>
            <h2 className="text-lg font-bold">Send payment to confirm</h2>
            <p className="text-sm text-neutral-400">
              Send the <strong>exact</strong> amount of {order.tokenSymbol} below. The amount is unique to your order, so
              we can match it automatically. Credits arrive after on-chain confirmation.
            </p>
            <Field
              label={`Amount (${order.tokenSymbol})`}
              value={fmtAmount(order.amount, order.tokenDecimals)}
              copyLabel="exact amount"
            />
            <Field label="Send to (treasury address)" value={order.treasury} mono copyLabel="treasury address" />
            <Field label={`Token contract`} value={order.tokenAddress} mono copyLabel="token contract address" />
            <Field label="Chain ID" value={String(order.chainId)} />
            <div className="flex items-center gap-2 text-sm text-neutral-400">
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-yellow-400 animate-pulse motion-reduce:animate-none" />
              Waiting for payment… (checking every few seconds)
            </div>
            <button onClick={() => setOrder(null)} className="text-xs text-neutral-400 hover:text-neutral-300">Cancel</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
      <div className="grid sm:grid-cols-3 gap-4">
        {packs.map((p) => {
          const busy = pendingPackId === p.id;
          return (
            <div key={p.id} className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 flex flex-col">
              <h3 className="font-semibold">{p.name}</h3>
              <div className="mt-2 text-3xl font-bold">{p.credits}</div>
              <div className="text-xs text-neutral-400">credits</div>
              <div className="mt-3 text-sm text-neutral-300">{p.priceTokens} {tokenSymbol}</div>
              <button
                disabled={pendingPackId !== null}
                onClick={() => buy(p.id)}
                className="mt-4 rounded-md bg-emerald-500 text-neutral-950 py-2 text-sm font-semibold disabled:opacity-50 hover:bg-emerald-400"
              >
                {busy ? '…' : 'Buy'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  copyLabel,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyLabel?: string;
}) {
  return (
    <div>
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className={`flex-1 rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm break-all ${mono ? 'font-mono' : ''}`}>
          {value}
        </span>
        {copyLabel && <CopyButton value={value} label={copyLabel} />}
      </div>
    </div>
  );
}
