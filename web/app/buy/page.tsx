import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { CREDIT_PACKS } from '@/lib/payments';
import { env } from '@/lib/env';
import BuyClient from './BuyClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function BuyPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  // Pricing is read server-side; the client only ever sends a packId.
  const packs = CREDIT_PACKS.map((p) => ({ ...p }));
  const paymentsConfigured = Boolean(env.pay.treasury);

  return (
    <main className="flex-1 bg-neutral-950 text-neutral-100">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-neutral-900">
        <Link href="/dashboard" className="font-bold tracking-tight">🛡 Bullet Proof</Link>
        <span className="rounded-full bg-neutral-800 px-3 py-1 text-sm"><strong>{user.credits}</strong> credits</span>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-12 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Buy scan credits</h1>
          <p className="mt-1 text-neutral-400 text-sm">
            Pay in {env.pay.tokenSymbol} on chain. Credits are added automatically once your payment confirms.
          </p>
        </div>

        {!paymentsConfigured ? (
          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm">
            Payments are not yet configured for this deployment.
          </div>
        ) : (
          <BuyClient packs={packs} tokenSymbol={env.pay.tokenSymbol} tokenDecimals={env.pay.tokenDecimals} />
        )}
      </div>
    </main>
  );
}
