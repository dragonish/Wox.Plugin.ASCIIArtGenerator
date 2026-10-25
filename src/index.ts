import { Context, Plugin, PluginInitParams, PluginSettingDefinitionItem, PublicAPI, Query, Result, ResultAction, WoxImage, WoxPreviewTag } from "@wox-launcher/wox-plugin"
import figlet from "figlet"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { renderArtImage } from "./image"
import { buildArtPreview, PreviewTheme } from "./preview"
import { buildSnippet, DEFAULT_SNIPPET_LANGUAGE, resolveSnippetLanguage, SNIPPET_LANGUAGES, SnippetLanguage } from "./snippets"

const DEFAULT_FONT = "Standard"
const SETTING_FONT_KEY = "font"
const SETTING_COPY_CODE_ENABLED_KEY = "copy_code_enabled"
const SETTING_COPY_CODE_LANGUAGE_KEY = "copy_code_language"
const DYNAMIC_SETTING_KEY = "font_setting"
const SAMPLE_FALLBACK = "Hello"

const appIcon: WoxImage = {
  ImageType: "relative",
  ImageData: "images/app.svg"
}

// figlet's FontName is a union of ~330 literals; the plugin resolves names at runtime.
const figletAny = figlet as unknown as {
  textSync: (text: string, options?: { font?: string }) => string
  fontsSync: () => string[]
  defaults: (options: { fontPath?: string; font?: string }) => void
}

let api: PublicAPI
let fontNames: string[] = []
let defaultFont = DEFAULT_FONT
let copyCodeEnabled = false
let codeLanguage = DEFAULT_SNIPPET_LANGUAGE
// Text previewed in the font list. It is written only by the jump actions that lead
// into the list, never by the render branches: Wox queries on every keystroke, so
// typing "fonts" passes through "fo"/"fon" and would overwrite the user's text.
// Manually typing `ascii fonts` therefore always previews SAMPLE_FALLBACK.
let listSample = ""
let settingFontLabel = "Default font"
let settingFontTooltip = "Font used when rendering without -f"
const previewCache = new Map<string, string>()

// GetThemeColors costs one round trip per call, so remember the palette for a
// while: a font list can hold 120 results in a single response.
const THEME_CACHE_MS = 5 * 60 * 1000
let themeCache: { theme: PreviewTheme; at: number } | undefined

async function previewTheme(ctx: Context): Promise<PreviewTheme> {
  if (themeCache && Date.now() - themeCache.at < THEME_CACHE_MS) {
    return themeCache.theme
  }
  const colors = await api.GetThemeColors(ctx, {})
  const theme = { Background: colors.Background, Text: colors.Text }
  themeCache = { theme, at: Date.now() }
  return theme
}

/** Split a query into tokens, honoring "double quotes" and 'single quotes'. Exported for tests. */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: string | null = null
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
    } else {
      current += ch
    }
  }
  if (current) {
    tokens.push(current)
  }
  return tokens
}

/**
 * Build the complete query that reopens the font list. Wox routes a ChangeQuery by
 * its trigger keyword, which the user can rename, so the keyword must come from the
 * live query instead of the "ascii" default declared in plugin.json.
 * Exported for tests.
 */
export function fontsQueryText(trigger: string | undefined): string {
  return trigger ? `${trigger} fonts ` : "fonts "
}

/**
 * Build the complete query that keeps rendering with a chosen font, e.g.
 * `ascii -f Slant `. The trailing space leaves Wox in the "-f" template so
 * the user can type the text right away. The trigger keyword comes from the
 * live query because the user can rename it. Exported for tests.
 */
export function fontCommandText(trigger: string | undefined, font: string): string {
  return trigger ? `${trigger} -f ${font} ` : `-f ${font} `
}

async function t(ctx: Context, key: string, ...args: string[]): Promise<string> {
  try {
    let raw = await api.GetTranslation(ctx, key)
    if (!raw) {
      raw = key
    }
    for (const arg of args) {
      raw = raw.replace("%s", arg)
    }
    return raw
  } catch {
    return key
  }
}

