import type { WoxPreview, WoxPreviewWebviewData } from "@wox-launcher/wox-plugin"

/** Colors of the launcher palette, mirrored from PublicAPI.GetThemeColors. */
export interface PreviewTheme {
  Background: string
  Text: string
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}

/** Escape text for interpolation into HTML. Exported for tests. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch])
}

/** Reverse {@link escapeHtml}. Exported so tests can assert on the rendered art. */
export function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&")
}

const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 14
// Approximate content width of the preview panel, minus the body padding.
const AVAILABLE_WIDTH = 400
// Advance width of a monospace glyph in em.
const GLYPH_WIDTH_RATIO = 0.6

/** Body padding of the preview; the PNG renderer uses the same value. */
export const PREVIEW_PADDING = 12
/** CSS line-height of the preview, relative to the font size. */
export const PREVIEW_LINE_HEIGHT = 1.15
/**
 * Font stack of the preview, in CSS fallback order. The PNG renderer resolves
 * the same families to font files and falls back per character, so glyphs the
 * primary font lacks (box drawing, braille, symbols) keep their preview look.
 */
export const PREVIEW_FONT_FAMILIES = ["Consolas", "Cascadia Mono", "Courier New", "ui-monospace", "monospace"]

function cssFontFamily(family: string): string {
  return /\s/.test(family) ? `"${family}"` : family
}

/**
 * Largest font size that keeps the widest line inside the preview panel.
 * Wide art shrinks down to 8px; narrow art is capped at 14px. Exported for tests.
 */
export function previewFontSize(art: string): number {
  const widest = art.split("\n").reduce((max, line) => Math.max(max, line.length), 0)
  if (widest === 0) {
    return MAX_FONT_SIZE
  }
  const fitted = Math.floor(AVAILABLE_WIDTH / (widest * GLYPH_WIDTH_RATIO))
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, fitted))
}

/**
 * Render ASCII art as a static HTML preview.
 *
 * `text` previews use the UI font, where spaces and glyphs have proportional
 * widths and every figlet drawing falls apart. A `webview` preview pins the art
 * to a monospace stack, so columns line up in any theme and on any platform.
 */
export function buildArtPreview(art: string, properties: Record<string, string>, theme: PreviewTheme): WoxPreview {
  const fontSize = previewFontSize(art)
  // A newline directly after <pre> is dropped by the HTML parser; keep a leading
  // one as an entity so the art survives the round trip unchanged.
  const body = art.startsWith("\n") ? `&#10;${escapeHtml(art.slice(1))}` : escapeHtml(art)

  const colors = `background:${theme.Background};color:${theme.Text};`

  const html = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    "html,body{margin:0;padding:0}",
    `body{padding:${PREVIEW_PADDING}px;overflow:auto;${colors}}`,
    `pre{margin:0;white-space:pre;font-family:${PREVIEW_FONT_FAMILIES.map(cssFontFamily).join(",")};font-size:${fontSize}px;line-height:${PREVIEW_LINE_HEIGHT}}`,
    "</style></head><body><pre>",
    body,
    "</pre></body></html>"
  ].join("")

  const data: WoxPreviewWebviewData = { html }
  return {
    PreviewType: "webview",
    PreviewData: JSON.stringify(data),
    PreviewProperties: properties
  }
}
