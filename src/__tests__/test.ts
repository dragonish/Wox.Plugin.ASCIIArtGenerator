jest.mock("figlet", () => ({
  __esModule: true,
  default: {
    defaults: jest.fn(),
    fontsSync: jest.fn(() => ["Alpha", "Emboss 2", "Slant"]),
    textSync: jest.fn((text: string, options?: { font?: string }) => `art:${options?.font ?? ""}:${text}`)
  }
}))

import { Context, PluginInitParams, PublicAPI, Query, Result, WoxPreview, WoxPreviewWebviewData } from "@wox-launcher/wox-plugin"
import { fontCommandText, fontsQueryText, plugin, tokenize } from "../index"
import { buildArtPreview, unescapeHtml } from "../preview"

describe("tokenize", () => {
  test("splits on whitespace", () => {
    expect(tokenize("-f slant hello world")).toEqual(["-f", "slant", "hello", "world"])
  })

  test("honors double quotes", () => {
    expect(tokenize('-f "AMC 3 Line" hello')).toEqual(["-f", "AMC 3 Line", "hello"])
  })

  test("honors single quotes", () => {
    expect(tokenize("--font='3D Diagonal' hi")).toEqual(["--font=3D Diagonal", "hi"])
  })

  test("collapses extra whitespace", () => {
    expect(tokenize("  hello   world  ")).toEqual(["hello", "world"])
  })

  test("empty input", () => {
    expect(tokenize("")).toEqual([])
    expect(tokenize("   ")).toEqual([])
  })
})

describe("fontsQueryText", () => {
  test("uses the live trigger keyword", () => {
    expect(fontsQueryText("ascii")).toBe("ascii fonts ")
    expect(fontsQueryText("aa")).toBe("aa fonts ")
  })

  test("falls back when the trigger keyword is missing", () => {
    expect(fontsQueryText("")).toBe("fonts ")
    expect(fontsQueryText(undefined)).toBe("fonts ")
  })
})

describe("fontCommandText", () => {
  test("uses the live trigger keyword", () => {
    expect(fontCommandText("ascii", "Slant")).toBe("ascii -f Slant ")
    expect(fontCommandText("aa", "Emboss 2")).toBe("aa -f Emboss 2 ")
  })

  test("falls back when the trigger keyword is missing", () => {
    expect(fontCommandText("", "Slant")).toBe("-f Slant ")
    expect(fontCommandText(undefined, "Slant")).toBe("-f Slant ")
  })
})

const ctx = {} as Context
const FONTS = ["Alpha", "Emboss 2", "Slant"]
const changeQueries: string[] = []

function fakeApi(): PublicAPI {
  return {
    ChangeQuery: async (_ctx: Context, args: { QueryType: string; QueryText: string }) => {
      changeQueries.push(args.QueryText)
    },
    HideApp: async () => {},
    Notify: async () => {},
    Copy: async () => {},
    Log: async () => {},
    GetTranslation: async (_ctx: Context, key: string) => key,
    GetSetting: async () => "",
    SetSetting: async () => ({ Success: true, ErrMsg: "" }),
    OnSettingChanged: async () => {},
    OnGetDynamicSetting: async () => ({}) as never
  } as unknown as PublicAPI
}

async function runQuery(search: string, command = "", hint?: Query["QueryHint"]): Promise<Result[]> {
  await plugin.init(ctx, { API: fakeApi(), PluginDirectory: "" } as PluginInitParams)
  return (await plugin.query(ctx, { Command: command, Search: search, QueryHint: hint, TriggerKeyword: "ascii" } as unknown as Query)) as Result[]
}

/** Build the QueryHint shape Wox installs for the declared "-f" template. */
function fontHint(font: string, text: string): Query["QueryHint"] {
  return {
    Elements: [
      { Id: "font", Kind: "argument", Value: font },
      { Id: "sep", Kind: "text", Text: " " },
      { Id: "text", Kind: "argument", Value: text }
    ]
  }
}

function actionIds(results: Result[]): string[] {
  const ids: string[] = []
  for (const result of results) {
    for (const action of result.Actions ?? []) {
      ids.push(action.Id ?? "")
    }
  }
  return ids
}

/**
 * Read the ASCII art back out of a result preview.
 *
 * Art ships as an HTML `<pre>` inside a `webview` preview, so unwrap the JSON
 * payload and reverse the HTML escaping before asserting on it.
 */
