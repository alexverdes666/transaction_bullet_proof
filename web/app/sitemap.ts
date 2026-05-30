import type { MetadataRoute } from 'next';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://bulletproof.example';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  // Only public, indexable pages. Authed app routes and the admin path are omitted.
  return [
    { url: `${siteUrl}/`, lastModified, changeFrequency: 'weekly', priority: 1 },
    { url: `${siteUrl}/login`, lastModified, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${siteUrl}/register`, lastModified, changeFrequency: 'yearly', priority: 0.8 },
  ];
}
