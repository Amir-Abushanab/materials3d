/**
 * The dialog's editor: CodeMirror 6, used both as an editable JSON surface and as a read-only
 * viewer for the exported snippets.
 *
 * Highlighting is the least of it. The reason this replaced a `<textarea>` is
 * {@link https://codemirror.net/docs/ref/#lint | @codemirror/lint}: a config with a stray comma
 * used to report "Unexpected token" into the dialog footer, which tells you *what* is wrong and
 * not *where*. The linter puts the marker on the offending line, and a scene big enough to need
 * the JSON editor is exactly one where hunting for the line by eye is miserable.
 */

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentUnit } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export type EditorLanguage = "json" | "tsx" | "js" | "html";

/** Light, low-contrast highlighting to match the studio chrome: the panel sits next to a
 *  near-white render, and a dark editor beside it reads as a different application. */
const HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.keyword, tags.moduleKeyword], color: "#a24bc8" },
  { tag: [tags.string, tags.special(tags.string)], color: "#2f7d5c" },
  { tag: [tags.number, tags.bool, tags.null], color: "#b25a1e" },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: "#1f5fa8" },
  { tag: [tags.comment], color: "#9a97a2", fontStyle: "italic" },
  { tag: [tags.tagName], color: "#a24bc8" },
  { tag: [tags.attributeName], color: "#1f5fa8" },
  { tag: [tags.function(tags.variableName)], color: "#1f5fa8" },
  { tag: [tags.operator, tags.punctuation], color: "#6d6a75" },
]);

const THEME = EditorView.theme({
  "&": { fontSize: "11.5px", backgroundColor: "transparent", color: "#1b1a1f" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: "1.65",
  },
  ".cm-content": { padding: "12px 0" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "#c3c0c9",
    paddingLeft: "10px",
  },
  ".cm-activeLine": { backgroundColor: "rgba(27, 26, 31, 0.035)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#6d6a75" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(162, 75, 200, 0.18)",
  },
  ".cm-cursor": { borderLeftColor: "#1b1a1f" },
  ".cm-lintRange-error": { backgroundImage: "none", borderBottom: "1.5px solid #d0342c" },
});

/**
 * Report the exact position of a JSON syntax error.
 *
 * `JSON.parse` messages are engine-specific but every current engine states the offset, either as
 * "at position N" (V8, JavaScriptCore) or "line L column C" (SpiderMonkey). Parse whichever we get
 * and fall back to marking the whole document rather than dropping the diagnostic; a marker in
 * roughly the right place beats none at all.
 */
function jsonDiagnostics(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString();
  if (text.trim() === "") return [];
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message = (error as Error).message;
    let from = 0;
    let to = view.state.doc.length;
    const byPosition = /at position (\d+)/.exec(message);
    const byLineColumn = /line (\d+) column (\d+)/.exec(message);
    if (byPosition) {
      from = Math.min(Number(byPosition[1]), view.state.doc.length);
      to = Math.min(from + 1, view.state.doc.length);
    } else if (byLineColumn) {
      const line = view.state.doc.line(Math.min(Number(byLineColumn[1]), view.state.doc.lines));
      from = Math.min(line.from + Number(byLineColumn[2]) - 1, line.to);
      to = Math.min(from + 1, line.to);
    }
    return [{ from, to, severity: "error", message }];
  }
}

function languageExtension(language: EditorLanguage): Extension {
  switch (language) {
    case "json":
      return [json(), lintGutter(), linter(jsonDiagnostics)];
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "html":
      return html();
    case "js":
    default:
      return javascript();
  }
}

export interface CodeEditorOptions {
  /** Called on every edit, used to clear a stale error note as soon as you start typing. */
  onChange?(): void;
}

export class CodeEditor {
  private readonly view: EditorView;
  private language: EditorLanguage = "json";
  private readOnly = false;

  constructor(
    parent: HTMLElement,
    private readonly options: CodeEditorOptions = {},
  ) {
    this.view = new EditorView({ parent, state: this.makeState("") });
  }

  private makeState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        indentUnit.of("  "),
        syntaxHighlighting(HIGHLIGHT),
        THEME,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
          // Tab indents rather than escaping the editor. Acceptable here because this is a modal
          // dialog whose close button is one Escape away, so nobody is trapped.
          indentWithTab,
        ]),
        EditorState.readOnly.of(this.readOnly),
        EditorView.editable.of(!this.readOnly),
        EditorView.lineWrapping,
        languageExtension(this.language),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.options.onChange?.();
        }),
      ],
    });
  }

  /** Replace the document, language and editability in one go (a dialog tab switch). */
  set(doc: string, language: EditorLanguage, readOnly: boolean): void {
    this.language = language;
    this.readOnly = readOnly;
    this.view.setState(this.makeState(doc));
    this.view.scrollDOM.scrollTop = 0;
  }

  get value(): string {
    return this.view.state.doc.toString();
  }

  focus(): void {
    this.view.focus();
  }

  /** Move the cursor to a document offset and scroll it into view, to jump to a parse error. */
  revealOffset(offset: number): void {
    const position = Math.max(0, Math.min(offset, this.view.state.doc.length));
    this.view.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
    });
    this.view.focus();
  }
}
