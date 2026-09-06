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

/** Tags whose close (or `br`) marks a line boundary worth keeping. */
const BLOCK_BOUNDARY_TAGS: ReadonlySet<string> = new Set([
  "br",
  "/p",
  "/div",
  "/li",
  "/h1",
  "/h2",
  "/h3",
  "/h4",
  "/h5",
  "/h6",
]);

/** Elements whose entire BODY is dropped, not just their tags. */
const DROP_BODY_TAGS: ReadonlySet<string> = new Set(["script", "style"]);

/** Lower-cased tag name (with a leading `/` for closing tags), or "" */
function tagName(tagBody: string): string {
  const m = /^\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagBody);
  return m ? `${m[1]}${m[2].toLowerCase()}` : "";
}

/**
 * Remove every tag in ONE left-to-right scan.
 *
 * A scanner rather than `replace(/<[^>]*>/g, "")`: a regex pass can leave
 * `<script` behind when its own match boundaries are chosen adversarially
 * (`<scr<script>ipt>`), and static analysis rightly flags that shape. Here
 * every `<` starts a tag that is consumed up to the next `>` — or to the end
 * of the input when there is none — so no `<` from the input survives.
 */
function stripTags(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, lt);
    const gt = input.indexOf(">", lt + 1);
    if (gt === -1) {
      // Unterminated tag: everything after `<` is dropped.
      break;
    }
    const name = tagName(input.slice(lt + 1, gt));
    if (DROP_BODY_TAGS.has(name)) {
      const close = input.toLowerCase().indexOf(`</${name}`, gt + 1);
      if (close === -1) break; // unterminated body: drop the rest
      const closeGt = input.indexOf(">", close);
      i = closeGt === -1 ? n : closeGt + 1;
      continue;
    }
    if (BLOCK_BOUNDARY_TAGS.has(name)) out += "\n";
    i = gt + 1;
  }
  return out;
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

  const text = decodeEntities(stripTags(value))
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
