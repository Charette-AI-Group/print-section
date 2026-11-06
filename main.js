'use strict';

const {
    Plugin, PluginSettingTab, Setting, MarkdownView, MarkdownRenderer, Component, Notice, TFile,
} = require('obsidian');

// ---------------------------------------------------------------------------
// How a printout is made
// ---------------------------------------------------------------------------
//
// 1. Work out the Markdown to print from the live text of the note — never
//    from the metadata cache, which trails unsaved edits and would cut a
//    section at the wrong line.
// 2. Render it with MarkdownRenderer into <body> > div.print, the shape
//    Obsidian's own Export to PDF builds. Obsidian's print stylesheet hides
//    every child of <body> that is not .print, lifts the app's fixed height
//    and scroll clipping, and prints backgrounds — so all of it applies here
//    unchanged, and so do themes and snippets written for PDF export.
// 3. Wait for images, embeds and diagrams to finish arriving.
// 4. window.print(), and put everything back on afterprint.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Everything is namespaced `print-section-`. None of it is ever written into a
// note, so the names can afford to be long and unmistakable.
const ROOT_CLASS = 'print-section-root';
const CONTENT_CLASS = 'print-section-content';
const TITLE_CLASS = 'print-section-title';
const ECONOMY_CLASS = 'print-section-economy';
const COVER_CLASS = 'print-section-cover';

// Read by `@page print-section` in styles.css. A page box inherits from the
// root element and from nothing else, so <html> is the only place a value can
// be handed to it. The page is named, so these reach no other printout —
// Obsidian's PDF export included, which copies plugin styles into its window.
const PAGE_VAR = {
    margin: '--print-section-margin',
    header: '--print-section-header',
    footer: '--print-section-footer',
    font: '--print-section-font',
};
const SCALE_VAR = '--print-section-scale';
const COVER_VAR = { background: '--print-section-cover-bg', text: '--print-section-cover-fg' };

// Some content keeps rendering after MarkdownRenderer.render resolves —
// diagrams, queries, embeds loaded late. Printing waits until the DOM has been
// still for `quietMs`, and never longer than `settleMaxMs` in all.
const TIMING = { quietMs: 300, settleMaxMs: 5000, imageMaxMs: 4000 };

const MENU_LABEL_MAX = 40;

const PAGE_NUMBERS = {
    none: { name: 'None', css: null },
    number: { name: '3', css: 'counter(page)' },
    'number-total': { name: '3 / 7', css: 'counter(page) " / " counter(pages)' },
    'page-of': { name: 'Page 3 of 7', css: '"Page " counter(page) " of " counter(pages)' },
};

const HEADERS = {
    none: 'None',
    note: 'Note name',
    'note-section': 'Note name › section',
};

const DEFAULT_SETTINGS = {
    includeSubsections: true,
    noteTitle: false,
    lightColors: true,
    backgrounds: true,
    textScale: 100,
    margin: 15,
    header: 'none',
    pageNumbers: 'number-total',
    editorMenu: true,
    fileMenu: true,
};

// ---------------------------------------------------------------------------
// Note structure — pure and line based, so it is testable without Obsidian
// ---------------------------------------------------------------------------

const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RE_SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const RE_FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const RE_FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const RE_LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const RE_HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const RE_QUOTE = /^[ \t]*>/;
const RE_CALLOUT = /^[ \t]*>[ \t]*\[!.+?\]/;

function splitLines(text) {
    return String(text).split(/\r?\n/);
}

// Index of the first line after the front matter, or 0 when there is none.
// An opening `---` with no closing one is not front matter, just a rule.
function bodyStart(lines) {
    if (!lines.length || lines[0].trimEnd() !== '---') return 0;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trimEnd() === '---') return i + 1;
    }
    return 0;
}

function countOf(line, token) {
    let n = 0;
    for (let i = line.indexOf(token); i !== -1; i = line.indexOf(token, i + token.length)) n++;
    return n;
}

// A line that can belong to a paragraph, and so can be turned into a heading
// by a `===` or `---` underline beneath it.
function isParagraphLine(line) {
    const t = line.trim();
    if (!t) return false;
    if (/^(?: {4}|\t)/.test(line)) return false; // indented code, or a list item's continuation
    if (RE_QUOTE.test(line) || t[0] === '<' || t.includes('|')) return false;
    if (RE_LIST_ITEM.test(line) || RE_HR.test(line)) return false;
    return true;
}

