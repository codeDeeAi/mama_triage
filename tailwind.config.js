/**
 * Tailwind configuration.
 *
 * The CSS is BUILT, not pulled from a CDN. For a project whose subject is low-bandwidth
 * accessibility in underserved communities, shipping a multi-megabyte stylesheet from a
 * third-party CDN would be a poor look as well as poor engineering. Purged output for
 * these pages is a few kilobytes and is served from the same origin.
 */
module.exports = {
  content: ['./views/**/*.ejs'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#0f1115', soft: '#171a21', line: '#262b36' },
        cream: '#faf7f2',
        brand: { DEFAULT: '#0b7a5a', dark: '#075c44', light: '#e6f4ef' },
        urgent: '#c0392b',
        warn: '#b9761f',
        calm: '#2f8f5b',
        telegram: '#229ed9',
        whatsapp: '#25d366',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      maxWidth: { readable: '38rem' },
    },
  },
  plugins: [],
};
