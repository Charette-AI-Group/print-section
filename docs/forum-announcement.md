# Forum announcement draft

Post to https://forum.obsidian.md/c/share-showcase/9 (Share & showcase) once the
plugin is live in the community directory.

**IMPORTANT — the category has a required template.** When you click "+ New Topic"
in Share & showcase, Discourse pre-fills the body with that template. Keep it and
fill in the fields; do NOT paste over it. The composer's version is authoritative
if it differs from the reconstruction below. Leaving a placeholder (e.g. "xyz") or
omitting the disclaimer gets the post rejected by moderators.

The disclaimer block and the community directory link must both be present.

For Discord `#updates` (requires the developer role), use the intro paragraph plus
the links; the disclaimer template is forum-only.

## Title

Print Section — print just the part of a note you need, to paper or PDF

## Body

## Disclaimer

> Is this project **open source**? Yes
> Is this project completely **free**? Yes
> Is this project **vibe-coded** beyond the author's ability to comprehend how it works? No

---

[Print Section on the Community Directory](https://community.obsidian.md/plugins/print-section)

Hi everyone! **Print Section** prints part of a note — the selection, or the section your cursor is in — through your system's print dialog, so you can send it to a printer or save it as a PDF.

**Why?** Obsidian can export a whole note to PDF, but it cannot print, and it has no way to print one section of a long note. I kept copying sections into scratch notes just to print them.

**What it does:**

- **No selection needed:** put the cursor anywhere in a section and print it — the heading and everything under it, with or without its subsections
- **Selections that still make sense on paper:** rows cut from the middle of a table keep the header row, lines from inside a code block stay code, lines from inside a callout keep the callout — the plugin repairs the cut before rendering
- **Reading view too:** select across a few paragraphs and print those blocks, or print the section at the top of the window
- **Light colours on paper**, even if you work in a dark theme — the same switch *Export to PDF* makes
- **Page numbers** (`3 / 7`, `Page 3 of 7`) and an optional running header with the note and section name
- **Sensible page breaks:** headings stay with their text, callouts and code blocks are not split, long tables repeat their header row
- The right-click menu says what it will print — *Print section "Budget 2026"* — and every action is a command you can bind to a hotkey

Sections come from the note's live text, so a heading you typed a second ago is already a boundary, and a `# comment` inside a code block is never mistaken for one.

**Install:** search for "Print Section" in Settings → Community plugins → Browse (desktop only).

**Links:** [GitHub repo](https://github.com/Charette-AI-Group/print-section) · Also by me: [HTML Table Toolbar](https://github.com/Charette-AI-Group/html-table-toolbar) · [HTML Font Toolbar](https://github.com/Charette-AI-Group/html-font-toolbar)

Feedback, bug reports, and feature ideas are very welcome, here or on the [GitHub issues](https://github.com/Charette-AI-Group/print-section/issues). Thanks for reading!
