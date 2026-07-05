/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ministry: { DEFAULT: '#2e7d32', dark: '#1b5e20', light: '#e8f5e9' },
        surface: { DEFAULT: '#f9f9ff', dim: '#d3daef' },
        'on-surface': { DEFAULT: '#141b2b', variant: '#40493d' },
        outline: { DEFAULT: '#707a6c', variant: '#bfcaba' },
        error: { DEFAULT: '#ba1a1a', container: '#ffdad6' },
        ghana: { red: '#EF3340', gold: '#FFD100', green: '#006B3F' },
      },
      fontFamily: {
        inter: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '0.125rem',
        lg: '0.25rem',
        xl: '0.5rem',
        full: '0.75rem',
      },
    },
  },
  plugins: [],
};
