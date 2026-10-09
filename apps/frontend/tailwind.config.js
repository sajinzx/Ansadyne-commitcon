/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)', panel: 'var(--panel)', panel2: 'var(--panel-2)', line: 'var(--line)', line2: 'var(--line-2)',
        text: 'var(--text)', muted: 'var(--muted)', faint: 'var(--faint)',
        opt: 'var(--opt)', b1: 'var(--b1)', b0: 'var(--b0)', caution: 'var(--caution)', bad: 'var(--bad)', good: 'var(--good)', wet: 'var(--wet)',
      },
      fontFamily: {
        cond: ['"Barlow Condensed"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
