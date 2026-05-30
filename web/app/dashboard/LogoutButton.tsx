'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/');
      router.refresh();
    } catch {
      setBusy(false);
    }
  }
  return (
    <button onClick={logout} disabled={busy} className="text-neutral-400 hover:text-white disabled:opacity-60">
      {busy ? 'Logging out…' : 'Log out'}
    </button>
  );
}
