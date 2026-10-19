import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Absolute URL used in the link-preview tags (og:image must be absolute).
// Set VITE_SITE_URL to override; on Vercel the production domain is picked up automatically.
const siteUrl = (
  process.env.VITE_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://paymybill.fun")
).replace(/\/$/, "");

export default defineConfig({
  plugins: [
    react(),
    {
      name: "site-url",
      transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", siteUrl),
    },
  ],
  define: { "process.env": {}, global: "globalThis" },
  build: { target: "es2020", chunkSizeWarningLimit: 900 },
});
