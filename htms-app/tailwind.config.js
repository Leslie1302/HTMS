/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ministry: { DEFAULT: '#2e7d32', dark: '#1b5e20', light: '#e8f5e9' },
      },
    },
  },
  plugins: [],
};
