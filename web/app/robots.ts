import type { MetadataRoute } from 'next';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://bulletproof.example';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Authed app surfaces and the API have no SEO value. The secret admin path
      // is deliberately NOT listed here — listing it would leak it.
      disallow: ['/dashboard', '/buy', '/api/'],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
