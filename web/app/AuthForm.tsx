'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      router.push('/dashboard');
      router.refresh();
    } else {
      setError(j.error ?? 'Something went wrong');
    }
  }

  return (
    <main className="flex-1 flex items-center justify-center bg-neutral-950 text-neutral-100 px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 p-8 rounded-xl border border-neutral-800 bg-neutral-900">
        <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">← Bullet Proof</Link>
        <h1 className="text-xl font-bold">{isRegister ? 'Create your account' : 'Welcome back'}</h1>

        <div>
          <label className="text-xs text-neutral-400">Email</label>
          <input
            type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email"
            className="mt-1 w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </div>
        <div>
          <label className="text-xs text-neutral-400">Password{isRegister && ' (min 10 characters)'}</label>
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            className="mt-1 w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button disabled={busy} className="w-full rounded-md bg-emerald-500 text-neutral-950 py-2 text-sm font-semibold disabled:opacity-50 hover:bg-emerald-400">
          {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
        </button>

        <p className="text-sm text-neutral-500 text-center">
          {isRegister ? (
            <>Already have an account? <Link href="/login" className="text-neutral-300 hover:text-white">Log in</Link></>
          ) : (
            <>New here? <Link href="/register" className="text-neutral-300 hover:text-white">Create an account</Link></>
          )}
        </p>
      </form>
    </main>
  );
}
