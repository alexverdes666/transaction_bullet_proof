import Link from 'next/link';
import { getSessionUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://bulletproof.example';

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Bullet Proof',
  applicationCategory: 'SecurityApplication',
  operatingSystem: 'Web',
  url: SITE_URL,
  description:
    'Bullet Proof safely simulates buying and selling any crypto token to detect honeypots and hidden taxes before you risk a cent.',
  offers: { '@type': 'Offer', category: 'Paid' },
};

export default async function Home() {
  const user = await getSessionUser();

  return (
    <main className="flex-1 bg-neutral-950 text-neutral-100">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <nav className="flex items-center justify-between px-6 py-4 border-b border-neutral-900">
        <span className="font-bold tracking-tight">🛡 Bullet Proof</span>
        <div className="flex gap-3 text-sm">
          {user ? (
            <Link href="/dashboard" className="rounded-md bg-neutral-100 text-neutral-900 px-4 py-2 font-medium">
              Open dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="px-4 py-2 text-neutral-300 hover:text-white">Log in</Link>
              <Link href="/register" className="rounded-md bg-neutral-100 text-neutral-900 px-4 py-2 font-medium">
                Get started
              </Link>
            </>
          )}
        </div>
      </nav>

      <section className="max-w-3xl mx-auto px-6 py-24 text-center">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">Know before you buy.</h1>
        <p className="mt-6 text-lg text-neutral-400">
          Many crypto coins are traps — you can buy them, but you can&apos;t sell. Bullet Proof
          safely test-drives any token in a private sandbox to detect <strong>honeypots</strong> and
          <strong> hidden taxes</strong>, before you risk a single cent.
        </p>
        <div className="mt-10 flex justify-center gap-4">
          <Link href={user ? '/dashboard' : '/register'} className="rounded-lg bg-emerald-500 text-neutral-950 px-6 py-3 font-semibold hover:bg-emerald-400">
            {user ? 'Scan a token' : 'Create your account'}
          </Link>
          <Link href="/login" className="rounded-lg border border-neutral-700 px-6 py-3 font-medium hover:border-neutral-500">
            Log in
          </Link>
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-6 pb-24 grid sm:grid-cols-3 gap-6 text-center">
        <Card icon="🟢" title="Safe to trade" body="Buyable and sellable with normal fees. No traps found." />
        <Card icon="🟡" title="Suspicious" body="Unusual hidden fees or odd behaviour. Proceed with caution." />
        <Card icon="🔴" title="Honeypot" body="You could buy, but you would not be able to sell. Stay away." />
      </section>

      <section className="max-w-3xl mx-auto px-6 pb-24">
        <h2 className="text-xl font-semibold text-center">How it works</h2>
        <ol className="mt-6 space-y-3 text-neutral-300 text-sm">
          <li><strong>1.</strong> We create a private copy of the live blockchain — a sandbox.</li>
          <li><strong>2.</strong> As a fresh wallet, we <em>buy</em> the token with pretend money.</li>
          <li><strong>3.</strong> We immediately try to <em>sell</em> it back.</li>
          <li><strong>4.</strong> We measure exactly what happened and give you a clear verdict.</li>
        </ol>
        <p className="mt-6 text-center text-neutral-400 text-sm">No real money is ever at risk during a scan.</p>
      </section>
    </main>
  );
}

function Card({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
      <div className="text-3xl">{icon}</div>
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-neutral-400">{body}</p>
    </div>
  );
}
