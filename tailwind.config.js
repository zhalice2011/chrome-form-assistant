/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      colors: {
        // 设计系统主色（来自 ui-ux-pro-max productivity tools 推荐）
        // 主调 = teal（专业、克制），CTA = orange（最终行动）
        brand: {
          50: '#F0FDFA',
          100: '#CCFBF1',
          200: '#99F6E4',
          500: '#14B8A6',
          600: '#0D9488', // primary
          700: '#0F766E',
          800: '#115E59',
        },
        cta: {
          50: '#FFF7ED',
          500: '#F97316',
          600: '#EA580C',
          700: '#C2410C',
        },
      },
    },
  },
  plugins: [],
};