function renderArt(text: string, font: string): string {
  // Throws when the font file is missing or the text cannot be rendered.
  return figletAny.textSync(text, { font })
}

/**
 * Number of visible rows in rendered art. figlet may end its output with a
 * newline, which would otherwise count as an extra empty line. Exported for tests.
 */
export function artLineCount(art: string): number {
  return art.replace(/\r?\n$/, "").split("\n").length
}

/**
 * Count Unicode code points instead of UTF-16 code units, so an emoji counts as
 * one character rather than two. Exported for tests.
 */
export function characterCount(text: string): number {
  return Array.from(text).length
}

function resolveFont(name: string): string | undefined {
  const lower = name.toLowerCase()
  return fontNames.find(f => f.toLowerCase() === lower)
}

/** Wox stores checkbox values as the strings "true" and "false". */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = (value ?? "").trim().toLowerCase()
  if (normalized === "true" || normalized === "1") {
    return true
  }
  if (normalized === "false" || normalized === "0" || normalized === "") {
    return false
  }
  return fallback
}

/** Map a stored language id or label to a known registry entry. */
function normalizeCodeLanguage(value: string | undefined): string {
  return resolveSnippetLanguage(value)?.Id ?? DEFAULT_SNIPPET_LANGUAGE
}

/**
 * Read one named argument from the QueryHint that Wox installed for a declared command.
 * The Node.js host parses the hint the Go side sends as a JSON string, so the value is
 * already an object here. Returns undefined when that slot is absent from the hint.
 */
function hintArgument(query: Query, id: string): string | undefined {
  const element = query.QueryHint?.Elements?.find(e => e.Id === id)
  return element && element.Kind === "argument" ? element.Value ?? "" : undefined
}

function suggestFonts(name: string, limit = 8): string[] {
  const lower = name.toLowerCase()
  return fontNames.filter(f => f.toLowerCase().includes(lower)).slice(0, limit)
}

function previewOf(text: string, font: string): string {
  const cacheKey = `${font}\n${text}`
  const cached = previewCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const art = renderArt(text, font)
  previewCache.set(cacheKey, art)
  // Bound the cache: fonts x texts could grow, keep it reasonable.
  if (previewCache.size > 2000) {
    previewCache.clear()
  }
  return art
}

