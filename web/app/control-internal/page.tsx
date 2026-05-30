import { notFound } from 'next/navigation';
import { connectDb } from '@/lib/db';
import { adminGate } from '@/lib/auth';
import { reqContextFromHeaders } from '@/lib/request';
import { audit } from '@/lib/audit';
import { User } from '@/models/User';
import { Scan } from '@/models/Scan';
import { Order } from '@/models/Order';
import { AuditLog } from '@/models/AuditLog';
import AdminUnlock from './AdminUnlock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fmt(d: unknown): string {
  if (!d) return '—';
  const date = new Date(d as string);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().replace('T', ' ').slice(0, 19);
}

export default async function AdminPage() {
  const ctx = await reqContextFromHeaders();
  const { gate, user } = await adminGate(ctx);

  // Hide the panel entirely from non-admins / blocked IPs.
  if (gate === 'not_admin' || gate === 'ip_blocked') notFound();
  if (gate === 'needs_unlock') return <AdminUnlock />;

  await connectDb();
  await audit({ type: 'admin_view', ctx, userId: user!.id, email: user!.email });

  const [users, scans, orders, logs, counts] = await Promise.all([
    User.find().sort({ createdAt: -1 }).limit(200).lean(),
    Scan.find().sort({ createdAt: -1 }).limit(100).lean(),
    Order.find().sort({ createdAt: -1 }).limit(100).lean(),
    AuditLog.find().sort({ createdAt: -1 }).limit(200).lean(),
    Promise.all([
      User.countDocuments(),
      Scan.countDocuments(),
      Order.countDocuments({ status: 'paid' }),
    ]),
  ]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6 space-y-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Bullet Proof — Control Panel</h1>
        <span className="text-xs text-neutral-500">signed in as {user!.email}</span>
      </header>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Users" value={counts[0]} />
        <Stat label="Scans" value={counts[1]} />
        <Stat label="Paid orders" value={counts[2]} />
      </div>

      <Section title={`Users (${users.length})`}>
        <Table head={['Email', 'Role', 'Status', 'Credits', 'Last login', 'IPs', 'Fingerprints']}>
          {users.map((u) => (
            <tr key={String(u._id)} className="border-t border-neutral-800 align-top">
              <Td>{u.email}</Td>
              <Td>{u.role}</Td>
              <Td className={u.status === 'banned' ? 'text-red-400' : 'text-green-400'}>{u.status}</Td>
              <Td>{u.credits}</Td>
              <Td>{fmt(u.lastLoginAt)}</Td>
              <Td className="max-w-[200px]">
                {(u.ips ?? []).map((ip) => `${ip.ip} (${ip.count})`).join(', ') || '—'}
              </Td>
              <Td className="max-w-[220px] break-all">
                {(u.fingerprints ?? []).map((f) => `${f.hash.slice(0, 12)}… (${f.count})`).join(', ') || '—'}
              </Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title={`Recent scans (${scans.length})`}>
        <Table head={['When', 'User', 'Token', 'Verdict', 'Risk', 'IP', 'Fingerprint']}>
          {scans.map((s) => (
            <tr key={String(s._id)} className="border-t border-neutral-800">
              <Td>{fmt(s.createdAt)}</Td>
              <Td>{String(s.userId).slice(-6)}</Td>
              <Td className="font-mono text-xs">{s.token}</Td>
              <Td>{s.verdict}</Td>
              <Td>{s.riskScore}</Td>
              <Td>{s.ip}</Td>
              <Td className="font-mono text-xs">{(s.fingerprint ?? '').slice(0, 12)}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title={`Orders (${orders.length})`}>
        <Table head={['When', 'User', 'Pack', 'Credits', 'Amount', 'Status', 'Tx']}>
          {orders.map((o) => (
            <tr key={String(o._id)} className="border-t border-neutral-800">
              <Td>{fmt(o.createdAt)}</Td>
              <Td>{String(o.userId).slice(-6)}</Td>
              <Td>{o.packId}</Td>
              <Td>{o.credits}</Td>
              <Td>{o.amount} {o.tokenSymbol}</Td>
              <Td>{o.status}</Td>
              <Td className="font-mono text-xs">{(o.txHash ?? '').slice(0, 14) || '—'}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title={`Activity log (${logs.length})`}>
        <Table head={['When', 'Type', 'Email', 'IP', 'Fingerprint', 'Detail']}>
          {logs.map((l) => (
            <tr key={String(l._id)} className="border-t border-neutral-800">
              <Td>{fmt(l.createdAt)}</Td>
              <Td>{l.type}</Td>
              <Td>{l.email ?? '—'}</Td>
              <Td>{l.ip}</Td>
              <Td className="font-mono text-xs">{(l.fingerprint ?? '').slice(0, 12)}</Td>
              <Td className="max-w-[280px] truncate text-xs text-neutral-400">{JSON.stringify(l.detail)}</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-neutral-300">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-neutral-800">{children}</div>
    </section>
  );
}
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-neutral-900 text-neutral-400">
        <tr>{head.map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}
