import type { Config } from 'tailwindcss'

/** Tokens transcribed from the approved Stitch design system ("Apex Precision Academic"). */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#FFFFFF',
        deck: '#F8FAFC',
        line: { DEFAULT: '#E2E8F0', strong: '#CBD5E1' },
        ink: { DEFAULT: '#0B132B', soft: '#1C2541', muted: '#64748B' },
        primary: { DEFAULT: '#4361EE', press: '#3651D4', wash: 'rgba(67,97,238,0.05)' },
        mastery: '#10B981',
        velocity: '#F59E0B',
        deficit: '#EF4444',
        tier: { l1: '#3B82F6', l2: '#10B981', l3: '#F59E0B', l4: '#F97316', l5: '#8B5CF6' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        'headline-xl': ['2.5rem', { lineHeight: '3rem', letterSpacing: '-0.03em', fontWeight: '700' }],
        'headline-lg': ['1.75rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em', fontWeight: '600' }],
        'headline-sm': ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em', fontWeight: '600' }],
        'body-lg': ['1.125rem', { lineHeight: '1.875rem' }],
        'body-md': ['1rem', { lineHeight: '1.625rem' }],
        'body-sm': ['0.875rem', { lineHeight: '1.375rem' }],
        'metric-lg': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.02em', fontWeight: '600' }],
        'label-sm': ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.04em', fontWeight: '500' }],
      },
      borderRadius: { DEFAULT: '0.25rem', md: '0.375rem', lg: '0.5rem', xl: '0.75rem' },
      spacing: { gutter: '1.5rem', margin: '2rem' },
      boxShadow: { pop: '0px 4px 16px -2px rgba(11,19,43,0.08)' },
      maxWidth: { shell: '1280px' },
    },
  },
  plugins: [],
} satisfies Config
