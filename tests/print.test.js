'use strict';

// Drives whole printouts against a fake window: what is built, what reaches
// window.print(), and — the part that matters most — that every change is
// undone afterwards, however the printout ends.
// Run with: node --test "tests/*.test.js"

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'obsidian') return path.join(__dirname, 'mocks', 'obsidian.js');
    return origResolve.call(this, request, ...rest);
};

const PrintSectionPlugin = require('../main.js');
const { PAGE_VAR, SCALE_VAR, ROOT_CLASS, CONTENT_CLASS, COVER_CLASS, ECONOMY_CLASS, TITLE_CLASS, DEFAULT_SETTINGS } =
    PrintSectionPlugin.__internals;
const obsidian = require('./mocks/obsidian.js');
const { MarkdownRenderer, MarkdownView, TFile, Menu, Setting } = obsidian;
const { FakeEl, fragment, makeWindow } = require('./mocks/dom.js');

const FAST = { quietMs: 5, settleMaxMs: 60, imageMaxMs: 20 };

const NOTE = [
    '---',               // 0
    'cssclasses: [x]',   // 1
    '---',               // 2
    '# Chapter',         // 3
    'Chapter text.',     // 4
    '## Part A',         // 5
    'A text.',           // 6
    '## Part B',         // 7
    'B text.',           // 8
].join('\n');

class MockEditor {
    constructor(text, from, to) {
        this.text = text;
        this.from = from;
        this.to = to || from;
    }
    getValue() { return this.text; }
    somethingSelected() { return this.from.line !== this.to.line || this.from.ch !== this.to.ch; }
    getCursor(side) { return side === 'to' ? this.to : this.from; }
}

function makeView(doc, opts) {
    const o = Object.assign({ mode: 'source', text: NOTE, cursor: { line: 6, ch: 0 }, scroll: 0 }, opts);
    const view = Object.create(MarkdownView.prototype);
    view.file = o.file || new TFile('Folder/My Note.md');
    view.editor = new MockEditor(o.text, o.cursor, o.to);
    view.containerEl = new FakeEl('div', doc);
    const preview = new FakeEl('div', doc);
    view.previewMode = { containerEl: preview, getScroll: () => o.scroll };
    view.currentMode = view.previewMode;
    view.getMode = () => o.mode;
    view.getViewData = () => o.text;
    return view;
}

function makeApp(state) {
    return {
        workspace: {
            activeView: null,
            getActiveViewOfType(cls) { return this.activeView instanceof cls ? this.activeView : null; },
            getLeavesOfType() { return (state.openViews || []).map((view) => ({ view })); },
            on(name, fn) { return { name, fn }; },
        },
        metadataCache: {
            getFileCache: (file) => (state.caches || {})[file.path] || null,
        },
        vault: {
            cachedRead: async (file) => (state.files || {})[file.path],
        },
    };
}

async function setup(options) {
    const opts = options || {};
    const { win, doc } = makeWindow(opts.window);
    global.activeDocument = doc;
    const state = { caches: opts.caches, files: opts.files, openViews: opts.openViews };
    const app = makeApp(state);
    const plugin = new PrintSectionPlugin(app, { id: 'print-section' });
    plugin.stored = opts.stored || {};
    await plugin.onload();
    plugin.timing = FAST;
    return { plugin, win, doc, app, state };
}

function handler(plugin, name) {
    return plugin.events.find((e) => e.name === name).fn;
}

function rootOf(doc) {
    return doc.body.children.find((c) => c.hasClass(ROOT_CLASS)) || null;
}

beforeEach(() => {
    MarkdownRenderer.calls.length = 0;
    MarkdownRenderer.impl = null;
    obsidian.__notices.length = 0;
});

// --- A printout, start to finish -------------------------------------------

test('a printout is built the way Export to PDF builds one', async () => {
    const { plugin, win, doc } = await setup({ caches: { 'Folder/My Note.md': { frontmatter: { cssclasses: ['teaching-reference'] } } } });
    let root = null;
    MarkdownRenderer.impl = async (app, md, el) => {
        root = rootOf(doc);
        el.createEl('p', { text: md });
    };
    const view = makeView(doc);

    assert.equal(await plugin.printFromView(view), true);
    assert.equal(win.printed, 1);

    const call = MarkdownRenderer.calls[0];
    assert.equal(call.markdown, '## Part A\nA text.');
    assert.equal(call.sourcePath, 'Folder/My Note.md');
    assert.equal(call.componentLoaded, true, 'rendered with a live component');

    assert.ok(root.hasClass('print'), 'Obsidian’s print CSS only shows body > .print');
    assert.equal(root.parentElement, null, 'and it is gone again');
    const content = call.el;
    assert.ok(['markdown-preview-view', 'markdown-rendered', CONTENT_CLASS, 'teaching-reference'].every((c) => content.hasClass(c)));
});

