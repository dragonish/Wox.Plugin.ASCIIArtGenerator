import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { Writable } from "stream"
import * as PImage from "pureimage"
import type { Font as OpenTypeFont } from "opentype.js"
import { PREVIEW_FONT_FAMILIES, PREVIEW_LINE_HEIGHT, PREVIEW_PADDING, PreviewTheme, previewFontSize } from "./preview"

/** Rendered PNG plus its pixel size, used by the copy/save actions. */
export interface ArtImage {
  buffer: Buffer
  width: number
  height: number
}

export interface RenderArtImageOptions {
  art: string
  theme: PreviewTheme
  /** Pixel multiplier; 2 keeps the art crisp on HiDPI displays. */
  scale?: number
}

export interface LoadableFont {
  /** Family name registered with the rasterizer. */
  family: string
  /** Absolute path to a TTF/OTF file. */
  file: string
}

interface LoadedFont extends LoadableFont {
  font: OpenTypeFont
}

interface FontMetrics {
  unitsPerEm?: number
  ascender?: number
  descender?: number
  tables?: {
    os2?: {
      usWinAscent?: number
      usWinDescent?: number
    }
  }
}

export const DEFAULT_IMAGE_SCALE = 2
/** Refuse to allocate a canvas larger than this; figlet never gets close. */
export const MAX_IMAGE_DIMENSION = 16384

const WINDOWS_FONTS = process.env.WINDIR ? path.join(process.env.WINDIR, "Fonts") : "C:\\Windows\\Fonts"
const WINDOWS_USER_FONTS = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts") : ""

function windowsFont(file: string): string[] {
  const files = [WINDOWS_USER_FONTS ? path.join(WINDOWS_USER_FONTS, file) : "", path.join(WINDOWS_FONTS, file)]
  return files.filter(Boolean)
}

/**
 * Candidate font files per CSS family, in the order the browser would consider
 * them. Paths for every platform are listed; statSync filters the missing ones.
 */
function familyCandidates(family: string): string[] {
  switch (family.toLowerCase()) {
    case "consolas":
      return [
        ...windowsFont("consola.ttf"),
        "/Library/Fonts/Consolas.ttf",
        "/Library/Fonts/Microsoft/Consolas.ttf",
        "/System/Library/Fonts/Consolas.ttf",
        "/usr/share/fonts/truetype/msttcorefonts/Consolas.ttf",
        "/usr/share/fonts/truetype/consolas/consola.ttf"
      ]
    case "cascadia mono":
      return [...windowsFont("CascadiaMono.ttf"), "/Library/Fonts/CascadiaMono.ttf", "/usr/share/fonts/truetype/cascadia/CascadiaMono.ttf", "/usr/share/fonts/otf/CascadiaMono.ttf"]
    case "courier new":
      return [
        ...windowsFont("cour.ttf"),
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/Library/Fonts/Courier New.ttf",
        "/usr/share/fonts/truetype/msttcorefonts/Courier_New.ttf",
        "/usr/share/fonts/truetype/msttcorefonts/cour.ttf"
      ]
    default:
      // "ui-monospace" and generic "monospace" resolve to the platform default.
      return [
        ...windowsFont("consola.ttf"),
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf",
        "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf",
        "/usr/share/fonts/truetype/ubuntu/UbuntuMono-R.ttf",
        "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf",
        "/usr/share/fonts/truetype/firacode/FiraCode-Regular.ttf"
      ]
  }
}

/**
 * Fonts outside the CSS stack, consulted only for characters no stack font
 * covers (braille, symbols, Hangul). TTC collections are skipped by the loader.
 */
const EXTRA_FALLBACK_FILES = [
  ...windowsFont("seguisym.ttf"),
  ...windowsFont("seguiemj.ttf"),
  ...windowsFont("malgun.ttf"),
  ...windowsFont("arial.ttf"),
  "/System/Library/Fonts/Apple Symbols.ttf",
  "/System/Library/Fonts/Supplemental/Apple Symbols.ttf",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
]

function firstExisting(files: string[]): string | undefined {
  for (const file of files) {
    try {
      if (fs.statSync(file).isFile()) {
        return file
      }
    } catch {
      // missing font, try the next candidate
    }
  }
  return undefined
}

/** Ask fontconfig which file Chrome would use for a family on Linux. */
function fontconfigFile(family: string): string | undefined {
  if (process.platform !== "linux") {
    return undefined
  }
  try {
    const file = execFileSync("fc-match", ["-f", "%{file}", family], { encoding: "utf8", timeout: 2000 }).trim()
    return file && fs.existsSync(file) ? file : undefined
  } catch {
    // fc-match is not installed or failed; fall back to the known paths.
    return undefined
  }
}

/**
 * Resolve the preview font stack to real files. Exported for tests.
 * Fonts that several families resolve to are only loaded once.
 */
export function resolveFontStack(): LoadableFont[] {
  const stack: LoadableFont[] = []
  const seen = new Set<string>()
  const add = (family: string, file: string | undefined): void => {
    if (!file) {
      return
    }
    const key = process.platform === "win32" ? file.toLowerCase() : file
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    stack.push({ family, file })
  }
  for (const family of PREVIEW_FONT_FAMILIES) {
    if (process.platform === "linux") {
      add(family, fontconfigFile(family))
    }
    add(family, firstExisting(familyCandidates(family)))
  }
  for (const file of EXTRA_FALLBACK_FILES) {
    add(path.basename(file).replace(/\.[^.]+$/, ""), firstExisting([file]))
  }
  return stack
}

