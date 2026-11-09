import { readFileSync } from "node:fs";
import type { Texts } from "../src/shared/api";

const hh = JSON.parse(readFileSync(new URL("../tenants/hh.json", import.meta.url), "utf8")) as { texts: Texts };

export const texts = hh.texts;
