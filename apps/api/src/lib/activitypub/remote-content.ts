/**
 * Sanitiser for `content` arriving from remote ActivityPub instances.
 *
 * Peers send `content` as HTML (Mastodon and most others do). Trellis stores
 * it in plain-text columns and re-serves it verbatim, so anything with markup
 * in it must be reduced to text at ingest — the alternative is raw remote HTML
 * in a text field, which every client then has to remember not to render.
 *
 * Pure and total: any non-string yields `undefined`, never a throw.
 */

/** Upper bound on stored remote content, in characters. */
const MAX_REMOTE_CONTENT_CHARS = 10_000;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(input: string): string {
  return input.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (whole, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
        try {
          return String.fromCodePoint(code);
        } catch {
          return "";
        }
      }
      const named = NAMED_ENTITIES[entity.toLowerCase()];
      return named === undefined ? whole : named;
    },
  );
}

/**
 * Reduce remote HTML `content` to plain text.
 *
 * Order matters: tags are removed BEFORE entities are decoded, so an encoded
 * `&lt;script&gt;` becomes the literal text `<script>` (harmless in a text
 * column) rather than a tag that a second pass would strip or a renderer would
 * execute. Block-ish elements become newlines so paragraphs survive.
 *
 * @param value - Raw `content` from a remote object
 * @returns Plain text, or `undefined` when nothing usable remains
 */
export function sanitizeRemoteContent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  let text = value
    // Drop script/style bodies entirely, not just their tags.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    // Line breaks for block-level boundaries.
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    // Everything else that looks like a tag.
    .replace(/<[^>]*>/g, "");

  text = decodeEntities(text)
    // Control characters (keep \n and \t).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    // Collapse runs of blank lines.
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) return undefined;
  return text.length <= MAX_REMOTE_CONTENT_CHARS
    ? text
    : text.slice(0, MAX_REMOTE_CONTENT_CHARS);
}
