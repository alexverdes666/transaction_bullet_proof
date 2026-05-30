import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { connectDb } from '@/lib/db';
import { Scan } from '@/models/Scan';
import ScanForm from './ScanForm';
import LogoutButton from './LogoutButton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

export default async function Dashboard() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  await connectDb();
  // Only the scalar columns rendered below — avoid hydrating the full report blob.
  const recent = await Scan.find({ userId: user.id })
    .select('token verdict riskScore createdAt')
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  return (
    <main className="flex-1 bg-neutral-950 text-neutral-100">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-neutral-900">
        <Link href="/" className="font-bold tracking-tight">🛡 Bullet Proof</Link>
        <div className="flex items-center gap-4 text-sm">
          <span className="rounded-full bg-neutral-800 px-3 py-1">
            <strong>{user.credits}</strong> credits
          </span>
          <Link href="/buy" className="rounded-md bg-emerald-500 text-neutral-950 px-3 py-1.5 font-medium hover:bg-emerald-400">
            Buy credits
          </Link>
          <LogoutButton />
        </div>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">
        <div>
          <h1 className="text-2xl font-bold">Scan a token</h1>
          <p className="mt-1 text-neutral-400 text-sm">
            Paste a token&apos;s contract address (starts with <code>0x</code>). Each scan uses one credit.
          </p>
        </div>

        <ScanForm initialCredits={user.credits} />

        {recent.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-neutral-300 mb-2">Your recent scans</h2>
            <div className="rounded-lg border border-neutral-800 divide-y divide-neutral-800">
              {recent.map((s) => (
                <div key={String(s._id)} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="font-mono text-xs text-neutral-400 truncate max-w-[260px]">{s.token}</span>
                  <Verdict v={s.verdict} score={s.riskScore} />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function Verdict({ v, score }: { v: string; score: number }) {
  const map: Record<string, string> = {
    SAFE: 'text-emerald-400',
    SUSPICIOUS: 'text-yellow-400',
    HONEYPOT: 'text-red-400',
    ERROR: 'text-neutral-400',
  };
  return <span className={`font-semibold ${map[v] ?? ''}`}>{v} <span className="text-neutral-400">({score})</span></span>;
}
