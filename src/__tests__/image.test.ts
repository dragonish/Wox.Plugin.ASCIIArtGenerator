import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Readable } from "stream"
import * as opentype from "opentype.js"
import * as PImage from "pureimage"
import { artImageLines, collectionFaceNames, extractCollectionFace, loadedFontStack, loadFontFile, renderArtImage, resetImageFontCache, resolveFontStack, selectCollectionFace } from "../image"

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TEST_THEME = { Background: "#ffffff", Text: "#1f2328" }

describe("artImageLines", () => {
  test("keeps interior blank lines", () => {
    expect(artImageLines("a\n\nb")).toEqual(["a", "", "b"])
  })

  test("drops trailing blank lines", () => {
    expect(artImageLines("a\nb\n\n")).toEqual(["a", "b"])
  })

  test("drops trailing spaces but keeps leading indentation", () => {
    expect(artImageLines("  a   \n b\t")).toEqual(["  a", " b"])
  })

  test("keeps one empty line for empty art", () => {
    expect(artImageLines("")).toEqual([""])
    expect(artImageLines("\n\n")).toEqual([""])
  })
})

const hasMonospaceFont = resolveFontStack().length > 0
const imageTest = hasMonospaceFont ? test : test.skip

async function decode(buffer: Buffer): Promise<PImage.Bitmap> {
  return PImage.decodePNGFromStream(Readable.from(buffer))
}

describe("renderArtImage", () => {
  imageTest("produces a PNG at the requested scale", async () => {
    const one = await renderArtImage({ art: "ab\ncd", scale: 1, theme: TEST_THEME })
    const two = await renderArtImage({ art: "ab\ncd", scale: 2, theme: TEST_THEME })

    expect(one.buffer.subarray(0, 8)).toEqual(PNG_SIGNATURE)
    expect(two.buffer.subarray(0, 8)).toEqual(PNG_SIGNATURE)
    expect(two.width).toBeGreaterThan(one.width)
    expect(two.height).toBeCloseTo(one.height * 2, -1)
  })

  imageTest("fills the background with the launcher color", async () => {
    const image = await renderArtImage({ art: "Hi", scale: 1, theme: { Background: "#102030", Text: "#e0e0e0" } })
    const bitmap = await decode(image.buffer)
    // getPixelRGBA packs RGBA as an unsigned 32-bit number.
    expect(bitmap.getPixelRGBA(0, 0)).toBe(((0x10 << 24) | (0x20 << 16) | (0x30 << 8) | 0xff) >>> 0)
  })

  imageTest("renders empty art without failing", async () => {
    const image = await renderArtImage({ art: "", theme: TEST_THEME })
    expect(image.buffer.subarray(0, 8)).toEqual(PNG_SIGNATURE)
    expect(image.width).toBeGreaterThan(0)
    expect(image.height).toBeGreaterThan(0)
  })
})

function asArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/** A real sfnt from the resolved stack, so the tests do not ship a font. */
function systemTtfs(): string[] {
  return resolveFontStack()
    .map(font => font.file)
    .filter(file => file.toLowerCase().endsWith(".ttf"))
}

/**
 * Wrap plain sfnt files in one collection, rebasing every face's table offsets
 * to its position in the collection. Mirrors how .ttc files lay out faces.
 */
function wrapAsCollection(faces: Buffer[]): Buffer {
  const headerSize = 12 + faces.length * 4
  const offsets: number[] = []
  let size = headerSize
  for (const face of faces) {
    offsets.push(size)
    size += face.length + ((4 - (face.length % 4)) % 4)
  }
  const collection = Buffer.alloc(size)
  collection.write("ttcf", 0, "latin1")
  collection.writeUInt32BE(0x00010000, 4)
  collection.writeUInt32BE(faces.length, 8)
  faces.forEach((face, index) => {
    const start = offsets[index]
    collection.writeUInt32BE(start, 12 + index * 4)
    face.copy(collection, start)
    const numTables = collection.readUInt16BE(start + 4)
    for (let i = 0; i < numTables; i++) {
      const record = start + 12 + i * 16
      collection.writeUInt32BE(collection.readUInt32BE(record + 8) + start, record + 8)
    }
  })
  return collection
}