function previewData(result: Result): string {
  const preview = result.Preview as WoxPreview | undefined
  if (!preview) {
    return ""
  }
  expect(preview.PreviewType).toBe("webview")
  const html = (JSON.parse(preview.PreviewData) as WoxPreviewWebviewData).html ?? ""
  const match = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)
  return unescapeHtml(match?.[1] ?? "")
}

async function clickAction(result: Result, idPrefix: string): Promise<void> {
  const action = result.Actions?.find(a => (a.Id ?? "").startsWith(idPrefix))
  if (!action) {
    throw new Error(`action ${idPrefix} not found`)
  }
  // ResultAction is a union, only the plain variant carries a callback.
  const clickable = action as unknown as { Action: (c: Context, a: never) => Promise<void> }
  await clickable.Action(ctx, {} as never)
}

// The Wox host caches action callbacks in a map keyed by action Id and clears it
// before every query. Duplicate ids across results therefore make every result
// run the last registered callback (this once copied "Emboss 2" for every font).
describe("action ids are unique within one query response", () => {
  test("font list results", async () => {
    const results = await runQuery("fonts")
    expect(results.map(r => r.Title)).toEqual(FONTS)

    const ids = actionIds(results)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    for (const font of FONTS) {
      expect(ids).toContain(`copy-font-name:${font}`)
      expect(ids).toContain(`copy-art:${font}`)
      expect(ids).toContain(`set-default:${font}`)
      expect(ids).toContain(`use-font:${font}`)
    }
  })

  test("font suggestion results", async () => {
    const results = await runQuery("-f a hello")
    expect(results.length).toBeGreaterThan(1)

    const ids = actionIds(results)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain("copy:Alpha")
    expect(ids).toContain("copy:Slant")
  })
})

// Wox queries on every keystroke, so typing "fonts" renders "fo"/"fon" on the way.
// Those intermediate queries must not become the preview text: only the jump actions
// that lead into the font list record what to preview.
describe("font list preview text", () => {
  test("previews the fallback unless a jump action carried text over", async () => {
    // Cold start: nothing was rendered yet.
    let results = await runQuery("fonts")
    expect(previewData(results[0])).toBe("art:Alpha:Hello")

    // Typing the command by hand must not leak the intermediate input.
    await runQuery("fo")
    await runQuery("fon")
    results = await runQuery("fonts")
    expect(previewData(results[0])).toBe("art:Alpha:Hello")

    // Jumping from a rendered result carries that text over.
    const rendered = await runQuery("hello")
    await clickAction(rendered[0], "more-fonts:")
    results = await runQuery("fonts")
    expect(previewData(results[0])).toBe("art:Alpha:hello")

    // Browsing with a filter keeps the carried text.
    results = await runQuery("fonts sl")
    expect(results.map(r => r.Title)).toEqual(["Slant"])
    expect(previewData(results[0])).toBe("art:Slant:hello")

    // Rendering something else leaves the font list flow, so the text is forgotten.
    await runQuery("world")
    results = await runQuery("fonts")
    expect(previewData(results[0])).toBe("art:Alpha:Hello")
  })

  test("the font-not-found list carries the text the user typed", async () => {
    const results = await runQuery("-f nope hello")
    await clickAction(results[0], "list-fonts")
    const fonts = await runQuery("fonts")
    expect(previewData(fonts[0])).toBe("art:Alpha:hello")
  })
})

// The "use-font" action rewrites the query to `ascii -f <font> ` so the user can
// keep typing the text to render with that font.
describe("use-font action", () => {
  test("changes the query to `ascii -f <font> ` for the chosen font", async () => {
    changeQueries.length = 0
    const results = await runQuery("fonts")
    const slant = results.find(r => r.Title === "Slant")
    expect(slant).toBeDefined()
    await clickAction(slant!, "use-font:")
    expect(changeQueries).toEqual(["ascii -f Slant "])
  })
})