let loadedFonts: LoadedFont[] | undefined
const charFontCache = new Map<string, LoadedFont>()

/** Load the stack once; the copy/save actions reuse it for every result. */
export function loadedFontStack(): LoadedFont[] {
  if (loadedFonts) {
    return loadedFonts
  }
  const fonts: LoadedFont[] = []
  for (const candidate of resolveFontStack()) {
    try {
      const registered = PImage.registerFont(candidate.file, candidate.family)
      const loaded = registered.loadSync()
      if (loaded.font) {
        fonts.push({ family: candidate.family, file: candidate.file, font: loaded.font })
      }
    } catch {
      // Unreadable fonts (for example .ttc collections) are skipped.
    }
  }
  loadedFonts = fonts
  return fonts
}

/** Drop cached fonts; only tests need this. */
export function resetImageFontCache(): void {
  loadedFonts = undefined
  charFontCache.clear()
}

function fontForChar(ch: string): LoadedFont {
  const cached = charFontCache.get(ch)
  if (cached) {
    return cached
  }
  const fonts = loadedFontStack()
  if (!fonts.length) {
    throw new Error("No usable monospace font was found on this system")
  }
  let selected = fonts[0]
  for (const font of fonts) {
    try {
      if (font.font.charToGlyph(ch).index !== 0) {
        selected = font
        break
      }
    } catch {
      // Ignore fonts that cannot map the character.
    }
  }
  charFontCache.set(ch, selected)
  return selected
}

function advanceFor(font: LoadedFont, ch: string, sizePx: number): number {
  const metrics = font.font as unknown as FontMetrics
  const unitsPerEm = metrics.unitsPerEm || 1000
  if (ch === "\t") {
    return advanceFor(font, " ", sizePx) * 8
  }
  try {
    const advance = font.font.charToGlyph(ch).advanceWidth
    return ((advance ?? unitsPerEm) * sizePx) / unitsPerEm
  } catch {
    return sizePx / 2
  }
}

/** Baseline placement that mirrors the CSS line box used by the preview. */
function verticalMetrics(font: LoadedFont, sizePx: number): { ascent: number; descent: number } {
  const metrics = font.font as unknown as FontMetrics
  const unitsPerEm = metrics.unitsPerEm || 1000
  const os2 = metrics.tables?.os2
  const ascentUnits = os2?.usWinAscent || metrics.ascender || unitsPerEm * 0.8
  const descentUnits = os2?.usWinDescent || Math.abs(metrics.descender || unitsPerEm * 0.2)
  return {
    ascent: (ascentUnits * sizePx) / unitsPerEm,
    descent: (descentUnits * sizePx) / unitsPerEm
  }
}

/**
 * Split art into the lines the PNG shows: trailing blank lines and trailing
 * spaces only add empty pixels, so they are dropped before sizing the canvas.
 * Exported for tests.
 */
export function artImageLines(art: string): string[] {
  const trimmed = art.replace(/\n+$/, "")
  if (!trimmed) {
    return [""]
  }
  return trimmed.split("\n").map(line => line.replace(/[ \t]+$/, ""))
}

function encodePng(image: PImage.Bitmap): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const sink = new Writable({
      write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        chunks.push(chunk)
        callback()
      }
    })
    sink.on("error", reject)
    sink.on("finish", () => resolve(Buffer.concat(chunks)))
    PImage.encodePNGToStream(image, sink).catch(reject)
  })
}

/**
 * Draw the ASCII art to a PNG with the same font stack, size, line height,
 * padding and colors as the webview preview.
 */
export async function renderArtImage(options: RenderArtImageOptions): Promise<ArtImage> {
  const scale = Math.max(1, Math.floor(options.scale ?? DEFAULT_IMAGE_SCALE))
  const fontSize = previewFontSize(options.art)
  const sizePx = fontSize * scale
  const padding = PREVIEW_PADDING * scale
  const lineHeight = fontSize * PREVIEW_LINE_HEIGHT * scale
  const lines = artImageLines(options.art)

  const fonts = loadedFontStack()
  if (!fonts.length) {
    throw new Error("No usable monospace font was found on this system")
  }
  // Warm the per-character cache before measuring so both passes agree.
  const widths = lines.map(line => {
    let width = 0
    for (const ch of line) {
      width += advanceFor(fontForChar(ch), ch, sizePx)
    }
    return width
  })
  const width = Math.ceil(padding * 2 + Math.max(1, ...widths))
  const height = Math.ceil(padding * 2 + lines.length * lineHeight)
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`image is too large (${width}x${height})`)
  }

  const image = PImage.make(width, height)
  const ctx = image.getContext("2d")
  ctx.fillStyle = options.theme.Background
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = options.theme.Text
  ctx.textBaseline = "alphabetic"

  const primary = fonts[0]
  const { ascent, descent } = verticalMetrics(primary, sizePx)
  const halfLeading = (lineHeight - (ascent + descent)) / 2
  let baseline = padding + halfLeading + ascent
  for (const line of lines) {
    let x = padding
    let currentFamily = ""
    for (const ch of line) {
      const font = fontForChar(ch)
      if (ch !== " " && ch !== "\t" && ch !== "\u00a0") {
        if (font.family !== currentFamily) {
          ctx.font = `${sizePx} ${font.family}`
          currentFamily = font.family
        }
        ctx.fillText(ch, x, baseline)
      }
      x += advanceFor(font, ch, sizePx)
    }
    baseline += lineHeight
  }

  return { buffer: await encodePng(image), width, height }
}
