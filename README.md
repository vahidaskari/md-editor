<div align="center">

# ✎ MD Editor

**A fast, no-nonsense markdown editor that runs entirely in your browser.**

No build step. No server. No account. Just open it and write.

[**→ Try it live**](https://vahidaskari.github.io/md-editor/)

</div>

<!-- Tip: drop a screenshot at docs/screenshot.png and uncomment the line below.
![MD Editor](docs/screenshot.png)
-->

---

Open the page and type. The left pane is markdown, the right is the rendered document, and both are editable — so you can format text by selecting it in the preview instead of remembering the syntax.

Your document is saved in your own browser and never sent anywhere. There is no backend.

## Features

**Writing**

- **Live preview** — renders as you type, in a resizable split view
- **Editable preview** — type directly into the rendered side; it syncs back to markdown
- **Formatting toolbar** — select text or right-click inside the preview for bold, italic, code, headings (H1–H6), lists, links and tables
- **Find & replace** — `Ctrl/Cmd + F`, with a match count and undoable replacements
- **Smart lists** — Enter continues the current bullet, number or checkbox; Tab nests it

**Rendering**

- **Nested lists** and **checklists** — `- [ ]` / `- [x]` become real checkboxes you can tick
- **Tables** with `:---:` column alignment, or insert one at any size
- **Syntax highlighting** — name a language on a fence and the code is coloured
- **Mermaid diagrams** — a ```` ```mermaid ```` fence renders live (flowchart, sequence, class, gantt…)
- **LaTeX math** — inline `$…$` and display `$$…$$`, rendered with KaTeX
- **Footnotes** — `text[^1]` collects into a linked list at the end
- **Autolinks, reference links & inline HTML** — bare URLs become links, `[text][ref]` resolves against `[ref]: url`, and `<details>` blocks work

**Output**

- **Export** — Markdown, PDF (through the browser's own print engine, so the text stays selectable) or a self-contained HTML file
- **Copy** — as Markdown, HTML or plain text
- **Import** — open a `.md` file or drag one onto the window

**Comfort**

- **Reading mode** — hides every control and locks editing; just your document
- **Dark & light themes**, remembered between visits
- **RTL / LTR** — full right-to-left support for Persian, Arabic and Hebrew
- **Sync scroll** between the two panes (toggleable)
- **Autosave** — your document is kept in this browser as you write

## Markdown it understands

| Syntax | Result |
| --- | --- |
| `**bold**` `*italic*` `~~strike~~` | **bold** *italic* ~~strike~~ |
| `` `code` `` | inline code |
| `# H1` … `###### H6` | headings |
| `> quote` | blockquote |
| `- item` / `1. item` | lists — indent to nest |
| `- [ ]` / `- [x]` | checkboxes |
| `[text](url)` or a bare URL | links |
| `[text][ref]` + `[ref]: url` | reference links |
| `![alt](src)` | images |
| <code>\`\`\`js</code> | code block, highlighted |
| <code>\`\`\`mermaid</code> | diagram |
| `$x^2$` / `$$…$$` | math |
| `text[^1]` + `[^1]: note` | footnotes |
| `\|:---\|:---:\|---:\|` | table column alignment |

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + S` | Save as `.md` |
| `Ctrl/Cmd + F` | Find & replace |
| `Ctrl/Cmd + Z` | Undo — including Clear and Replace all |
| `Enter` | Continue the current list / checklist |
| `Tab` | Indent (nests a list item) |
| `Esc` | Close the find bar, a dialog, or reading mode |

## Privacy

Everything runs client-side. There is no analytics, no account, and no upload — your document lives in this browser's local storage and nowhere else. The diagram, math and highlighting libraries are fetched from a CDN the first time a document actually uses one of them, and never on a document that doesn't.
