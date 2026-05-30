import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import FingerprintProbe from "./FingerprintProbe";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Bullet Proof — Honeypot & Hidden-Tax Scanner",
  description:
    "Know before you buy. Bullet Proof safely simulates buying and selling any crypto token to detect honeypots and hidden taxes — before you risk a cent.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <FingerprintProbe />
        {children}
      </body>
    </html>
  );
}