test('cssclasses are taken as a list or a string, and only as usable class names', async () => {
    const file = new TFile('n.md');
    let s = await setup({ caches: { 'n.md': { frontmatter: { cssclasses: ['référence', 'two words', '', 'wide'] } } } });
    assert.deepEqual(s.plugin.cssClassesOf(file), ['référence', 'wide']);
    s = await setup({ caches: { 'n.md': { frontmatter: { cssclass: 'a, b c' } } } });
    assert.deepEqual(s.plugin.cssClassesOf(file), ['a', 'b', 'c']);
    s = await setup();
    assert.deepEqual(s.plugin.cssClassesOf(file), []);
});

test('at the moment of printing: light theme, page set up, a titled job', async () => {
    const { plugin, win, doc } = await setup({ stored: { header: 'note-section', pageNumbers: 'page-of', margin: 20 } });
    await plugin.printFromView(makeView(doc));

    const s = win.atPrint;
    assert.ok(s.bodyClasses.includes('theme-light') && !s.bodyClasses.includes('theme-dark'));
    assert.deepEqual(s.bodyChildren, ['app-container', COVER_CLASS, `print ${ROOT_CLASS}`]);
    assert.equal(s.htmlVars[PAGE_VAR.margin], '20mm');
    assert.equal(s.htmlVars[PAGE_VAR.header], '"My Note › Part A"');
    assert.equal(s.htmlVars[PAGE_VAR.footer], '"Page " counter(page) " of " counter(pages)');
    assert.equal(s.htmlVars[PAGE_VAR.font], '"Inter", sans-serif');
    assert.equal(s.title, 'My Note - Part A');
});

test('afterwards everything is as it was', async () => {
    const { plugin, doc } = await setup({ stored: { header: 'note' } });
    const before = { classes: [...doc.body.classes], title: doc.title, children: doc.body.children.length };
    await plugin.printFromView(makeView(doc));

    assert.deepEqual([...doc.body.classes], before.classes);
    assert.equal(doc.title, before.title);
    assert.equal(doc.body.children.length, before.children);
    assert.deepEqual(doc.documentElement.style.props, {});
    assert.equal(MarkdownRenderer.calls[0].component.loaded, false, 'component unloaded');
    assert.equal(plugin.activeJob, null);
});

test('when the dialog does not block, the printout waits for afterprint', async () => {
    const { plugin, win, doc } = await setup({ window: { printFiresAfterprint: false } });
    await plugin.printFromView(makeView(doc));
    assert.ok(rootOf(doc), 'still there while the dialog is open');
    assert.ok(doc.body.hasClass('theme-light'));

    win.fire('afterprint');
    assert.equal(rootOf(doc), null);
    assert.ok(doc.body.hasClass('theme-dark'));
    assert.equal(win.listeners.afterprint.length, 0, 'listener removed');
});

test('clicking the cover puts the window back', async () => {
    const { plugin, win, doc } = await setup({ window: { printFiresAfterprint: false } });
    await plugin.printFromView(makeView(doc));
    const cover = doc.body.children.find((c) => c.hasClass(COVER_CLASS));
    assert.equal(cover.style.props['--print-section-cover-bg'], '#1e1e1e', 'pinned to the dark colours');
    cover.fire('click');
    assert.equal(rootOf(doc), null);
    assert.ok(doc.body.hasClass('theme-dark'));
    win.fire('afterprint'); // late, and harmless
    assert.ok(doc.body.hasClass('theme-dark'));
});

test('a light theme is left alone, and so is the theme with light colours off', async () => {
    let s = await setup({ window: { theme: 'light' } });
    await s.plugin.printFromView(makeView(s.doc));
    assert.deepEqual(s.win.atPrint.bodyClasses, ['theme-light']);
    assert.deepEqual([...s.doc.body.classes], ['theme-light']);

    s = await setup({ stored: { lightColors: false } });
    await s.plugin.printFromView(makeView(s.doc));
    assert.deepEqual(s.win.atPrint.bodyClasses, ['theme-dark']);
});

