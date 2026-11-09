// Liefert dev/parent.html auf einem eigenen Origin aus (Standard: http://localhost:5174).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.PARENT_PORT ?? 5174);
const page = new URL("./parent.html", import.meta.url);

createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(readFileSync(page));
}).listen(port, () => console.log(`Testseite: http://localhost:${port}/?tenant=hh`));