function closes(block, line) {
    if (block.kind === 'fence') {
        const m = RE_FENCE_CLOSE.exec(line);
        return !!m && m[1][0] === block.marker[0] && m[1].length >= block.marker.length;
    }
    if (block.kind === 'math') return line.includes('$$');
    return countOf(line, '%%') % 2 === 1;
}

// One pass over the note: its headings, and the fenced code, math and comment
// blocks whose lines must never be read as headings — a `# comment` in a shell
// script is not a section.
//
// The metadata cache knows the headings too, but only as of the last save,
// and the editor saves two seconds after typing stops. Printing straight
// after an edit would cut the section at a stale offset, so the live text is
// scanned instead.
function scanNote(lines) {
    const start = bodyStart(lines);
    const headings = [];
    const blocks = [];
    let open = null;
    let paragraph = -1; // first line of the paragraph being read, for setext headings

    for (let i = start; i < lines.length; i++) {
        const line = lines[i];

        if (open) {
            if (closes(open, line)) {
                open.end = i;
                open.closed = true;
                open = null;
            }
            continue;
        }

        // Unclosed until proven otherwise: an unterminated fence runs to the
        // end of the note, exactly as it renders.
        const openBlock = (block) => {
            open = Object.assign(block, { start: i, end: lines.length - 1, closed: false });
            blocks.push(open);
            paragraph = -1;
        };
        // An odd number of %% leaves a comment open past the end of the line.
        const opensComment = countOf(line, '%%') % 2 === 1;

        const fence = RE_FENCE_OPEN.exec(line);
        const trimmed = line.trim();
        if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
            openBlock({ kind: 'fence', opener: line, indent: fence[1], marker: fence[2] });
            continue;
        }
        if (trimmed.startsWith('$$') && !trimmed.slice(2).includes('$$')) {
            openBlock({ kind: 'math', opener: '$$', indent: '', marker: '$$' });
            continue;
        }

        const atx = RE_ATX.exec(line);
        if (atx) {
            headings.push({ line: i, endLine: i, level: atx[1].length, text: (atx[2] || '').trim() });
            paragraph = -1;
            // `## Plan %% to do` is still a heading; only what follows is hidden.
            if (opensComment) openBlock({ kind: 'comment', opener: '%%', indent: '', marker: '%%' });
            continue;
        }
        if (opensComment) {
            openBlock({ kind: 'comment', opener: '%%', indent: '', marker: '%%' });
            continue;
        }

        if (paragraph !== -1 && RE_SETEXT.test(line)) {
            headings.push({
                line: paragraph,
                endLine: i,
                level: trimmed[0] === '=' ? 1 : 2,
                text: lines.slice(paragraph, i).map((s) => s.trim()).join(' '),
            });
            paragraph = -1;
            continue;
        }

        if (isParagraphLine(line)) {
            if (paragraph === -1) paragraph = i;
        } else {
            paragraph = -1;
        }
    }

    return { start, headings, blocks };
}

function blockAt(note, line) {
    return note.blocks.find((b) => b.start <= line && line <= b.end) || null;
}

function openerOf(block) {
    return block.kind === 'fence' ? block.opener : block.marker;
}

function closerOf(block) {
    return block.kind === 'fence' ? block.indent + block.marker : block.marker;
}

// The range with blank lines shaved off both ends, or null if nothing is left.
function trimRange(lines, from, to) {
    while (from <= to && !lines[from].trim()) from++;
    while (to >= from && !lines[to].trim()) to--;
    return from <= to ? { from, to } : null;
}

// The heading whose section `line` falls in, or null above the first one.
function headingAbove(note, line) {
    let found = null;
    for (const h of note.headings) {
        if (h.line <= line) found = h;
        else break;
    }
    return found;
}