test('settings reach the printout: title, text size, ink saving, no page furniture', async () => {
    const { plugin, win, doc } = await setup({ stored: { noteTitle: true, textScale: 85, backgrounds: false, pageNumbers: 'none' } });
    let root = null;
    MarkdownRenderer.impl = async (app, md, el) => { root = rootOf(doc); el.createEl('p', { text: md }); };
    await plugin.printFromView(makeView(doc));

    const content = MarkdownRenderer.calls[0].el;
    assert.equal(content.children[0].tag, 'h1');
    assert.ok(content.children[0].hasClass(TITLE_CLASS));
    assert.equal(content.children[0].text, 'My Note');
    assert.equal(content.style.props[SCALE_VAR], '0.85');
    assert.ok(root.hasClass(ECONOMY_CLASS));
    assert.equal(win.atPrint.htmlVars[PAGE_VAR.footer], undefined);
    assert.equal(win.atPrint.htmlVars[PAGE_VAR.header], undefined);
});

test('a print started while one is rendering replaces it', async () => {
    const { plugin, win, doc } = await setup();
    let release;
    MarkdownRenderer.impl = () => new Promise((resolve) => { release = resolve; });
    const first = plugin.printFromView(makeView(doc));
    await new Promise((r) => setTimeout(r, 0));
    const firstRoot = rootOf(doc);

    MarkdownRenderer.impl = null;
    const second = plugin.printFromView(makeView(doc, { cursor: { line: 8, ch: 0 } }));
    assert.equal(firstRoot.parentElement, null, 'first printout torn down at once');
    release();
    assert.equal(await first, false, 'and it never reaches the printer');
    assert.equal(await second, true);
    assert.equal(win.printed, 1);
    assert.equal(MarkdownRenderer.calls[1].markdown, '## Part B\nB text.');
});

test('a render that fails leaves nothing behind and says so', async () => {
    const { plugin, win, doc } = await setup();
    MarkdownRenderer.impl = async () => { throw new Error('boom'); };
    assert.equal(await plugin.printFromView(makeView(doc)), false);
    assert.equal(win.printed, 0);
    assert.equal(rootOf(doc), null);
    assert.ok(doc.body.hasClass('theme-dark'));
    assert.match(obsidian.__notices.at(-1), /Could not print: boom/);
});

test('unloading the plugin mid-print puts the window back', async () => {
    const { plugin, doc } = await setup({ window: { printFiresAfterprint: false } });
    await plugin.printFromView(makeView(doc));
    plugin.onunload();
    assert.equal(rootOf(doc), null);
    assert.ok(doc.body.hasClass('theme-dark'));
});

test('nothing to print is said, not printed', async () => {
    const { plugin, win, doc } = await setup();
    await plugin.printFromView(makeView(doc, { text: '---\na: 1\n---\n\n', cursor: { line: 4, ch: 0 } }));
    assert.equal(win.printed, 0);
    assert.equal(obsidian.__notices.at(-1), 'Nothing to print here.');
});

test('images are waited for, and lazy ones made to load', async () => {
    const { plugin, win, doc } = await setup();
    let img;
    MarkdownRenderer.impl = async (app, md, el) => {
        img = el.createEl('img');
        img.loading = 'lazy';
        img.complete = false;
        setTimeout(() => { img.complete = true; img.fire('load'); }, 10);
    };
    await plugin.printFromView(makeView(doc));
    assert.equal(img.loading, 'eager');
    assert.equal(win.printed, 1);
});

// --- What gets printed -------------------------------------------------------

test('the editor selection, widened to whole lines', async () => {
    const { plugin, doc } = await setup();
    await plugin.printFromView(makeView(doc, { cursor: { line: 4, ch: 3 }, to: { line: 6, ch: 2 } }));
    assert.equal(MarkdownRenderer.calls[0].markdown, 'Chapter text.\n## Part A\nA text.');
});

test('a selection is titled after the section it starts in', async () => {
    const { plugin, win, doc } = await setup({ stored: { header: 'note-section' } });
    await plugin.printFromView(makeView(doc, { cursor: { line: 6, ch: 0 }, to: { line: 6, ch: 6 } }));
    assert.equal(MarkdownRenderer.calls[0].markdown, 'A text');
    assert.equal(win.atPrint.title, 'My Note - Part A (selection)');
    assert.equal(win.atPrint.htmlVars[PAGE_VAR.header], '"My Note › Part A"');
});

test('subsections follow the setting', async () => {
    let s = await setup();
    await s.plugin.printFromView(makeView(s.doc, { cursor: { line: 4, ch: 0 } }));
    assert.equal(MarkdownRenderer.calls.at(-1).markdown, '# Chapter\nChapter text.\n## Part A\nA text.\n## Part B\nB text.');

    s = await setup({ stored: { includeSubsections: false } });
    await s.plugin.printFromView(makeView(s.doc, { cursor: { line: 4, ch: 0 } }));
    assert.equal(MarkdownRenderer.calls.at(-1).markdown, '# Chapter\nChapter text.');
});

