import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx,js,jsx,mdx}',
    './components/**/*.{ts,tsx,js,jsx,mdx}',
    './lib/**/*.{ts,tsx,js,jsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: 'var(--color-ink)',
        paper: 'var(--color-paper)',
        sage: 'var(--color-sage)',
        moss: 'var(--color-moss)',
        copper: 'var(--color-copper)',
        fog: 'var(--color-fog)',
      },
      fontFamily: {
        display: ['var(--font-newsreader)', 'serif'],
        body: ['var(--font-jakarta)', 'sans-serif'],
        mono: ['var(--font-plex-mono)', 'monospace'],
      },
      boxShadow: {
        editorial: '0 40px 110px rgba(18, 19, 22, 0.10)',
        float: '0 24px 60px rgba(18, 19, 22, 0.14)',
      },
      borderRadius: {
        editorial: '2rem',
      },
    },
  },
  plugins: [],
};

export default config;
