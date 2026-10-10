/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/landing/**/*.{ts,tsx}", "./src/shared/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        serif: ["P22 Mackinac W01 Book", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
