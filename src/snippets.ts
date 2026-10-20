/**
 * Code snippets that print ASCII art.
 *
 * A language is described either by a per-line `Statement` or by a `Build`
 * function for formats that need a block wrapper (HTML, Markdown, ...).
 * Keeping the registry declarative makes adding a language a one-line change.
 */

import { escapeHtml } from "./preview"

export const DEFAULT_SNIPPET_LANGUAGE = "bash"

export type SnippetLanguage =
  | {
      Id: string
      Label: string
      Statement: (line: string) => string
      LineEnding?: "\n" | "\r\n"
    }
  | {
      Id: string
      Label: string
      Build: (lines: string[]) => string
    }

/* ------------------------------------------------------------------ */
/* Escaping helpers                                                    */
/* ------------------------------------------------------------------ */

/** C-style escapes, used by most double-quoted string literals. */
function escapeDouble(line: string): string {
  return line.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t").replace(/\r/g, "\\r")
}

/** Escape for languages whose single-quoted strings still process \\ and \'. */
function escapeSingle(line: string): string {
  return line.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

/** POSIX shell single-quoted body: nothing is special except the quote itself. */
function escapeShellSingle(line: string): string {
  return line.replace(/'/g, "'\\''")
}

/** PowerShell single-quoted body: a quote is doubled. */
function escapePowerShellSingle(line: string): string {
  return line.replace(/'/g, "''")
}

function quoteDouble(line: string): string {
  return `"${escapeDouble(line)}"`
}

function quoteSingle(line: string): string {
  return `'${escapeSingle(line)}'`
}

/** V single-quoted strings interpolate `$`; escape it along with the usual characters. */
function quoteV(line: string): string {
  return `'${escapeSingle(line).replace(/\$/g, "\\$")}'`
}

function quoteShellSingle(line: string): string {
  return `'${escapeShellSingle(line)}'`
}

function quotePowerShellSingle(line: string): string {
  return `'${escapePowerShellSingle(line)}'`
}

/** Doubled-quote literals: " -> "" (VB, Ada, Fortran, COBOL, AutoIt, ...). */
function doubleDoubleQuotes(line: string): string {
  return `"${line.replace(/"/g, '""')}"`
}

/** Common Lisp only escapes backslash and quote, so a tab stays a literal tab. */
function quoteLisp(line: string): string {
  return `"${line.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** Doubled-single-quote literals: ' -> '' (Pascal, MATLAB, SQL, ...). */
function doubleSingleQuotes(line: string): string {
  return `'${line.replace(/'/g, "''")}'`
}

/** Kotlin/Dart/Julia: `$` starts string interpolation. */
function quoteDollarDouble(line: string): string {
  return `"${escapeDouble(line).replace(/\$/g, "\\$")}"`
}

/** Elixir/Crystal: `#{}` starts interpolation. */
function quoteHashBraceDouble(line: string): string {
  return `"${escapeDouble(line).replace(/#\{/g, "\\#{")}"`
}

/** Rust format strings treat braces specially. */
function quoteRust(line: string): string {
  return `"${escapeDouble(line).replace(/\{/g, "{{").replace(/\}/g, "}}")}"`
}

/** Erlang format strings treat `~` specially; `~n` terminates the line. */
function quoteErlang(line: string): string {
  return `"${escapeDouble(line).replace(/~/g, "~~")}~n"`
}

/** Tcl double-quoted strings substitute $variables and [commands]. */
function quoteTcl(line: string): string {
  return `"${escapeDouble(line).replace(/\$/g, "\\$").replace(/\[/g, "\\[").replace(/\]/g, "\\]")}"`
}

/** Verilog $display treats `%` as a format directive. */
function quoteVerilog(line: string): string {
  return `"${escapeDouble(line).replace(/%/g, "%%")}"`
}

/** CMake expands ${variables} inside quoted arguments. */
function quoteCmake(line: string): string {
  return `"${escapeDouble(line).replace(/\$/g, "\\$")}"`
}

/** AutoHotkey uses a backtick as its escape character. */
function quoteAutoHotkey(line: string): string {
  return `"${line.replace(/`/g, "``").replace(/"/g, '`"')}"`
}

/**
 * Batch files: `%` expands variables, `^` escapes, and & | < > split commands.
 * `echo(` keeps leading spaces and does not echo the parentheses.
 * Delayed expansion (`!`) is intentionally not handled; it is off by default.
 */
function batchStatement(line: string): string {
  if (line === "") {
    return "echo."
  }
  const escaped = line.replace(/\^/g, "^^").replace(/%/g, "%%").replace(/&/g, "^&").replace(/\|/g, "^|").replace(/</g, "^<").replace(/>/g, "^>")
  return `echo(${escaped}`
}

/** Make expands `$` in recipe lines before the shell sees the single-quoted text. */
function makefileStatement(line: string): string {
  // Use a function: in a replacement string "$$" would collapse back to one "$".
  const escaped = line.replace(/\$/g, () => "$$")
  return `\t@echo ${quoteShellSingle(escaped)}`
}

/** NASM data directive, one per line. */
function nasmStatement(line: string): string {
  if (line === "") {
    return "db 10"
  }
  return `db ${quoteDouble(line)}, 10`
}

/* ------------------------------------------------------------------ */
/* Block formats                                                       */
/* ------------------------------------------------------------------ */

function longestBacktickRun(text: string): number {
  const runs = text.match(/`+/g)
  return runs ? runs.reduce((max, run) => Math.max(max, run.length), 0) : 0
}

function buildHtml(lines: string[]): string {
  const body = escapeHtml(lines.join("\n"))
  // A newline directly after <pre> is dropped by the HTML parser; keep a leading
  // one as an entity so the art survives the round trip unchanged.
  const safeBody = body.startsWith("\n") ? `&#10;${body.slice(1)}` : body
  return `<pre>${safeBody}</pre>`
}

function buildMarkdown(lines: string[]): string {
  // A fence longer than any backtick run in the art cannot be closed early.
  const fence = "`".repeat(Math.max(3, longestBacktickRun(lines.join("\n")) + 1))
  return `${fence}text\n${lines.join("\n")}\n${fence}`
}

function buildLatex(lines: string[]): string {
  return `\\begin{verbatim}\n${lines.join("\n")}\n\\end{verbatim}`
}

function buildJson(lines: string[]): string {
  return JSON.stringify(lines, null, 2)
}

function buildYaml(lines: string[]): string {
  // |2- fixes the content indentation at two spaces and strips the final newline.
  const body = lines.map(line => (line === "" ? "" : `  ${line}`)).join("\n")
  return `art: |2-\n${body}`
}

function escapeTomlBasic(line: string): string {
  return line.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t").replace(/\r/g, "\\r")
}

function buildToml(lines: string[]): string {
  const rows = lines.map(line => `  "${escapeTomlBasic(line)}"`).join(",\n")
  return `art = [\n${rows}\n]`
}

/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* ------------------------------------------------------------------ */

/**
 * Order is the order of the settings dropdown: the core languages first, then
 * the less common ones, then formats. Keep `plugin.json` in sync; a test
 * compares both lists so the manifest cannot drift from this registry.
 */
export const SNIPPET_LANGUAGES: SnippetLanguage[] = [
  // A. Core languages
  { Id: "bash", Label: "Bash", Statement: line => `echo ${quoteShellSingle(line)}` },
  { Id: "powershell", Label: "PowerShell", Statement: line => `Write-Output ${quotePowerShellSingle(line)}` },
  { Id: "batch", Label: "Batch (cmd)", Statement: batchStatement, LineEnding: "\r\n" },
  { Id: "python", Label: "Python", Statement: line => `print(${quoteDouble(line)})` },
  { Id: "javascript", Label: "JavaScript", Statement: line => `console.log(${quoteDouble(line)});` },
  { Id: "typescript", Label: "TypeScript", Statement: line => `console.log(${quoteDouble(line)});` },
  { Id: "java", Label: "Java", Statement: line => `System.out.println(${quoteDouble(line)});` },
  { Id: "kotlin", Label: "Kotlin", Statement: line => `println(${quoteDollarDouble(line)})` },
  { Id: "c", Label: "C", Statement: line => `puts(${quoteDouble(line)});` },
  { Id: "cpp", Label: "C++", Statement: line => `std::cout << ${quoteDouble(line)} << std::endl;` },
  { Id: "csharp", Label: "C#", Statement: line => `Console.WriteLine(${quoteDouble(line)});` },
  { Id: "go", Label: "Go", Statement: line => `fmt.Println(${quoteDouble(line)})` },
  { Id: "rust", Label: "Rust", Statement: line => `println!(${quoteRust(line)});` },
  { Id: "swift", Label: "Swift", Statement: line => `print(${quoteDouble(line)})` },
  { Id: "dart", Label: "Dart", Statement: line => `print(${quoteDollarDouble(line)});` },
  { Id: "php", Label: "PHP", Statement: line => `echo ${quoteSingle(line)}, PHP_EOL;` },
  { Id: "ruby", Label: "Ruby", Statement: line => `puts ${quoteSingle(line)}` },
  { Id: "perl", Label: "Perl", Statement: line => `print ${quoteSingle(line)}, "\\n";` },
  { Id: "lua", Label: "Lua", Statement: line => `print(${quoteDouble(line)})` },
  { Id: "r", Label: "R", Statement: line => `cat("${escapeDouble(line)}\\n")` },
  { Id: "matlab", Label: "MATLAB / Octave", Statement: line => `disp(${doubleSingleQuotes(line)})` },
  { Id: "sql", Label: "SQL", Statement: line => `SELECT ${doubleSingleQuotes(line)};` },
  { Id: "haskell", Label: "Haskell", Statement: line => `putStrLn ${quoteDouble(line)}` },
  { Id: "elixir", Label: "Elixir", Statement: line => `IO.puts(${quoteHashBraceDouble(line)})` },
  { Id: "scala", Label: "Scala", Statement: line => `println(${quoteDouble(line)})` },
  { Id: "groovy", Label: "Groovy", Statement: line => `println ${quoteSingle(line)}` },
  { Id: "fsharp", Label: "F#", Statement: line => `printfn "%s" ${quoteDouble(line)}` },
  { Id: "vbnet", Label: "VB.NET", Statement: line => `Console.WriteLine(${doubleDoubleQuotes(line)})` },
  { Id: "pascal", Label: "Delphi / Pascal", Statement: line => `WriteLn(${doubleSingleQuotes(line)});` },
  { Id: "objc", Label: "Objective-C", Statement: line => `printf("%s\\n", ${quoteDouble(line)});` },

  // B. Common additional languages
  { Id: "fish", Label: "Fish", Statement: line => `echo ${quoteSingle(line)}` },
  { Id: "tcl", Label: "Tcl", Statement: line => `puts ${quoteTcl(line)}` },
  { Id: "awk", Label: "AWK", Statement: line => `print ${quoteDouble(line)}` },
  { Id: "ocaml", Label: "OCaml", Statement: line => `print_endline ${quoteDouble(line)}` },
  { Id: "clojure", Label: "Clojure", Statement: line => `(println ${quoteDouble(line)})` },
  { Id: "lisp", Label: "Common Lisp", Statement: line => `(write-line ${quoteLisp(line)})` },
  { Id: "scheme", Label: "Scheme / Racket", Statement: line => `(displayln ${quoteDouble(line)})` },
  { Id: "erlang", Label: "Erlang", Statement: line => `io:format(${quoteErlang(line)}).` },
  { Id: "julia", Label: "Julia", Statement: line => `println(${quoteDollarDouble(line)})` },
  { Id: "nim", Label: "Nim", Statement: line => `echo ${quoteDouble(line)}` },
  { Id: "crystal", Label: "Crystal", Statement: line => `puts ${quoteHashBraceDouble(line)}` },
  { Id: "d", Label: "D", Statement: line => `writeln(${quoteDouble(line)});` },
  { Id: "zig", Label: "Zig", Statement: line => `std.debug.print("{s}\\n", .{${quoteDouble(line)}});` },
  { Id: "ada", Label: "Ada", Statement: line => `Put_Line (${doubleDoubleQuotes(line)});` },
  { Id: "fortran", Label: "Fortran", Statement: line => `print *, ${doubleDoubleQuotes(line)}` },
  { Id: "cobol", Label: "COBOL", Statement: line => `DISPLAY ${doubleDoubleQuotes(line)}` },
  { Id: "vba", Label: "VBA", Statement: line => `Debug.Print ${doubleDoubleQuotes(line)}` },
  { Id: "tsql", Label: "T-SQL", Statement: line => `PRINT N${doubleSingleQuotes(line)};` },
  { Id: "plsql", Label: "PL/SQL", Statement: line => `DBMS_OUTPUT.PUT_LINE(${doubleSingleQuotes(line)});` },
  { Id: "gdscript", Label: "GDScript", Statement: line => `print(${quoteDouble(line)})` },

  // C. Optional / niche languages
  { Id: "arduino", Label: "Arduino", Statement: line => `Serial.println(${quoteDouble(line)});` },
  { Id: "processing", Label: "Processing", Statement: line => `println(${quoteDouble(line)});` },
  { Id: "raku", Label: "Raku", Statement: line => `say ${quoteSingle(line)}` },
  { Id: "haxe", Label: "Haxe", Statement: line => `trace(${quoteDouble(line)});` },
  { Id: "v", Label: "V", Statement: line => `println(${quoteV(line)})` },
  { Id: "prolog", Label: "Prolog", Statement: line => `writeln(${quoteDouble(line)})` },
  { Id: "smalltalk", Label: "Smalltalk", Statement: line => `Transcript show: ${doubleSingleQuotes(line)}; cr.` },
  { Id: "wolfram", Label: "Wolfram Language", Statement: line => `Print[${quoteDouble(line)}]` },
  { Id: "autohotkey", Label: "AutoHotkey", Statement: line => `MsgBox ${quoteAutoHotkey(line)}` },
  { Id: "autoit", Label: "AutoIt", Statement: line => `ConsoleWrite(${doubleDoubleQuotes(line)} & @CRLF)` },
  { Id: "cmake", Label: "CMake", Statement: line => `message(${quoteCmake(line)})` },
  { Id: "nushell", Label: "Nushell", Statement: line => `print ${quoteDouble(line)}` },
  { Id: "verilog", Label: "Verilog / SystemVerilog", Statement: line => `$display(${quoteVerilog(line)});` },
  { Id: "vhdl", Label: "VHDL", Statement: line => `report ${doubleDoubleQuotes(line)} severity note;` },
  { Id: "abap", Label: "ABAP", Statement: line => `WRITE / ${doubleSingleQuotes(line)}.` },

  // D. Formats and build scripts
  { Id: "html", Label: "HTML", Build: buildHtml },
  { Id: "markdown", Label: "Markdown", Build: buildMarkdown },
  { Id: "latex", Label: "LaTeX", Build: buildLatex },
  { Id: "json", Label: "JSON", Build: buildJson },
  { Id: "yaml", Label: "YAML", Build: buildYaml },
  { Id: "toml", Label: "TOML", Build: buildToml },
  { Id: "makefile", Label: "Makefile", Statement: makefileStatement },
  { Id: "dockerfile", Label: "Dockerfile", Statement: line => `RUN printf '%s\\n' ${quoteShellSingle(line)}` },
  { Id: "nasm", Label: "NASM (x86)", Statement: nasmStatement }
]

export function resolveSnippetLanguage(value: string | undefined): SnippetLanguage | undefined {
  const normalized = (value ?? "").trim().toLowerCase()
  if (!normalized) {
    return undefined
  }
  return SNIPPET_LANGUAGES.find(language => language.Id === normalized || language.Label.toLowerCase() === normalized)
}

export function snippetOptions(): { Label: string; Value: string }[] {
  return SNIPPET_LANGUAGES.map(language => ({ Label: language.Label, Value: language.Id }))
}

function splitArtLines(art: string): string[] {
  const normalized = art.replace(/\r\n?/g, "\n")
  // figlet returns one trailing newline as a record separator, not an art line.
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized
  return trimmed.split("\n")
}

/** Build the snippet for one language, or "" when there is nothing to copy. */
export function buildSnippet(languageId: string, art: string): string {
  if (art === "") {
    return ""
  }
  const language = resolveSnippetLanguage(languageId) ?? SNIPPET_LANGUAGES[0]
  const lines = splitArtLines(art)
  if ("Build" in language) {
    return language.Build(lines)
  }
  return lines.map(line => language.Statement(line)).join(language.LineEnding ?? "\n")
}
