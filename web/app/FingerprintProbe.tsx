'use client';

import { useEffect } from 'react';

/**
 * Computes a stable browser fingerprint from device/canvas/WebGL signals and
 * stores it in a cookie (`bp_fp`) so the server can attach it to every request,
 * powering the admin panel's per-user tracking. Runs once on mount.
 */
export default function FingerprintProbe() {
  useEffect(() => {
    if (document.cookie.includes('bp_fp=')) return; // already set this browser
    void computeAndStore();
  }, []);
  return null;
}

async function computeAndStore() {
  try {
    const signals = [
      navigator.userAgent,
      navigator.language,
      (navigator.languages ?? []).join(','),
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      String(new Date().getTimezoneOffset()),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      String(navigator.hardwareConcurrency ?? ''),
      String((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? ''),
      navigator.platform ?? '',
      canvasSignal(),
      webglSignal(),
    ];
    const hash = await sha256(signals.join('|'));
    document.cookie = `bp_fp=${hash}; path=/; max-age=31536000; samesite=strict`;
  } catch {
    /* fingerprinting is best-effort */
  }
}

function canvasSignal(): string {
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (!ctx) return 'no-canvas';
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('BulletProof🛡', 2, 15);
    return c.toDataURL().slice(-64);
  } catch {
    return 'canvas-err';
  }
}

function webglSignal(): string {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl') ?? c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'no-webgl';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '';
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    return `${vendor}~${renderer}`;
  } catch {
    return 'webgl-err';
  }
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
