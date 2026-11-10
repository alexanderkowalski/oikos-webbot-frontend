// Agent-Texte: Links in alter Schreibweise {{Text}}(url) oder als Markdown [Text](url),
// Buttons als [Text] ohne folgende (url). Beispiel: "[✅ Ich akzeptiere][❌ Ich akzeptiere nicht]".

const LEGACY_LINK = /\{\{([^{}\n]+?)\}\}\(([^()\s]+)\)/g;
// [Label] ohne direkt folgendes "(" und nicht als Bild "![…]".
const BUTTON = /(!?)\[([^[\]\n]+)\](?!\()/g;
// Unvollständiger Button oder Link am Ende eines noch laufenden Streams.
const TRAILING_PARTIAL = /(?:\{\{[^}\n]*|\[[^\]\n]*)$/;

export type ParsedMessage = { markdown: string; buttons: string[] };

export function parseMessage(text: string, streaming = false): ParsedMessage {
  let source = text.replace(LEGACY_LINK, "[$1]($2)");
  if (streaming) source = source.replace(TRAILING_PARTIAL, "");
  const buttons: string[] = [];
  const markdown = source.replace(BUTTON, (match, bang: string, label: string) => {
    const trimmed = label.trim();
    if (bang || !trimmed) return match;
    buttons.push(trimmed);
    return "";
  });
  return {
    markdown: markdown
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    buttons,
  };
}
