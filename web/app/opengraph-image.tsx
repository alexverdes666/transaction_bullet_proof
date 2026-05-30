import { ImageResponse } from 'next/og';

// Image metadata
export const alt = 'Bullet Proof — Honeypot & Hidden-Tax Scanner';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// A simple branded card. Inline styles only — ImageResponse renders via Satori,
// which supports a flexbox subset and needs no external CSS or fonts here.
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          color: '#ededed',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 80, marginBottom: 24 }}>🛡 Bullet Proof</div>
        <div style={{ fontSize: 40, color: '#34d399', fontWeight: 700, marginBottom: 16 }}>
          Know before you buy.
        </div>
        <div
          style={{
            fontSize: 28,
            color: '#a3a3a3',
            maxWidth: 820,
            textAlign: 'center',
            display: 'flex',
          }}
        >
          Detect honeypots &amp; hidden taxes before you risk a cent.
        </div>
      </div>
    ),
    { ...size },
  );
}