function desktopDir(): string {
  const desktop = path.join(os.homedir(), "Desktop")
  try {
    if (fs.existsSync(desktop) && fs.statSync(desktop).isDirectory()) {
      return desktop
    }
  } catch {
    // fall through to home directory
  }
  return os.homedir()
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function saveArtToFile(text: string, data: string | Buffer, extension: string): string {
  const safe =
    text
      .replace(/[\\/:*?"<>|]/g, "")
      .trim()
      .slice(0, 40) || "ascii-art"
  const now = new Date()
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const filePath = path.join(desktopDir(), `${safe}-${stamp}.${extension}`)
  fs.writeFileSync(filePath, data)
  return filePath
}

function copyAction(text: string, art: string, font: string): ResultAction {
  return {
    // Action ids must be unique within one query response: the Wox host caches
    // action callbacks in a map keyed by Id, so reusing one Id across results
    // makes every result run the last registered callback.
    Id: `copy:${font}`,
    Name: "i18n:action_copy",
    IsDefault: true,
    Action: async (actionCtx: Context) => {
      await api.Copy(actionCtx, { type: "text", text: art })
      await api.Notify(actionCtx, await t(actionCtx, "notify_copied"))
      await api.HideApp(actionCtx)
      await api.Log(actionCtx, "Info", `Copied ASCII art of "${text}" in font ${font}`)
    }
  }
}

function codeCopyAction(name: string, text: string, art: string, font: string, language: SnippetLanguage): ResultAction {
  return {
    Id: `copy-code:${font}:${language.Id}`,
    Name: name,
    Action: async (actionCtx: Context) => {
      try {
        const snippet = buildSnippet(language.Id, art)
        await api.Copy(actionCtx, { type: "text", text: snippet })
        await api.Notify(actionCtx, await t(actionCtx, "notify_copied_code", language.Label))
        await api.HideApp(actionCtx)
        await api.Log(actionCtx, "Info", `Copied ${language.Label} snippet of "${text}" in font ${font}`)
      } catch (e) {
        await api.Notify(actionCtx, await t(actionCtx, "error_copy_code_failed", String(e)))
      }
    }
  }
}

function saveAction(text: string, art: string, font: string): ResultAction {
  return {
    Id: `save:${font}`,
    Name: "i18n:action_save",
    Action: async (actionCtx: Context) => {
      try {
        const filePath = saveArtToFile(text, art, "txt")
        await api.Notify(actionCtx, await t(actionCtx, "notify_saved", filePath))
      } catch (e) {
        await api.Notify(actionCtx, await t(actionCtx, "error_render_failed", String(e)))
      }
      await api.HideApp(actionCtx)
    }
  }
}

function copyImageAction(text: string, art: string, font: string): ResultAction {
  return {
    Id: `copy-image:${font}`,
    Name: "i18n:action_copy_image",
    Action: async (actionCtx: Context) => {
      try {
        const image = await renderArtImage({ art, theme: await previewTheme(actionCtx) })
        await api.Copy(actionCtx, {
          type: "image",
          text: "",
          woxImage: {
            ImageType: "base64",
            ImageData: `data:image/png;base64,${image.buffer.toString("base64")}`
          }
        })
        await api.Notify(actionCtx, await t(actionCtx, "notify_copied_image"))
        await api.HideApp(actionCtx)
        await api.Log(actionCtx, "Info", `Copied image of "${text}" in font ${font} (${image.width}x${image.height})`)
      } catch (e) {
        await api.Notify(actionCtx, await t(actionCtx, "error_image_failed", String(e)))
      }
    }
  }
}

function saveImageAction(text: string, art: string, font: string): ResultAction {
  return {
    Id: `save-image:${font}`,
    Name: "i18n:action_save_image",
    Action: async (actionCtx: Context) => {
      try {
        const image = await renderArtImage({ art, theme: await previewTheme(actionCtx) })
        const filePath = saveArtToFile(text, image.buffer, "png")
        await api.Notify(actionCtx, await t(actionCtx, "notify_saved_image", filePath))
        await api.Log(actionCtx, "Info", `Saved image of "${text}" in font ${font} to ${filePath}`)
      } catch (e) {
        await api.Notify(actionCtx, await t(actionCtx, "error_image_failed", String(e)))
      }
      await api.HideApp(actionCtx)
    }
  }
}

function listFontsAction(trigger: string | undefined, sample = ""): ResultAction {
  return {
    Id: "list-fonts",
    Name: "i18n:help_list_fonts_title",
    IsDefault: true,
    PreventHideAfterAction: true,
    Action: async (actionCtx: Context) => {
      listSample = sample
      await api.ChangeQuery(actionCtx, { QueryType: "input", QueryText: fontsQueryText(trigger) })
    }
  }
}

async function renderResult(ctx: Context, text: string, font: string, art: string, trigger: string | undefined): Promise<Result> {
  const lines = artLineCount(art)
  const theme = await previewTheme(ctx)
  const [fontTooltip, linesLabel, linesTooltip, charactersLabel, charactersTooltip] = await Promise.all([
    t(ctx, "preview_label_font"),
    t(ctx, "preview_lines", String(lines)),
    t(ctx, "preview_label_lines"),
    t(ctx, "preview_characters", String(characterCount(text))),
    t(ctx, "preview_label_characters")
  ])
  const previewTags: WoxPreviewTag[] = [
    { Label: font, Tooltip: fontTooltip },
    { Label: linesLabel, Tooltip: linesTooltip },
    { Label: charactersLabel, Tooltip: charactersTooltip }
  ]
  const actions: ResultAction[] = [copyAction(text, art, font)]
  if (art) {
    actions.push(copyImageAction(text, art, font))
  }
  if (copyCodeEnabled) {
    const language = resolveSnippetLanguage(codeLanguage) ?? SNIPPET_LANGUAGES[0]
    actions.push(codeCopyAction(await t(ctx, "action_copy_code", language.Label), text, art, font, language))
  }
  actions.push(saveAction(text, art, font))
  if (art) {
    actions.push(saveImageAction(text, art, font))
  }
  actions.push({
    Id: `more-fonts:${font}`,
    Name: "i18n:action_more_fonts",
    PreventHideAfterAction: true,
    Action: async actionCtx => {
      // Remember what the user actually rendered so the font list previews it.
      listSample = text
      await api.ChangeQuery(actionCtx, { QueryType: "input", QueryText: fontsQueryText(trigger) })
    }
  })
  return {
    Title: await t(ctx, "render_title", text),
    SubTitle: await t(ctx, "render_subtitle", font),
    Icon: appIcon,
    Score: 100,
    Preview: buildArtPreview(art, previewTags, theme),
    Actions: actions
  }
}

async function fontListResults(ctx: Context, filter: string, trigger: string | undefined): Promise<Result[]> {
  const sample = listSample || SAMPLE_FALLBACK
  const lower = filter.toLowerCase()
  const matched = fontNames.filter(f => !lower || f.toLowerCase().includes(lower)).slice(0, 120)
  const [subtitle, fontTooltip, sampleTooltip] = await Promise.all([t(ctx, "font_item_subtitle", sample), t(ctx, "preview_label_font"), t(ctx, "preview_label_sample")])
  const theme = await previewTheme(ctx)
  const codeLanguageSpec = copyCodeEnabled ? resolveSnippetLanguage(codeLanguage) : undefined
  const codeActionName = codeLanguageSpec ? await t(ctx, "action_copy_code", codeLanguageSpec.Label) : ""
  return matched.map(font => {
    let art = ""
    try {
      art = previewOf(sample, font)
    } catch {
      // leave the preview empty, the copy action will surface the error
    }
    const actions: ResultAction[] = [
      {
        Id: `copy-art:${font}`,
        Name: "i18n:action_copy",
        IsDefault: true,
        Action: async actionCtx => {
          const full = previewOf(sample, font)
          await api.Copy(actionCtx, { type: "text", text: full })
          await api.Notify(actionCtx, await t(actionCtx, "notify_copied"))
          await api.HideApp(actionCtx)
        }
      }
    ]
    if (codeLanguageSpec && art) {
      actions.push(codeCopyAction(codeActionName, sample, art, font, codeLanguageSpec))
    }
    if (art) {
      actions.push(copyImageAction(sample, art, font), saveImageAction(sample, art, font))
    }
    actions.push(
      {
        Id: `use-font:${font}`,
        Name: "i18n:action_use_font",
        PreventHideAfterAction: true,
        Action: async actionCtx => {
          await api.ChangeQuery(actionCtx, {
            QueryType: "input",
            QueryText: fontCommandText(trigger, font)
          })
        }
      },
      {
        Id: `copy-font-name:${font}`,
        Name: "i18n:action_copy_font_name",
        Action: async actionCtx => {
          await api.Copy(actionCtx, { type: "text", text: font })
          await api.Notify(actionCtx, await t(actionCtx, "notify_copied_font_name", font))
          await api.HideApp(actionCtx)
        }
      },
      {
        Id: `set-default:${font}`,
        Name: "i18n:action_set_default_font",
        Action: async actionCtx => {
          defaultFont = font
          const saved = await api.SetSetting(actionCtx, {
            Key: SETTING_FONT_KEY,
            Value: font,
            PlatformSpecific: false,
            IsLocal: false
          })
          if (!saved.Success) {
            await api.Log(actionCtx, "Error", `Failed to save default font: ${saved.ErrMsg}`)
          }
          await api.Notify(actionCtx, await t(actionCtx, "notify_default_font", font))
        }
      }
    )
    const result: Result = {
      Title: font,
      SubTitle: subtitle,
      Icon: appIcon,
      Score: lower ? (font.toLowerCase() === lower ? 100 : font.toLowerCase().startsWith(lower) ? 80 : 50) : 50,
      Actions: actions
    }
    if (art) {
      result.Preview = buildArtPreview(
        art,
        [
          { Label: font, Tooltip: fontTooltip },
          { Label: sample, Tooltip: sampleTooltip }
        ],
        theme
      )
    }
    return result
  })
}

async function helpResults(ctx: Context, trigger: string): Promise<Result[]> {
  const changeToFonts = listFontsAction(trigger)
  const examplePrefix = trigger ? `${trigger} ` : ""
  return [
    {
      Title: await t(ctx, "help_title"),
      SubTitle: await t(ctx, "help_subtitle", examplePrefix, examplePrefix, examplePrefix),
      Icon: appIcon,
      Score: 100,
      Actions: [changeToFonts]
    },
    {
      Title: await t(ctx, "help_list_fonts_title"),
      SubTitle: await t(ctx, "help_list_fonts_subtitle"),
      Icon: appIcon,
      Score: 90,
      Actions: [changeToFonts]
    },
    {
      Title: await t(ctx, "help_current_font", defaultFont),
      SubTitle: await t(ctx, "setting_font_tooltip"),
      Icon: appIcon,
      Score: 80,
      Actions: [changeToFonts]
    }
  ]
}

async function fontNotFoundResults(ctx: Context, name: string, text: string, trigger: string): Promise<Result[]> {
  const suggestions = suggestFonts(name)
  const results: Result[] = [
    {
      Title: await t(ctx, "error_font_not_found", name),
      SubTitle: await t(ctx, "help_list_fonts_subtitle"),
      Icon: appIcon,
      Score: 100,
      Actions: [listFontsAction(trigger, text)]
    }
  ]
  for (const font of suggestions) {
    try {
      results.push(await renderResult(ctx, text, font, renderArt(text, font), trigger))
    } catch {
      // skip fonts that fail to render
    }
  }
  return results
}

async function renderErrorResult(ctx: Context, font: string, e: unknown, trigger: string): Promise<Result> {
  return {
    Title: await t(ctx, "error_render_failed", String(e)),
    SubTitle: font,
    Icon: appIcon,
    Actions: [listFontsAction(trigger)]
  }
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    try {
      figletAny.defaults({ fontPath: path.join(__dirname, "fonts") })
      fontNames = figletAny.fontsSync()
    } catch (e) {
      await api.Log(ctx, "Error", `Failed to load figlet fonts: ${String(e)}`)
      fontNames = []
    }
    try {
      const saved = await api.GetSetting(ctx, SETTING_FONT_KEY)
      const resolved = saved ? resolveFont(saved) : undefined
      if (resolved) {
        defaultFont = resolved
      }
    } catch {
      // keep default
    }
    try {
      copyCodeEnabled = parseBoolean(await api.GetSetting(ctx, SETTING_COPY_CODE_ENABLED_KEY), false)
    } catch {
      copyCodeEnabled = false
    }
    try {
      codeLanguage = normalizeCodeLanguage(await api.GetSetting(ctx, SETTING_COPY_CODE_LANGUAGE_KEY))
    } catch {
      codeLanguage = DEFAULT_SNIPPET_LANGUAGE
    }
    try {
      settingFontLabel = await api.GetTranslation(ctx, "setting_font_label")
      settingFontTooltip = await api.GetTranslation(ctx, "setting_font_tooltip")
    } catch {
      // keep English fallbacks
    }
    await api.OnSettingChanged(ctx, (_c, key, value) => {
      if (key === SETTING_FONT_KEY && value) {
        const resolved = resolveFont(value)
        if (resolved) {
          defaultFont = resolved
        }
      }
      if (key === SETTING_COPY_CODE_ENABLED_KEY) {
        copyCodeEnabled = parseBoolean(value, false)
      }
      if (key === SETTING_COPY_CODE_LANGUAGE_KEY) {
        codeLanguage = normalizeCodeLanguage(value)
      }
    })

    // Wox version 2.4.8 or later is required.
    await api.OnGetDynamicSetting(ctx, (_c, key): PluginSettingDefinitionItem => {
      if (key !== DYNAMIC_SETTING_KEY) {
        return {
          Type: "label",
          Value: { Content: `Unknown setting: ${key}`, Tooltip: "" },
          DisabledInPlatforms: [],
          IsPlatformSpecific: false
        }
      }
      return {
        Type: "select",
        Value: {
          Key: SETTING_FONT_KEY,
          Label: settingFontLabel,
          Suffix: "",
          DefaultValue: DEFAULT_FONT,
          Tooltip: settingFontTooltip,
          Options: fontNames.map(name => ({ Label: name, Value: name })),
          Validators: []
        },
        DisabledInPlatforms: [],
        IsPlatformSpecific: false
      }
    })
    await api.Log(ctx, "Info", `Figlet init finished, ${fontNames.length} fonts loaded, default font: ${defaultFont}`)
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    // Wox splits a declared command out of the search text (see "Commands" in plugin.json),
    // so `ascii fonts sl` arrives as Command="fonts", Search="sl". This plugin parses the
    // whole line itself, so fold the command back in and keep a single parsing path.
    const search = [query.Command ?? "", query.Search].filter(Boolean).join(" ").trim()
    // Wox lets the user rename the trigger keyword, so always echo back the keyword
    // that actually invoked this query when building ChangeQuery actions.
    const trigger = query.TriggerKeyword ?? ""

    const tokens = tokenize(search)
    const head = tokens[0]?.toLowerCase() ?? ""

    // ascii fonts [filter] — browse fonts with a live preview
    if (head === "fonts") {
      return fontListResults(ctx, tokens.slice(1).join(" "), trigger)
    }

    // Anything else means the user left the font list flow: forget the preview text
    // remembered by the jump action, so a later `ascii fonts` starts from the fallback.
    listSample = ""

    if (!search) {
      return helpResults(ctx, trigger)
    }

    // ascii -f <font> <text> / ascii --font=<font> <text> — render with an explicit font
    // Wox installs the "-f" QueryHint declared in plugin.json once the user types `ascii -f `,
    // which keeps the font name (spaces allowed) and the text in separate Tab-navigable slots.
    // Prefer the hint only when both slots are filled; otherwise (paste, a
    // boundary-crossing edit, or the user never pressed Tab) parse the text as before.
    const hintFont = hintArgument(query, "font")
    const hintText = hintArgument(query, "text")

    let explicitFont: string | undefined
    let rest: string[] = []
    if (hintFont && hintText) {
      explicitFont = hintFont
      rest = [hintText]
    } else if (head === "-f" || head === "--font") {
      // A missing font name stays an empty string instead of undefined so the shared
      // `!explicitFont` check below shows help rather than rendering the literal flag.
      explicitFont = tokens[1] ?? ""
      rest = tokens.slice(2)
    } else if (head.startsWith("--font=") || head.startsWith("-f=")) {
      explicitFont = head.slice(head.indexOf("=") + 1)
      rest = tokens.slice(1)
    }
    if (explicitFont !== undefined) {
      // Strip surrounding quotes for the --font="Name With Spaces" form
      // (the tokenizer only strips quotes around whitespace-separated tokens).
      explicitFont = explicitFont.replace(/^["']|["']$/g, "")
      const text = rest.join(" ").trim()
      if (!explicitFont || !text) {
        return helpResults(ctx, trigger)
      }
      const font = resolveFont(explicitFont)
      if (!font) {
        return fontNotFoundResults(ctx, explicitFont, text, trigger)
      }
      try {
        return [await renderResult(ctx, text, font, renderArt(text, font), trigger)]
      } catch (e) {
        return [await renderErrorResult(ctx, font, e, trigger)]
      }
    }

    // ascii <text> — render with the default font
    try {
      return [await renderResult(ctx, search, defaultFont, renderArt(search, defaultFont), trigger)]
    } catch (e) {
      return [await renderErrorResult(ctx, defaultFont, e, trigger)]
    }
  }
}
