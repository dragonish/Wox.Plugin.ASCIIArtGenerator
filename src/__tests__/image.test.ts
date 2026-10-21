import { Readable } from "stream"
import * as PImage from "pureimage"
import { artImageLines, renderArtImage, resolveFontStack } from "../image"

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