test('Print note prints the whole note, live text included', async () => {
    const { plugin, doc } = await setup();
    const view = makeView(doc, { text: NOTE + '\nUnsaved line.' });
    await plugin.printNoteOf(view);
    assert.ok(MarkdownRenderer.calls[0].markdown.startsWith('# Chapter'));
    assert.ok(MarkdownRenderer.calls[0].markdown.endsWith('Unsaved line.'));
});

test('Reading view: no selection prints the section at the top of the window', async () => {
    const { plugin, doc } = await setup();
    await plugin.printFromView(makeView(doc, { mode: 'preview', scroll: 6.4 }));
    assert.equal(MarkdownRenderer.calls[0].markdown, '## Part B\nB text.');
});

function readingSelection(doc, view, start, end) {
    const container = view.previewMode.containerEl;
    doc.selection = {
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => ({
            startContainer: start,
            endContainer: end,
            commonAncestorContainer: container,
            cloneContents: () => fragment(doc, 'Exactly what was selected'),
        }),
    };
}

test('Reading view: a selection is traced back to the blocks it touches', async () => {
    const { plugin, doc } = await setup();
    const view = makeView(doc, { mode: 'preview' });
    const container = view.previewMode.containerEl;
    const blockA = container.createDiv();
    const blockB = container.createDiv();
    const process = plugin.postProcessors[0];
    process(blockA, { getSectionInfo: () => ({ lineStart: 4, lineEnd: 4, text: NOTE }) });
    process(blockB, { getSectionInfo: () => ({ lineStart: 6, lineEnd: 6, text: NOTE }) });
    readingSelection(doc, view, { nodeType: 3, parentElement: blockA.createEl('p') }, { nodeType: 3, parentElement: blockB });

    await plugin.printFromView(view);
    assert.equal(MarkdownRenderer.calls[0].markdown, 'Chapter text.\n## Part A\nA text.');
});

test('Reading view: a selection starting inside an embed starts at the block holding it', async () => {
    // The embedded note's blocks are post-processed too, with line numbers
    // that count in the embedded note — line 2 here, which in this note is
    // the end of the front matter.
    const { plugin, doc } = await setup();
    const view = makeView(doc, { mode: 'preview' });
    const container = view.previewMode.containerEl;
    const host = container.createDiv();
    const embedded = host.createDiv();
    const blockB = container.createDiv();
    const process = plugin.postProcessors[0];
    process(host, { getSectionInfo: () => ({ lineStart: 6, lineEnd: 6, text: NOTE }) });
    process(embedded, { getSectionInfo: () => ({ lineStart: 2, lineEnd: 2, text: '# Other\n\nEmbedded text.' }) });
    process(blockB, { getSectionInfo: () => ({ lineStart: 8, lineEnd: 8, text: NOTE }) });
    readingSelection(doc, view, { nodeType: 3, parentElement: embedded.createEl('p') }, { nodeType: 3, parentElement: blockB });

    await plugin.printFromView(view);
    assert.equal(MarkdownRenderer.calls[0].markdown, 'A text.\n## Part B\nB text.');
});

test('Reading view: blocks that cannot be traced print as displayed', async () => {
    const { plugin, doc } = await setup();
    const view = makeView(doc, { mode: 'preview' });
    const container = view.previewMode.containerEl;
    const block = container.createDiv();
    readingSelection(doc, view, { nodeType: 3, parentElement: block }, { nodeType: 3, parentElement: block });

    let printed = null;
    const { win } = { win: doc.defaultView };
    const originalPrint = win.print;
    win.print = () => {
        printed = rootOf(doc).find(CONTENT_CLASS).textContent;
        originalPrint();
    };
    await plugin.printFromView(view);
    assert.equal(MarkdownRenderer.calls.length, 0, 'nothing re-rendered');
    assert.equal(printed, 'Exactly what was selected');
});

test('a selection outside the note is not mistaken for one in it', async () => {
    const { plugin, doc } = await setup();
    const view = makeView(doc, { mode: 'preview', scroll: 3 });
    const elsewhere = new FakeEl('div', doc);
    doc.selection = {
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: elsewhere, endContainer: elsewhere, commonAncestorContainer: elsewhere }),
    };
    await plugin.printFromView(view);
    assert.equal(MarkdownRenderer.calls[0].markdown, '# Chapter\nChapter text.\n## Part A\nA text.\n## Part B\nB text.');
});

