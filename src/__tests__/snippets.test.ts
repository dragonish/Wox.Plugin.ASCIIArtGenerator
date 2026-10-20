import * as fs from "fs"
import * as path from "path"
import { buildSnippet, resolveSnippetLanguage, SNIPPET_LANGUAGES, snippetOptions } from "../snippets"

// One plain line keeps this table readable. Escaping edge cases are tested below.
const simpleCases: Array<[string, string]> = [
  ["bash", "echo 'X'"],
  ["powershell", "Write-Output 'X'"],
  ["batch", "echo(X"],
  ["python", 'print("X")'],
  ["javascript", 'console.log("X");'],
  ["typescript", 'console.log("X");'],
  ["java", 'System.out.println("X");'],
  ["kotlin", 'println("X")'],
  ["c", 'puts("X");'],
  ["cpp", 'std::cout << "X" << std::endl;'],
  ["csharp", 'Console.WriteLine("X");'],
  ["go", 'fmt.Println("X")'],
  ["rust", 'println!("X");'],
  ["swift", 'print("X")'],
  ["dart", 'print("X");'],
  ["php", "echo 'X', PHP_EOL;"],
  ["ruby", "puts 'X'"],
  ["perl", "print 'X', \"\\n\";"],
  ["lua", 'print("X")'],
  ["r", 'cat("X\\n")'],
  ["matlab", "disp('X')"],
  ["sql", "SELECT 'X';"],
  ["haskell", 'putStrLn "X"'],
  ["elixir", 'IO.puts("X")'],
  ["scala", 'println("X")'],
  ["groovy", "println 'X'"],
  ["fsharp", 'printfn "%s" "X"'],
  ["vbnet", 'Console.WriteLine("X")'],
  ["pascal", "WriteLn('X');"],
  ["objc", 'printf("%s\\n", "X");'],
  ["fish", "echo 'X'"],
  ["tcl", 'puts "X"'],
  ["awk", 'print "X"'],
  ["ocaml", 'print_endline "X"'],
  ["clojure", '(println "X")'],
  ["lisp", '(write-line "X")'],
  ["scheme", '(displayln "X")'],
  ["erlang", 'io:format("X~n").'],
  ["julia", 'println("X")'],
  ["nim", 'echo "X"'],
  ["crystal", 'puts "X"'],
  ["d", 'writeln("X");'],
  ["zig", 'std.debug.print("{s}\\n", .{"X"});'],
  ["ada", 'Put_Line ("X");'],
  ["fortran", 'print *, "X"'],
  ["cobol", 'DISPLAY "X"'],
  ["vba", 'Debug.Print "X"'],
  ["tsql", "PRINT N'X';"],
  ["plsql", "DBMS_OUTPUT.PUT_LINE('X');"],
  ["gdscript", 'print("X")'],
  ["arduino", 'Serial.println("X");'],
  ["processing", 'println("X");'],
  ["raku", "say 'X'"],
  ["haxe", 'trace("X");'],
  ["v", "println('X')"],
  ["prolog", 'writeln("X")'],
  ["smalltalk", "Transcript show: 'X'; cr."],
  ["wolfram", 'Print["X"]'],
  ["autohotkey", 'MsgBox "X"'],
  ["autoit", 'ConsoleWrite("X" & @CRLF)'],
  ["cmake", 'message("X")'],
  ["nushell", 'print "X"'],
  ["verilog", '$display("X");'],
  ["vhdl", 'report "X" severity note;'],
  ["abap", "WRITE / 'X'."],
  ["html", "<pre>X</pre>"],
  ["markdown", "```text\nX\n```"],
  ["latex", "\\begin{verbatim}\nX\n\\end{verbatim}"],
  ["json", '[\n  "X"\n]'],
  ["yaml", "art: |2-\n  X"],
  ["toml", 'art = [\n  "X"\n]'],
  ["makefile", "\t@echo 'X'"],
  ["dockerfile", "RUN printf '%s\\n' 'X'"],
  ["nasm", 'db "X", 10']
]

describe("snippet languages", () => {
  test("ids and labels are unique", () => {
    expect(new Set(SNIPPET_LANGUAGES.map(language => language.Id)).size).toBe(SNIPPET_LANGUAGES.length)
    expect(new Set(SNIPPET_LANGUAGES.map(language => language.Label)).size).toBe(SNIPPET_LANGUAGES.length)
  })

  test("the manifest dropdown stays in sync with the registry", () => {
    interface ManifestOption {
      Label: string
      Value: string
    }
    interface ManifestSetting {
      Type?: string
      Value?: {
        Key?: string
        DefaultValue?: string
        Options?: ManifestOption[]
      }
    }
    interface Manifest {
      SettingDefinitions?: ManifestSetting[]
    }

    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../plugin.json"), "utf-8")) as Manifest
    const checkbox = manifest.SettingDefinitions?.find(item => item.Value?.Key === "copy_code_enabled")
    expect(checkbox?.Type).toBe("checkbox")
    expect(checkbox?.Value?.DefaultValue).toBe("false")

    const setting = manifest.SettingDefinitions?.find(item => item.Value?.Key === "copy_code_language")
    expect(setting?.Type).toBe("select")
    expect(setting?.Value?.DefaultValue).toBe("bash")
    expect(setting?.Value?.Options).toEqual(snippetOptions())
  })

  test.each(simpleCases)("%s builds the expected snippet", (id, expected) => {
    expect(buildSnippet(id, "X")).toBe(expected)
  })

  test("resolves ids and labels case-insensitively", () => {
    expect(resolveSnippetLanguage("bash")?.Id).toBe("bash")
    expect(resolveSnippetLanguage("Bash")?.Id).toBe("bash")
    expect(resolveSnippetLanguage("BATCH (CMD)")?.Id).toBe("batch")
    expect(resolveSnippetLanguage("unknown")).toBeUndefined()
  })

  test("falls back to bash for an unknown language", () => {
    expect(buildSnippet("unknown", "X")).toBe("echo 'X'")
  })

  test("returns nothing for empty art", () => {
    expect(buildSnippet("python", "")).toBe("")
  })
})

