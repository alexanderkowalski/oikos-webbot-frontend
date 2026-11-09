import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// /iframe/:tenant
const tenant = decodeURIComponent(window.location.pathname.match(/^\/iframe\/([^/]+)\/?$/)?.[1] ?? "");

createRoot(document.getElementById("root")!).render(<App tenant={tenant} />);
