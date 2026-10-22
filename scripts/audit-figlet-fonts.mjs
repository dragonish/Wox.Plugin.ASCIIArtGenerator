/* global process */
// Prints every non-ASCII character that the bundled figlet fonts can emit for
// printable ASCII input, as a JSON array. The image tests use it to audit that
// each glyph has a real face (otherwise the PNG shows a .notdef box).
//
// Rendering all 332 fonts inside jest takes ~20s because of jest's sandbox, so
// the sweep runs in this standalone script (about 2.5s) instead.
import figlet from "figlet"

const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("")
const chars = new Set()

for (const name of figlet.fontsSync()) {
  for (const ch of figlet.textSync(printable, { font: name })) {
    const codepoint = ch.codePointAt(0) ?? 0
    if (codepoint > 127 && codepoint !== 0xa0) {
      chars.add(ch)
    }
  }
}

process.stdout.write(JSON.stringify(Array.from(chars)))
