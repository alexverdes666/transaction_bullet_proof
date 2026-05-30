'use client';

import { useState } from 'react';

/** Second-factor unlock form shown to an authenticated admin before data loads. */
export default function AdminUnlock() {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await fetch('/api/admin/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    setBusy(false);
    if (res.ok) {
      window.location.reload();
    } else {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? 'Unlock failed');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 p-8 rounded-xl border border-neutral-800 bg-neutral-900">
        <h1 className="text-lg font-semibold">Restricted</h1>
        <label htmlFor="admin-key" className="text-sm text-neutral-400">Enter the access key to continue.</label>
        <input
          id="admin-key"
          name="key"
          type="password"
          aria-label="Access key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          placeholder="Access key"
        />
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <button
          disabled={busy}
          className="w-full rounded-md bg-neutral-100 text-neutral-900 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
