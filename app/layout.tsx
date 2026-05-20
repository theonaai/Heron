import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono, Newsreader } from 'next/font/google';
import './globals.css';

// AAP-62 — switched body font Plus_Jakarta_Sans → Inter and mono
// IBM_Plex_Mono → JetBrains_Mono. Plus Jakarta's narrow glyphs render
// poorly at 13-14px; Inter is purpose-built for UI at small sizes and
// is what claude.ai uses for its body copy. JetBrains Mono has a more
// even rhythm than Plex Mono at the sizes we render code samples at.
// The CSS variable names stay `--font-jakarta` / `--font-plex-mono`
// to avoid a global rename — they now point at Inter / JetBrains Mono.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

const newsreader = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-newsreader',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Heron',
  description: 'Open-source agent interrogator — audit what your AI agents do, need, and access.',
  icons: {
    icon: '/heron_logo.svg',
    shortcut: '/heron_logo.svg',
    apple: '/heron_logo.svg',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${newsreader.variable}`}
    >
      <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
