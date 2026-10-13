/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/landing/**/*.{ts,tsx}", "./src/shared/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // theme tokens (landing.css): every colour the landing uses follows the light or dark theme
      colors: {
        ink: "rgb(var(--ink) / <alpha-value>)",
        white: "rgb(var(--paper) / <alpha-value>)",
        wash: "rgb(var(--wash) / <alpha-value>)",
        "wash-2": "rgb(var(--wash-2) / <alpha-value>)",
        gray: {
          200: "rgb(var(--line) / <alpha-value>)",
          300: "rgb(var(--line-2) / <alpha-value>)",
          400: "rgb(var(--muted) / <alpha-value>)",
          500: "rgb(var(--muted) / <alpha-value>)",
          700: "rgb(var(--ink-2) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        serif: ["P22 Mackinac W01 Book", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