// --- Commands and menus ---------------------------------------------------------

test('commands are available only with a note open', async () => {
    const { plugin, app, doc } = await setup();
    const command = plugin.commands.find((c) => c.id === 'print-selection-or-section');
    assert.equal(command.checkCallback(true), false);
    app.workspace.activeView = makeView(doc);
    assert.equal(command.checkCallback(true), true);
    assert.deepEqual(plugin.commands.map((c) => c.id), ['print-selection-or-section', 'print-note']);
});

test('the editor menu names what it will print', async () => {
    const { plugin, win, doc } = await setup();
    const onMenu = handler(plugin, 'editor-menu');

    let view = makeView(doc, { cursor: { line: 6, ch: 0 } });
    let menu = new Menu();
    onMenu(menu, view.editor, view);
    assert.equal(menu.items[0].title, 'Print section “Part A”');
    assert.equal(menu.items[0].icon, 'printer');

    view = makeView(doc, { cursor: { line: 6, ch: 0 }, to: { line: 6, ch: 4 } });
    menu = new Menu();
    onMenu(menu, view.editor, view);
    assert.equal(menu.items[0].title, 'Print selection');
    await menu.items[0].click();
    assert.equal(win.printed, 1);
    assert.equal(MarkdownRenderer.calls[0].markdown, 'A te');
});

test('the editor menu can be turned off, and ignores editors that are not notes', async () => {
    const { plugin, doc } = await setup({ stored: { editorMenu: false } });
    const onMenu = handler(plugin, 'editor-menu');
    const view = makeView(doc);
    const menu = new Menu();
    onMenu(menu, view.editor, view);
    plugin.settings.editorMenu = true;
    onMenu(menu, view.editor, { file: view.file }); // a canvas card, say
    assert.equal(menu.items.length, 0);
});

test('the file menu prints notes, and only notes', async () => {
    const note = new TFile('Notes/Closed.md');
    const { plugin, win } = await setup({ files: { 'Notes/Closed.md': '# Closed\nSaved text.' } });
    const onMenu = handler(plugin, 'file-menu');

    const menu = new Menu();
    onMenu(menu, new TFile('Pictures/photo.png'));
    onMenu(menu, { path: 'Notes', children: [] });
    onMenu(menu, note);
    assert.equal(menu.items.length, 1);
    assert.equal(menu.items[0].title, 'Print note');
    await menu.items[0].click();
    assert.equal(MarkdownRenderer.calls[0].markdown, '# Closed\nSaved text.');
    assert.equal(win.atPrint.title, 'Closed');
});

test('a note open in a view prints its live text from the file menu', async () => {
    const { doc: openDoc, win: openWin } = makeWindow();
    const view = makeView(openDoc, { text: '# Open\nUnsaved.' });
    const { plugin } = await setup({ openViews: [view], files: { 'Folder/My Note.md': '# Open\nOld.' } });
    await plugin.printFile(view.file);
    assert.equal(MarkdownRenderer.calls[0].markdown, '# Open\nUnsaved.');
    assert.equal(openWin.printed, 1, 'printed from the window the note is in');
});

// --- Settings -------------------------------------------------------------------

test('stored settings are checked on load', async () => {
    const { plugin } = await setup({ stored: { pageNumbers: 'roman', header: 'banner', margin: 500, textScale: 'big' } });
    assert.equal(plugin.settings.pageNumbers, DEFAULT_SETTINGS.pageNumbers);
    assert.equal(plugin.settings.header, DEFAULT_SETTINGS.header);
    assert.equal(plugin.settings.margin, 50);
    assert.equal(plugin.settings.textScale, DEFAULT_SETTINGS.textScale);
});

test('the settings page builds, and every control saves', async () => {
    const { plugin } = await setup();
    Setting.all.length = 0;
    plugin.settingTabs[0].display();
    const named = Setting.all.filter((s) => !s.heading);
    assert.deepEqual(named.map((s) => s.name), [
        'Include subsections', 'Note name as title', 'Light colours', 'Background colours',
        'Text size', 'Margins', 'Header', 'Page numbers', 'Editor menu', 'File menu',
    ]);
    const byName = (n) => named.find((s) => s.name === n).controls[0];
    byName('Page numbers').change('number');
    byName('Margins').change(22);
    byName('Light colours').change(false);
    assert.equal(plugin.saved.pageNumbers, 'number');
    assert.equal(plugin.saved.margin, 22);
    assert.equal(plugin.saved.lightColors, false);
    assert.deepEqual(Object.keys(byName('Header').options), ['none', 'note', 'note-section']);
});
