import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Im Build liefert der BFF index.html unter /iframe/:tenant aus. Im Dev-Modus
// übernimmt Vite das; die CSP setzt dann nur der BFF im Build (npm run build && npm start).
const iframeRoute = (): Plugin => ({
  name: "iframe-route",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/iframe\/[^/?#]+\/?(?:\?.*)?$/.test(req.url)) req.url = "/wc/index.html";
      next();
    });
  },
});

// Das Chatfenster liegt unter /iframe/:tenant, seine Assets unter /wc/.
// Im Dev-Modus leitet Vite die Webchat-API an den BFF (Port 8080) weiter.
export default defineConfig({
  base: "/wc/",
  root: "src/web",
  plugins: [react(), tailwindcss(), iframeRoute()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/wc/api": "http://localhost:8080",
    },
  },
});
