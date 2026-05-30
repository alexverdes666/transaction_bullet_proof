'use client';

import { useRouter } from 'next/navigation';

export default function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
    router.refresh();
  }
  return (
    <button onClick={logout} className="text-neutral-400 hover:text-white">
      Log out
    </button>
  );
}