// The section around `line`: from its heading down to the next heading of the
// same or a higher level — or of any level, without subsections.
//
// Above the first heading it is the text there. If that is empty — the cursor
// sits at the top of a note that opens with a heading, which is where a freshly
// opened note puts it — the whole note is the more useful answer than nothing.
function sectionAt(lines, line, includeSubsections, note) {
    const n = note || scanNote(lines);
    const at = Math.max(line, n.start);
    const heading = headingAbove(n, at);

    if (!heading) {
        const firstHeading = n.headings.length ? n.headings[0].line : lines.length;
        const preamble = trimRange(lines, n.start, firstHeading - 1);
        if (preamble) return Object.assign(preamble, { kind: 'preamble', heading: null });
        return wholeNote(lines, n);
    }

    let end = lines.length - 1;
    const index = n.headings.indexOf(heading);
    for (let k = index + 1; k < n.headings.length; k++) {
        const next = n.headings[k];
        if (!includeSubsections || next.level <= heading.level) {
            end = next.line - 1;
            break;
        }
    }
    const range = trimRange(lines, heading.line, end);
    return Object.assign(range, { kind: 'section', heading });
}

function wholeNote(lines, note) {
    const n = note || scanNote(lines);
    const range = trimRange(lines, n.start, lines.length - 1);
    return range ? Object.assign(range, { kind: 'note', heading: null }) : null;
}

// The rows a fragment cut from the middle of a table needs in front of it to
// still be a table: the header row, and the delimiter row under it unless the
// fragment already starts there.
function tableLead(lines, line) {
    for (let k = line; k >= 1; k--) {
        const row = lines[k];
        if (!row.trim() || !row.includes('|')) return [];
        if (RE_TABLE_DELIM.test(row) && lines[k - 1].trim() && lines[k - 1].includes('|')) {
            return k === line ? [lines[k - 1]] : [lines[k - 1], row];
        }
    }
    return [];
}

// A fragment from inside a callout keeps the `> [!type] Title` line that
// makes it a callout rather than a plain quote.
function calloutLead(lines, line) {
    if (!RE_QUOTE.test(lines[line])) return [];
    let k = line;
    while (k > 0 && RE_QUOTE.test(lines[k - 1])) k--;
    return k < line && RE_CALLOUT.test(lines[k]) ? [lines[k]] : [];
}

// Strips the leading whitespace every non-blank line shares. Items cut from a
// nested list arrive indented, and four spaces or a tab at the top of a
// document make an indented code block rather than a list.
function dedent(lines) {
    let prefix = null;
    for (const line of lines) {
        if (!line.trim()) continue;
        const ws = /^[ \t]*/.exec(line)[0];
        if (prefix === null) {
            prefix = ws;
        } else {
            let n = 0;
            while (n < prefix.length && n < ws.length && prefix[n] === ws[n]) n++;
            prefix = prefix.slice(0, n);
        }
        if (!prefix) return lines;
    }
    if (!prefix) return lines;
    return lines.map((line) => (line.trim() ? line.slice(prefix.length) : ''));
}

// Whole lines `from`..`to` as Markdown that renders on its own. A run cut
// from the middle of a code block, a table or a callout gets back the
// opening line it needs, a block left open at the end is closed, and shared
// indentation is removed.
function linesMarkdown(lines, from, to, note) {
    const n = note || scanNote(lines);
    from = Math.max(from, n.start); // the front matter never prints as text
    to = Math.min(to, lines.length - 1);
    if (from > to) return '';

    // A fence line alone at either end of the run has nothing to fence.
    const head = blockAt(n, from);
    if (head && head.closed && from === head.end && from < to) from++;
    const tail = blockAt(n, to);
    if (tail && to === tail.start && to > from) to--;

    const range = trimRange(lines, from, to);
    if (!range) return '';
    ({ from, to } = range);

    const before = [];
    const after = [];
    const first = blockAt(n, from);
    if (first) {
        if (from > first.start) before.push(openerOf(first));
    } else {
        before.push(...tableLead(lines, from), ...calloutLead(lines, from));
    }
    const last = blockAt(n, to);
    if (last && (to < last.end || !last.closed)) after.push(closerOf(last));

    return dedent(before.concat(lines.slice(from, to + 1), after)).join('\n');
}

