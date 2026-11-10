import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// /iframe/:tenant
const tenant = decodeURIComponent(window.location.pathname.match(/^\/iframe\/([^/]+)\/?$/)?.[1] ?? "");

const root = document.getElementById("root");
if (!root) throw new Error("#root fehlt in index.html");
createRoot(root).render(<App tenant={tenant} />);