describe("snippet line handling", () => {
  test("strips the figlet trailing newline", () => {
    expect(buildSnippet("python", "a\nb\n")).toBe('print("a")\nprint("b")')
  })

  test("normalizes CRLF", () => {
    expect(buildSnippet("python", "a\r\nb")).toBe('print("a")\nprint("b")')
  })

  test("keeps blank lines", () => {
    expect(buildSnippet("python", "a\n\nb")).toBe('print("a")\nprint("")\nprint("b")')
  })

  test("uses CRLF for batch files", () => {
    expect(buildSnippet("batch", "a\nb")).toBe("echo(a\r\necho(b")
  })
})

describe("snippet escaping", () => {
  test("bash only escapes the single quote", () => {
    expect(buildSnippet("bash", "a'b")).toBe(String.raw`echo 'a'\''b'`)
  })

  test("C-style double quotes escape backslashes and quotes", () => {
    expect(buildSnippet("python", 'a"b\\c')).toBe(String.raw`print("a\"b\\c")`)
  })

  test("batch escapes command separators and variable expansion", () => {
    expect(buildSnippet("batch", "a&b|c<d>e%f^g")).toBe(String.raw`echo(a^&b^|c^<d^>e%%f^^g`)
    expect(buildSnippet("batch", "\n")).toBe("echo.")
  })

  test("rust doubles format braces", () => {
    expect(buildSnippet("rust", "a{b}c")).toBe(String.raw`println!("a{{b}}c");`)
  })

  test("elixir escapes interpolation", () => {
    expect(buildSnippet("elixir", "a#{b}")).toBe(String.raw`IO.puts("a\#{b}")`)
  })

  test("erlang escapes the format marker and adds a newline", () => {
    expect(buildSnippet("erlang", "a~b")).toBe(String.raw`io:format("a~~b~n").`)
  })

  test("tcl escapes variable and command substitution", () => {
    expect(buildSnippet("tcl", "$a [b]")).toBe(String.raw`puts "\$a \[b\]"`)
  })

  test("kotlin escapes dollar interpolation", () => {
    expect(buildSnippet("kotlin", "$a")).toBe(String.raw`println("\$a")`)
  })

  test("V escapes dollar interpolation in single quotes", () => {
    expect(buildSnippet("v", "$a")).toBe(String.raw`println('\$a')`)
  })

  test("Common Lisp escapes quotes and backslashes", () => {
    expect(buildSnippet("lisp", 'a"b\\c')).toBe(String.raw`(write-line "a\"b\\c")`)
  })

  test("AutoIt doubles quotes instead of using backslash escapes", () => {
    expect(buildSnippet("autoit", 'a"b')).toBe('ConsoleWrite("a""b" & @CRLF)')
  })

  test("makefile protects dollars from make and quotes from the shell", () => {
    expect(buildSnippet("makefile", "$a 'b")).toBe(String.raw`	@echo '$$a '\''b'`)
  })

  test("nasm escapes string characters", () => {
    expect(buildSnippet("nasm", 'a"b\\c')).toBe(String.raw`db "a\"b\\c", 10`)
  })

  test("html escapes markup", () => {
    expect(buildSnippet("html", "<&>")).toBe("<pre>&lt;&amp;&gt;</pre>")
  })

  test("html keeps a leading newline", () => {
    expect(buildSnippet("html", "\na")).toBe("<pre>&#10;a</pre>")
  })

  test("markdown picks a fence longer than any backtick run", () => {
    expect(buildSnippet("markdown", "a```b")).toBe("````text\na```b\n````")
  })

  test("json is valid and preserves the lines", () => {
    expect(JSON.parse(buildSnippet("json", 'a"b\\c\nline2'))).toEqual(['a"b\\c', "line2"])
  })

  test("yaml uses a two-space indented block scalar", () => {
    expect(buildSnippet("yaml", "  a\n\nb")).toBe("art: |2-\n    a\n\n  b")
  })

  test("toml uses an array of basic strings", () => {
    expect(buildSnippet("toml", 'a"b\\c')).toBe('art = [\n  "a\\"b\\\\c"\n]')
  })
})
