/** Sweeparr design tokens — 1:1 with the UI/UX spec §01. */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#0C0F16", raised: "#121722", overlay: "#1A2130", inset: "#0A0D12" },
        line: { DEFAULT: "#232B3D", subtle: "#1B2232" },
        ink: { hi: "#E8ECF4", mid: "#9AA5B8", low: "#5E6A80", faint: "#3E4756" },
        accent: { DEFAULT: "#5B8DEF", hover: "#77A2F4", subtle: "rgb(91 141 239 / 0.14)" },
        state: {
          active: "#8B96A8",
          candidate: "#D9A83C",
          "candidate-ink": "#E3B84E",
          scheduled: "#E5484D",
          "scheduled-ink": "#FF7B80",
          kept: "#3FA26F",
          "kept-ink": "#5FC08D",
          muted: "#6B7487",
          error: "#F76808",
          "error-ink": "#FF9B57",
        },
        chart: { 1: "#5B8DEF", 2: "#2FB8A6", 3: "#9A7BFF", 4: "#8B96A8" },
      },
      fontFamily: {
        sans: ["IBM Plex Sans", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
      fontSize: {
        display: ["28px", { lineHeight: "34px", fontWeight: "600", letterSpacing: "-0.01em" }],
        title: ["18px", { lineHeight: "24px", fontWeight: "600" }],
        heading: ["14px", { lineHeight: "20px", fontWeight: "600" }],
        body: ["13.5px", { lineHeight: "20px" }],
        small: ["12.5px", { lineHeight: "18px" }],
        micro: ["11px", { lineHeight: "14px", fontWeight: "600", letterSpacing: "0.08em" }],
      },
      borderRadius: { DEFAULT: "6px", lg: "10px", pill: "999px" },
      boxShadow: { overlay: "0 16px 48px rgb(0 0 0 / 0.5)" },
      spacing: { 4.5: "18px", 13: "52px" },
      keyframes: {
        "swp-pulse": { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.5" } },
        "swp-shimmer": { "0%": { backgroundPosition: "-200px 0" }, "100%": { backgroundPosition: "200px 0" } },
      },
      animation: {
        "swp-pulse": "swp-pulse 2.4s ease-in-out infinite",
        "swp-shimmer": "swp-shimmer 1.4s linear infinite",
      },
    },
  },
  plugins: [],
};