// The editor selection as Markdown. Within one line it is exact — a phrase is
// a phrase — and a phrase lifted from a code block prints as code rather than
// being read as Markdown. Across lines it widens to whole lines: a selection
// that starts halfway through `**bold**` or a link would otherwise render as
// stray punctuation.
function selectionMarkdown(lines, from, to, note) {
    const n = note || scanNote(lines);
    if (from.line === to.line) {
        const text = (lines[from.line] || '').slice(from.ch, to.ch);
        if (!text.trim()) return '';
        const block = blockAt(n, from.line);
        if (block && from.line > block.start && !(block.closed && from.line === block.end)) {
            return [openerOf(block).trimStart(), text, closerOf(block).trimStart()].join('\n');
        }
        return text;
    }
    // A selection dragged to the very start of a line has not chosen that line.
    const last = to.ch === 0 ? to.line - 1 : to.line;
    return linesMarkdown(lines, from.line, last, n);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// A heading as readable text, for menus, the page header and the print job's
// name: markup removed, links reduced to the words they show.
function plainText(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, '')
        .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
        .replace(/!?\[\[([^\]]*)\]\]/g, (m, target) => target.replace(/#\^?/g, ' › '))
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|__|==|~~|`/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

// The print job's name doubles as the suggested file name when printing to
// PDF, so it loses the characters no file name may hold.
function fileSafe(name) {
    return String(name).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// A value as a CSS string token, for `content:` in a page margin box.
function cssString(text) {
    const flat = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ');
    return '"' + flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function menuLabel(target) {
    if (target.kind === 'selection') return 'Print selection';
    if (target.kind === 'preamble') return 'Print text above the first heading';
    if (target.kind === 'note') return 'Print note';
    const name = target.heading ? plainText(target.heading.text) : '';
    return name ? `Print section “${truncate(name, MENU_LABEL_MAX)}”` : 'Print section';
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// ---------------------------------------------------------------------------
// Waiting for the render to finish
// ---------------------------------------------------------------------------

function wait(win, ms) {
    return new Promise((resolve) => win.setTimeout(resolve, ms));
}

// One painted frame — but a hidden window may never paint, so not for long.
function frame(win) {
    return new Promise((resolve) => {
        const done = () => resolve();
        if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(done);
        win.setTimeout(done, 100);
    });
}

function imagesLoaded(el, win, maxMs) {
    const pending = [];
    for (const img of Array.from(el.querySelectorAll('img'))) {
        // The printout sits off-screen while it renders, where a lazy image
        // would never start loading.
        if (img.loading === 'lazy') img.loading = 'eager';
        if (img.complete) continue;
        pending.push(new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
        }));
    }
    if (!pending.length) return Promise.resolve();
    return Promise.race([Promise.all(pending), wait(win, maxMs)]);
}

// Resolves once `el` has gone `quietMs` without a DOM change, or after `maxMs`.
function stillFor(el, win, quietMs, maxMs) {
    return new Promise((resolve) => {
        let quiet = 0;
        let cap = 0;
        let observer = null;
        const done = () => {
            if (observer) observer.disconnect();
            win.clearTimeout(quiet);
            win.clearTimeout(cap);
            resolve();
        };
        if (typeof win.MutationObserver === 'function') {
            observer = new win.MutationObserver(() => {
                win.clearTimeout(quiet);
                quiet = win.setTimeout(done, quietMs);
            });
            observer.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
        }
        quiet = win.setTimeout(done, quietMs);
        cap = win.setTimeout(done, maxMs);
    });
}

async function settle(el, win, timing) {
    const deadline = Date.now() + timing.settleMaxMs;
    const left = () => Math.max(0, deadline - Date.now());
    await imagesLoaded(el, win, Math.min(timing.imageMaxMs, left()));
    await stillFor(el, win, timing.quietMs, left());
    await imagesLoaded(el, win, left()); // any that arrived with a late embed
    const fonts = win.document && win.document.fonts;
    if (fonts && fonts.ready) await Promise.race([fonts.ready, wait(win, 1000)]);
    await frame(win);
    await frame(win);
}

// ---------------------------------------------------------------------------
// One printout
// ---------------------------------------------------------------------------

// Everything a print changes is recorded as an undo step the moment it is
// made, and cleanup() replays them newest first. Cleanup is idempotent and
// reachable four ways — afterprint, a click on the cover, a new print, and
// unloading the plugin — because a window left in the light theme or behind
// a cover with no way back is the one failure that must not happen.
class PrintJob {
    constructor(plugin, request) {
        this.plugin = plugin;
        this.request = request;
        this.doc = request.doc;
        this.win = this.doc.defaultView;
        this.timing = plugin.timing || TIMING;
        this.undo = [];
        this.finished = false;
        this.component = null;
        this.root = null;
        this.cleanup = this.cleanup.bind(this);
    }

    async run() {
        const { settings } = this.plugin;
        this.showCover();
        // Before rendering, not just before printing: diagrams bake the
        // theme's colours in as they draw.
        if (settings.lightColors) this.useLightTheme();
        const content = this.mount();

        if (this.request.fragment) {
            content.appendChild(this.request.fragment);
        } else {
            this.component = new Component();
            this.component.load();
            await MarkdownRenderer.render(
                this.plugin.app, this.request.markdown, content, this.request.sourcePath, this.component);
        }
        await settle(content, this.win, this.timing);
        if (this.finished) return false; // cancelled while rendering

        this.setUpPage(content);
        this.retitle();
        this.win.addEventListener('afterprint', this.cleanup);
        this.undo.push(() => this.win.removeEventListener('afterprint', this.cleanup));
        this.win.print();
        return true;
    }

    // Covers the window while the printout renders and the dialog is open.
    // With light colours on, the whole app switches to the light theme for
    // the duration; the cover keeps that from flashing across the screen,
    // so it is pinned to the colours the window has *before* the switch.
    showCover() {
        const { doc, win } = this;
        const current = win.getComputedStyle(doc.body);
        const cover = doc.body.createDiv({ cls: COVER_CLASS });
        this.undo.push(() => cover.remove());
        const background = current.getPropertyValue('--background-primary').trim() || current.backgroundColor;
        const text = current.getPropertyValue('--text-normal').trim() || current.color;
        if (background) cover.style.setProperty(COVER_VAR.background, background);
        if (text) cover.style.setProperty(COVER_VAR.text, text);
        cover.createDiv({ cls: 'print-section-cover-label', text: 'Preparing to print…' });
        cover.createDiv({ cls: 'print-section-cover-hint', text: 'Click to return to your note' });
        cover.addEventListener('click', this.cleanup);
    }

    // Export to PDF does exactly this in its own window. Obsidian declares
    // its colours on <body> from base colours set by .theme-light and
    // .theme-dark, so only the class on <body> itself can switch them.
    useLightTheme() {
        const { body } = this.doc;
        if (!body.hasClass('theme-dark')) return;
        body.removeClass('theme-dark');
        body.addClass('theme-light');
        this.undo.push(() => {
            body.removeClass('theme-light');
            body.addClass('theme-dark');
        });
    }

    mount() {
        const { doc, request } = this;
        const { settings } = this.plugin;
        const root = doc.body.createDiv({ cls: ['print', ROOT_CLASS] });
        this.undo.push(() => root.remove());
        if (!settings.backgrounds) root.addClass(ECONOMY_CLASS);

        const content = root.createDiv({ cls: ['markdown-preview-view', 'markdown-rendered', CONTENT_CLASS] });
        // The note's own `cssclasses`, so CSS written for this kind of note
        // styles its printout too.
        for (const cls of request.cssClasses || []) content.addClass(cls);
        if (settings.textScale !== 100) content.style.setProperty(SCALE_VAR, String(settings.textScale / 100));
        if (settings.noteTitle && request.noteName) {
            content.createEl('h1', { cls: TITLE_CLASS, text: request.noteName });
        }
        this.root = root;
        return content;
    }

    setUpPage(content) {
        const { doc, win, request } = this;
        const { settings } = this.plugin;
        const html = doc.documentElement;
        const set = (name, value) => {
            if (value === null || value === undefined || value === '') return;
            html.style.setProperty(name, value);
            this.undo.push(() => html.style.removeProperty(name));
        };
        set(PAGE_VAR.margin, `${settings.margin}mm`);
        set(PAGE_VAR.header, request.header ? cssString(request.header) : null);
        set(PAGE_VAR.footer, (PAGE_NUMBERS[settings.pageNumbers] || PAGE_NUMBERS.none).css);
        // A margin box cannot see the variables on <body>, so the note's font
        // is handed over by value.
        set(PAGE_VAR.font, win.getComputedStyle(content).fontFamily || null);
    }

    // The print queue shows the document's title, and Print to PDF offers it
    // as the file name.
    retitle() {
        const { doc, request } = this;
        if (!request.title) return;
        const previous = doc.title;
        doc.title = request.title;
        this.undo.push(() => {
            if (doc.title === request.title) doc.title = previous;
        });
    }

    cleanup() {
        if (this.finished) return;
        this.finished = true;
        while (this.undo.length) {
            const step = this.undo.pop();
            try {
                step();
            } catch (error) {
                console.error('Print Section: could not undo a print step', error);
            }
        }
        if (this.component) {
            this.component.unload();
            this.component = null;
        }
        if (this.plugin.activeJob === this) this.plugin.activeJob = null;
    }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = class PrintSectionPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        this.activeJob = null;

        // Reading view hands each block it renders to the post-processors,
        // with a context that can say — at any later moment, edits included —
        // which lines of the note that block came from. Keeping the context
        // is what lets a Reading-view selection be traced back to the text.
        this.blockContexts = new WeakMap();
        this.registerMarkdownPostProcessor((el, ctx) => {
            this.blockContexts.set(el, ctx);
        });

        this.addRibbonIcon('printer', 'Print selection or section', () => this.printActive());

        this.addCommand({
            id: 'print-selection-or-section',
            name: 'Print selection or current section',
            icon: 'printer',
            checkCallback: (checking) => this.withActiveView(checking, (view) => this.printFromView(view)),
        });
        this.addCommand({
            id: 'print-note',
            name: 'Print note',
            icon: 'printer',
            checkCallback: (checking) => this.withActiveView(checking, (view) => this.printNoteOf(view)),
        });

        this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => this.onEditorMenu(menu, editor, info)));
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.onFileMenu(menu, file)));

        this.addSettingTab(new PrintSectionSettingTab(this.app, this));
    }

    onunload() {
        if (this.activeJob) this.activeJob.cleanup();
    }

    async loadSettings() {
        const saved = (await this.loadData()) || {};
        const s = Object.assign({}, DEFAULT_SETTINGS, saved);
        if (!Object.prototype.hasOwnProperty.call(PAGE_NUMBERS, s.pageNumbers)) s.pageNumbers = DEFAULT_SETTINGS.pageNumbers;
        if (!Object.prototype.hasOwnProperty.call(HEADERS, s.header)) s.header = DEFAULT_SETTINGS.header;
        s.margin = clampNumber(s.margin, 0, 50, DEFAULT_SETTINGS.margin);
        s.textScale = clampNumber(s.textScale, 50, 200, DEFAULT_SETTINGS.textScale);
        this.settings = s;
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // --- Entry points --------------------------------------------------------

    withActiveView(checking, action) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return false;
        if (!checking) action(view);
        return true;
    }

    printActive() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) {
            new Notice('Open a note to print from it.');
            return Promise.resolve(false);
        }
        return this.printFromView(view);
    }

    printFromView(view) {
        const target = view.getMode() === 'preview' ? this.readingTarget(view) : this.editorTarget(view.editor);
        return this.print(this.requestFor(view.file, target, view.containerEl.ownerDocument));
    }

    printNoteOf(view) {
        const text = view.getMode() === 'preview' ? view.getViewData() : view.editor.getValue();
        return this.print(this.requestFor(view.file, noteTarget(text), view.containerEl.ownerDocument));
    }

    async printFile(file) {
        // An open note may hold edits not yet saved; prefer what is on screen.
        const view = this.app.workspace.getLeavesOfType('markdown')
            .map((leaf) => leaf.view)
            .find((v) => v instanceof MarkdownView && v.file === file);
        if (view) return this.printNoteOf(view);
        const text = await this.app.vault.cachedRead(file);
        const doc = typeof activeDocument !== 'undefined' ? activeDocument : document;
        return this.print(this.requestFor(file, noteTarget(text), doc));
    }

    // --- What to print ---------------------------------------------------------

    editorTarget(editor) {
        const lines = splitLines(editor.getValue());
        const note = scanNote(lines);
        if (editor.somethingSelected()) {
            const from = editor.getCursor('from');
            const to = editor.getCursor('to');
            return {
                kind: 'selection',
                heading: headingAbove(note, from.line),
                markdown: selectionMarkdown(lines, from, to, note),
            };
        }
        return this.sectionTarget(lines, note, editor.getCursor().line);
    }

    // Reading view has no cursor and no character positions. A selection
    // there is traced back to the blocks it touches and printed whole; with
    // no selection, the section at the top of the window is the one in view.
    readingTarget(view) {
        const lines = splitLines(view.getViewData());
        const note = scanNote(lines);
        const picked = this.readingSelection(view, lines.length);
        if (picked && picked.lines) {
            return {
                kind: 'selection',
                heading: headingAbove(note, picked.lines.from),
                markdown: linesMarkdown(lines, picked.lines.from, picked.lines.to, note),
            };
        }
        if (picked && picked.fragment) {
            return { kind: 'selection', heading: null, markdown: null, fragment: picked.fragment };
        }
        const top = view.currentMode.getScroll();
        const line = typeof top === 'number' && Number.isFinite(top) ? Math.ceil(top) : 0;
        return this.sectionTarget(lines, note, line);
    }

    sectionTarget(lines, note, line) {
        const section = sectionAt(lines, line, this.settings.includeSubsections, note);
        if (!section) return null;
        return {
            kind: section.kind,
            heading: section.heading,
            markdown: linesMarkdown(lines, section.from, section.to, note),
        };
    }

    // The lines a Reading-view selection covers. If its blocks cannot be
    // traced — the view rendered before this plugin loaded, so no contexts
    // were kept — the selection is copied as it is displayed instead.
    readingSelection(view, lineCount) {
        const container = view.previewMode && view.previewMode.containerEl;
        if (!container) return null;
        const selection = container.ownerDocument.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
        const range = selection.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)) return null;

        const first = this.blockLines(range.startContainer, container);
        const last = this.blockLines(range.endContainer, container);
        if (first || last) {
            // An end outside every block lies in the title or properties above
            // the text, or past its end.
            return {
                lines: {
                    from: first ? first.lineStart : 0,
                    to: last ? last.lineEnd : lineCount - 1,
                },
            };
        }
        return { fragment: range.cloneContents() };
    }

    blockLines(node, stop) {
        let el = node && node.nodeType === 1 ? node : node && node.parentElement;
        for (; el && el !== stop; el = el.parentElement) {
            const ctx = this.blockContexts.get(el);
            const info = ctx && ctx.getSectionInfo(el);
            if (info) return info;
        }
        return null;
    }

    // --- Printing --------------------------------------------------------------

    requestFor(file, target, doc) {
        const noteName = file.basename;
        const section = target && target.heading ? plainText(target.heading.text) : '';
        let header = '';
        if (this.settings.header === 'note') header = noteName;
        if (this.settings.header === 'note-section') header = section ? `${noteName} › ${section}` : noteName;
        let title = noteName;
        if (target && target.kind === 'section' && section) title = `${noteName} - ${section}`;
        if (target && target.kind === 'selection') title = section ? `${noteName} - ${section} (selection)` : `${noteName} (selection)`;
        return {
            markdown: target ? target.markdown : '',
            fragment: target ? target.fragment || null : null,
            sourcePath: file.path,
            title: fileSafe(title),
            header,
            noteName,
            cssClasses: this.cssClassesOf(file),
            doc,
        };
    }

    cssClassesOf(file) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache && cache.frontmatter;
        if (!fm) return [];
        const raw = fm.cssclasses !== undefined ? fm.cssclasses : fm.cssclass;
        const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
        // Any token a class list will accept; one with a space inside would throw.
        return list.map((c) => String(c).trim()).filter((c) => c && !/\s/.test(c));
    }

    async print(request) {
        if (this.activeJob) this.activeJob.cleanup();
        const empty = request.fragment
            ? !request.fragment.textContent.trim() && !request.fragment.querySelector('img, svg, canvas')
            : !request.markdown || !request.markdown.trim();
        if (empty) {
            new Notice('Nothing to print here.');
            return false;
        }
        const job = new PrintJob(this, request);
        this.activeJob = job;
        try {
            return await job.run();
        } catch (error) {
            job.cleanup();
            console.error('Print Section:', error);
            new Notice(`Could not print: ${error && error.message ? error.message : error}`);
            return false;
        }
    }

    // --- Menus -------------------------------------------------------------------

    onEditorMenu(menu, editor, info) {
        if (!this.settings.editorMenu || !(info instanceof MarkdownView) || !info.file) return;
        const target = this.editorTarget(editor);
        if (!target) return;
        menu.addItem((item) => item
            .setTitle(menuLabel(target))
            .setIcon('printer')
            .setSection('action')
            .onClick(() => this.print(this.requestFor(info.file, target, info.containerEl.ownerDocument))));
    }

    onFileMenu(menu, file) {
        if (!this.settings.fileMenu || !(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem((item) => item
            .setTitle('Print note')
            .setIcon('printer')
            .setSection('action')
            .onClick(() => this.printFile(file)));
    }
};

function noteTarget(text) {
    const lines = splitLines(text);
    const note = scanNote(lines);
    const range = wholeNote(lines, note);
    return {
        kind: 'note',
        heading: null,
        markdown: range ? linesMarkdown(lines, range.from, range.to, note) : '',
    };
}

module.exports.__internals = {
    splitLines, bodyStart, scanNote, headingAbove, sectionAt, wholeNote, trimRange,
    tableLead, calloutLead, dedent, linesMarkdown, selectionMarkdown, noteTarget,
    plainText, truncate, fileSafe, cssString, menuLabel, clampNumber,
    settle, stillFor, imagesLoaded, PrintJob,
    DEFAULT_SETTINGS, PAGE_NUMBERS, HEADERS, TIMING,
    ROOT_CLASS, CONTENT_CLASS, TITLE_CLASS, ECONOMY_CLASS, COVER_CLASS, PAGE_VAR, SCALE_VAR, COVER_VAR,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

class PrintSectionSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        const { settings } = this.plugin;
        const save = () => this.plugin.saveSettings();
        containerEl.empty();

        new Setting(containerEl)
            .setName('Include subsections')
            .setDesc('Printing the section under the cursor carries on through its deeper headings. Off, it stops at the next heading of any level.')
            .addToggle((t) => t
                .setValue(settings.includeSubsections)
                .onChange((v) => { settings.includeSubsections = v; save(); }));

        new Setting(containerEl)
            .setName('Note name as title')
            .setDesc('Start the printout with the note’s name as a heading, as Export to PDF does.')
            .addToggle((t) => t
                .setValue(settings.noteTitle)
                .onChange((v) => { settings.noteTitle = v; save(); }));

        new Setting(containerEl).setName('Page').setHeading();

        new Setting(containerEl)
            .setName('Light colours')
            .setDesc('Print in the light theme even while you work in a dark one, so the page is not filled with ink. Off prints the theme on screen.')
            .addToggle((t) => t
                .setValue(settings.lightColors)
                .onChange((v) => { settings.lightColors = v; save(); }));

        new Setting(containerEl)
            .setName('Background colours')
            .setDesc('Print the shading of callouts, highlights, code blocks and tables. Off lets the printer leave backgrounds out to save ink.')
            .addToggle((t) => t
                .setValue(settings.backgrounds)
                .onChange((v) => { settings.backgrounds = v; save(); }));

        new Setting(containerEl)
            .setName('Text size')
            .setDesc('Percent of the editor’s text size.')
            .addSlider((s) => s
                .setLimits(60, 140, 5)
                .setValue(settings.textScale)
                .setDynamicTooltip()
                .onChange((v) => { settings.textScale = v; save(); }));

        new Setting(containerEl)
            .setName('Margins')
            .setDesc('Millimetres on every side. The header and page numbers sit inside this margin, so leave room for them.')
            .addSlider((s) => s
                .setLimits(5, 40, 1)
                .setValue(settings.margin)
                .setDynamicTooltip()
                .onChange((v) => { settings.margin = v; save(); }));

        new Setting(containerEl)
            .setName('Header')
            .setDesc('Printed at the top of every page.')
            .addDropdown((d) => d
                .addOptions(HEADERS)
                .setValue(settings.header)
                .onChange((v) => { settings.header = v; save(); }));

        const pageNumberNames = {};
        for (const [key, format] of Object.entries(PAGE_NUMBERS)) pageNumberNames[key] = format.name;
        new Setting(containerEl)
            .setName('Page numbers')
            .setDesc('Printed at the foot of every page.')
            .addDropdown((d) => d
                .addOptions(pageNumberNames)
                .setValue(settings.pageNumbers)
                .onChange((v) => { settings.pageNumbers = v; save(); }));

        new Setting(containerEl).setName('Menus').setHeading();

        new Setting(containerEl)
            .setName('Editor menu')
            .setDesc('Add “Print selection” or “Print section” to the editor’s right-click menu, named for what it will print.')
            .addToggle((t) => t
                .setValue(settings.editorMenu)
                .onChange((v) => { settings.editorMenu = v; save(); }));

        new Setting(containerEl)
            .setName('File menu')
            .setDesc('Add “Print note” to the file menu, in the file explorer and the note’s ⋯ menu.')
            .addToggle((t) => t
                .setValue(settings.fileMenu)
                .onChange((v) => { settings.fileMenu = v; save(); }));
    }
}
