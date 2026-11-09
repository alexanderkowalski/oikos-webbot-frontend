// Strukturierte Logs (eine JSON-Zeile je Ereignis, lesbar für Cloud Logging).
// Nie Nachrichteninhalte, Tracking-Werte, IP-Adressen oder andere personenbezogene Daten loggen.
type Fields = Record<string, string | number | boolean | bigint | undefined | null>;

function write(severity: "INFO" | "WARNING" | "ERROR", message: string, fields: Fields) {
  const entry: Record<string, unknown> = { severity, message, time: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) entry[key] = typeof value === "bigint" ? Number(value) : value;
  }
  (severity === "ERROR" ? console.error : console.log)(JSON.stringify(entry));
}

export const log = {
  info: (message: string, fields: Fields = {}) => write("INFO", message, fields),
  warn: (message: string, fields: Fields = {}) => write("WARNING", message, fields),
  error: (message: string, fields: Fields = {}) => write("ERROR", message, fields),
};