// Wox splits a declared command out of the search text (see "Commands" in plugin.json),
// so `ascii fonts sl` reaches the plugin as Command="fonts", Search="sl". The plugin folds
// the command back in, which must stay equivalent to typing the whole line as one string.
describe("declared commands", () => {
  test("fonts command filters the font list", async () => {
    const results = await runQuery("sl", "fonts")
    expect(results.map(r => r.Title)).toEqual(["Slant"])
  })

  test("fonts command without a filter lists every font", async () => {
    const results = await runQuery("", "fonts")
    expect(results.map(r => r.Title)).toEqual(FONTS)
  })

  test("split and unsplit input produce the same font list", async () => {
    const split = await runQuery("sl", "fonts")
    const unsplit = await runQuery("fonts sl")
    expect(split.map(r => r.Title)).toEqual(unsplit.map(r => r.Title))
  })

  test("-f command renders with the named font", async () => {
    const results = await runQuery("slant hello", "-f")
    expect(actionIds(results)).toContain("copy:Slant")
  })

  // Advertising "-f" in plugin.json makes Wox offer `ascii -f ` as a testable command,
  // so a bare flag must show help instead of rendering the literal text "-f".
  test("bare -f shows help instead of rendering the flag", async () => {
    const helpTitles = ["help_title", "help_list_fonts_title", "help_current_font"]
    expect((await runQuery("-f")).map(r => r.Title)).toEqual(helpTitles)
    expect((await runQuery("", "-f")).map(r => r.Title)).toEqual(helpTitles)
  })

  // "-l" and "--list" were redundant synonyms of the "fonts" command and are gone.
  test("-l is no longer a font list alias", async () => {
    const results = await runQuery("-l")
    expect(results.map(r => r.Title)).toEqual(["render_title"])
    expect(previewData(results[0])).toBe("art:Standard:-l")
  })
})

// `ascii -f ` installs the QueryHint template declared in plugin.json, which splits the
// font name (spaces allowed) from the text. The plugin prefers the hint slots when both
// are filled and falls back to token parsing otherwise.
describe("query hint slots", () => {
  test("uses the font slot verbatim, so font names with spaces work", async () => {
    const results = await runQuery("Emboss 2 hello", "-f", fontHint("Emboss 2", "hello"))
    expect(actionIds(results)).toContain("copy:Emboss 2")
    expect(previewData(results[0])).toBe("art:Emboss 2:hello")
  })

  test("keeps the text slot intact", async () => {
    const results = await runQuery("Slant hello world", "-f", fontHint("Slant", "hello world"))
    expect(previewData(results[0])).toBe("art:Slant:hello world")
  })

  // Without Tab the whole line lands in the font slot and the text slot stays empty.
  // Falling back to token parsing keeps `ascii -f slant hello` working as before.
  test("falls back to token parsing when the text slot is empty", async () => {
    const results = await runQuery("slant hello", "-f", fontHint("slant hello", ""))
    expect(actionIds(results)).toContain("copy:Slant")
    expect(previewData(results[0])).toBe("art:Slant:hello")
  })

  test("reports a font name from the hint that does not exist", async () => {
    const results = await runQuery("Nope hello", "-f", fontHint("Nope", "hello"))
    expect(results[0].Title).toBe("error_font_not_found")
  })

  // `--font` is an alias of the declared "-f" command, so it installs the same template.
  test("supports the --font alias", async () => {
    const results = await runQuery("Slant hello", "", fontHint("Slant", "hello"))
    expect(actionIds(results)).toContain("copy:Slant")
  })
})

// A `text` preview inherits the UI font, where spaces are proportional and figlet
// drawings collapse. The art therefore ships as monospace HTML in a webview preview.
describe("art preview", () => {
  function htmlOf(preview: WoxPreview): string {
    return (JSON.parse(preview.PreviewData) as WoxPreviewWebviewData).html ?? ""
  }

  test("uses a monospace stack and preformatted whitespace", () => {
    const html = htmlOf(buildArtPreview("a  b\n c", { Font: "Standard" }))
    expect(html).toContain("white-space:pre")
    expect(html).toContain("monospace")
  })

  test("escapes art so figlet glyphs survive the HTML round trip", () => {
    const art = ' /\\\n<&> "quoted"'
    const html = htmlOf(buildArtPreview(art, {}))
    expect(html).not.toContain("<&>")
    expect(previewData({ Preview: buildArtPreview(art, {}) } as Result)).toBe(art)
  })

  test("keeps a leading newline instead of letting the parser drop it", () => {
    const art = "\nabc"
    expect(previewData({ Preview: buildArtPreview(art, {}) } as Result)).toBe(art)
  })

  test("shrinks wide art but never below 8px", () => {
    const narrow = previewData({ Preview: buildArtPreview("x".repeat(10), {}) } as Result)
    expect(narrow).toBe("x".repeat(10))

    const wideHtml = htmlOf(buildArtPreview("x".repeat(200), {}))
    expect(wideHtml).toContain("font-size:8px")

    const narrowHtml = htmlOf(buildArtPreview("x", {}))
    expect(narrowHtml).toContain("font-size:14px")
  })

  test("applies the launcher palette when the host provides one", () => {
    const html = htmlOf(buildArtPreview("x", {}, { Background: "#101010", Text: "#e0e0e0" }))
    expect(html).toContain("background:#101010")
    expect(html).toContain("color:#e0e0e0")
  })
})