describe("font collections", () => {
  test("unpacks a collection face into a parseable font", () => {
    const file = systemTtfs()[0]
    if (!file) {
      return
    }
    const sfnt = fs.readFileSync(file)
    const original = opentype.parse(asArrayBuffer(sfnt))
    const collection = wrapAsCollection([sfnt])

    const names = collectionFaceNames(collection, 0)
    expect(names.length).toBeGreaterThan(0)
    expect(selectCollectionFace(collection, names[0])).toBe(0)
    expect(selectCollectionFace(collection, "no such family")).toBe(0)

    const face = opentype.parse(asArrayBuffer(extractCollectionFace(collection, 0)))
    expect(face.unitsPerEm).toBe(original.unitsPerEm)
    expect(face.numGlyphs).toBe(original.numGlyphs)
    expect(face.charToGlyph("A").index).toBe(original.charToGlyph("A").index)
  })

  test("selects the requested face inside a multi-face collection", () => {
    const files = systemTtfs().slice(0, 2)
    if (files.length < 2) {
      return
    }
    const collection = wrapAsCollection(files.map(file => fs.readFileSync(file)))
    const first = collectionFaceNames(collection, 0)
    const second = collectionFaceNames(collection, 1)
    expect(first.length).toBeGreaterThan(0)
    expect(second.length).toBeGreaterThan(0)
    expect(selectCollectionFace(collection, first[0])).toBe(0)
    expect(selectCollectionFace(collection, second[0])).toBe(1)
  })

  test("loadFontFile reads a collection from disk", () => {
    const sfnt = systemTtfs()[0]
    if (!sfnt) {
      return
    }
    const file = path.join(os.tmpdir(), `wox-asciiart-test-${process.pid}.ttc`)
    fs.writeFileSync(file, wrapAsCollection([fs.readFileSync(sfnt)]))
    try {
      const original = opentype.parse(asArrayBuffer(fs.readFileSync(sfnt)))
      const font = loadFontFile(file, "unused family")
      expect(font.unitsPerEm).toBe(original.unitsPerEm)
      expect(font.numGlyphs).toBe(original.numGlyphs)
    } finally {
      fs.unlinkSync(file)
    }
  })
})

// Figlet output is a closed set: sweeping every bundled font with printable
// ASCII covers every glyph the PNG renderer can be asked to draw. The sweep
// lives in scripts/audit-figlet-fonts.mjs because jest makes figlet ~8x slower.
const AUDIT_SCRIPT = path.join(__dirname, "..", "..", "scripts", "audit-figlet-fonts.mjs")

// Fullwidth forms (WideTerm) and Canadian syllabics (Upside Down Text) only
// exist in script-specific faces, so they may be absent when that font is not
// installed at all. Everything else must resolve on any machine.
const FULLWIDTH = /^[\uff00-\uffef]$/
const SYLLABICS = /^[\u1400-\u167f]$/
const hasCjkFont = resolveFontStack().some(font => /(pingfang|noto.*cjk|msyh|msgothic|yugoth|simsun|malgun)/i.test(font.file))
const hasSyllabicsFont = resolveFontStack().some(font => /(gadugi|euphemia|canadian)/i.test(font.file))

function hasGlyph(font: { font: opentype.Font }, ch: string): boolean {
  try {
    return font.font.charToGlyph(ch).index !== 0
  } catch {
    return false
  }
}

imageTest(
  "every glyph the bundled figlet fonts emit has a real face",
  () => {
    resetImageFontCache()
    const fonts = loadedFontStack()
    const required = JSON.parse(execFileSync(process.execPath, [AUDIT_SCRIPT], { encoding: "utf8", timeout: 60000 })) as string[]
    // The sweep is only useful if it actually saw the symbol-heavy fonts.
    expect(required.length).toBeGreaterThan(300)

    const missing = required.filter(ch => {
      if (fonts.some(font => hasGlyph(font, ch))) {
        return false
      }
      if (FULLWIDTH.test(ch) && !hasCjkFont) {
        return false
      }
      return !(SYLLABICS.test(ch) && !hasSyllabicsFont)
    })
    expect(missing).toEqual([])
  },
  180000
)
