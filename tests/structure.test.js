'use strict';

// Tests for the note-structure engine in main.js: front matter, headings,
// sections, and turning a selection into Markdown that renders on its own.
// Run with: node --test "tests/*.test.js"

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// Route require('obsidian') to the mock before loading the plugin
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'obsidian') return path.join(__dirname, 'mocks', 'obsidian.js');
    return origResolve.call(this, request, ...rest);
};

const {
    splitLines, bodyStart, scanNote, sectionAt, wholeNote, tableLead, calloutLead, dedent,
    linesMarkdown, selectionMarkdown, noteTarget, plainText, truncate, fileSafe, cssString, menuLabel,
} = require('../main.js').__internals;

const L = (...lines) => lines;
const at = (line, ch) => ({ line, ch });

// --- Front matter -----------------------------------------------------------

test('front matter is skipped, and only when it is closed', () => {
    assert.equal(bodyStart(L('# Title', 'text')), 0);
    assert.equal(bodyStart(L('---', 'tags: [a]', '---', '# Title')), 3);
    assert.equal(bodyStart(L('---', 'just a rule above prose')), 0, 'unclosed: not front matter');
    assert.equal(bodyStart([]), 0);
});

test('a YAML comment in the front matter is not a heading', () => {
    const note = scanNote(L('---', '# a YAML comment', 'tags: x', '---', '# Real'));
    assert.deepEqual(note.headings.map((h) => h.text), ['Real']);
});

// --- Headings ---------------------------------------------------------------

test('ATX headings: level, text, closing hashes', () => {
    const note = scanNote(L('# One', '## Two ##', '###   Three  ', '#', 'text'));
    assert.deepEqual(note.headings.map((h) => [h.line, h.level, h.text]), [
        [0, 1, 'One'], [1, 2, 'Two'], [2, 3, 'Three'], [3, 1, ''],
    ]);
});

test('tags, seven hashes and indented code are not headings', () => {
    const note = scanNote(L('#tag at the start of a line', '####### seven', '    # indented code', '\t# tab-indented'));
    assert.deepEqual(note.headings, []);
});

test('a # comment inside fenced code is not a heading', () => {
    const note = scanNote(L(
        '# Install',
        '```bash',
        '# fetch the dependencies',
        'npm ci',
        '```',
        '~~~',
        '## also not a heading',
        '~~~',
        '## Use',
    ));
    assert.deepEqual(note.headings.map((h) => h.text), ['Install', 'Use']);
    assert.deepEqual(note.blocks.map((b) => [b.kind, b.start, b.end, b.closed]), [
        ['fence', 1, 4, true], ['fence', 5, 7, true],
    ]);
});

test('a fence closes only on the same character, at least as long', () => {
    const note = scanNote(L('````md', '```', '# inside', '~~~~', '````', '# after'));
    assert.deepEqual(note.headings.map((h) => h.text), ['after']);
    assert.deepEqual(note.blocks.map((b) => [b.start, b.end]), [[0, 4]]);
});

test('an unclosed fence runs to the end of the note, as it renders', () => {
    const note = scanNote(L('# A', '```', '# swallowed', 'more'));
    assert.deepEqual(note.headings.map((h) => h.text), ['A']);
    assert.deepEqual(note.blocks[0], Object.assign({}, note.blocks[0], { start: 1, end: 3, closed: false }));
});

test('math and comment blocks hide what they contain', () => {
    const note = scanNote(L('$$', '# x', '$$', '$$ inline $$', '%%', '# commented out', '%%', 'a %%short%% comment', '# Kept'));
    assert.deepEqual(note.headings.map((h) => h.text), ['Kept']);
    assert.deepEqual(note.blocks.map((b) => [b.kind, b.start, b.end]), [['math', 0, 2], ['comment', 4, 6]]);
});

test('a heading that opens a comment is still a heading', () => {
    const note = scanNote(L('## Plan %% to do:', '# hidden', '%%', '## Next'));
    assert.deepEqual(note.headings.map((h) => [h.line, h.text]), [[0, 'Plan %% to do:'], [3, 'Next']]);
    assert.deepEqual(note.blocks.map((b) => [b.kind, b.start, b.end]), [['comment', 0, 2]]);
});

test('setext headings, and the heading-plus-rule pattern that is not one', () => {
    const note = scanNote(L(
        'Title over',
        'two lines',
        '===',
        '',
        'Sub',
        '---',
        '',
        '## Divided',
        '---',
        '',
        '- item',
        '---',
    ));
    assert.deepEqual(note.headings.map((h) => [h.line, h.endLine, h.level, h.text]), [
        [0, 2, 1, 'Title over two lines'],
        [4, 5, 2, 'Sub'],
        [7, 7, 2, 'Divided'],
    ]);
});

// --- Sections ---------------------------------------------------------------

const DOC = L(
    '---',            // 0
    'tags: [x]',      // 1
    '---',            // 2
    'Intro line.',    // 3
    '',               // 4
    '# Chapter',      // 5
    'Chapter text.',  // 6
    '## Part A',      // 7
    'A text.',        // 8
    '```sh',          // 9
    '# not a heading',// 10
    '```',            // 11
    '### Deep',       // 12
    'Deep text.',     // 13
    '',               // 14
    '## Part B',      // 15
    'B text.',        // 16
    '',               // 17
    '',               // 18
);

test('the section runs to the next heading of the same or higher level', () => {
    const s = sectionAt(DOC, 8, true);
    assert.deepEqual([s.kind, s.from, s.to, s.heading.text], ['section', 7, 13, 'Part A']);
});

test('without subsections it stops at the next heading of any level', () => {
    const s = sectionAt(DOC, 8, false);
    assert.deepEqual([s.from, s.to], [7, 11]);
});

test('the cursor on the heading line itself selects that section', () => {
    assert.equal(sectionAt(DOC, 5, true).heading.text, 'Chapter');
    assert.deepEqual([sectionAt(DOC, 5, true).from, sectionAt(DOC, 5, true).to], [5, 16]);
});

test('the last section runs to the end, without trailing blank lines', () => {
    const s = sectionAt(DOC, 16, true);
    assert.deepEqual([s.from, s.to], [15, 16]);
});

test('above the first heading it is the text there', () => {
    const s = sectionAt(DOC, 3, true);
    assert.deepEqual([s.kind, s.from, s.to, s.heading], ['preamble', 3, 3, null]);
});

test('a cursor in the front matter counts as the top of the text', () => {
    assert.equal(sectionAt(DOC, 1, true).kind, 'preamble');
});

test('at the top of a note that opens with a heading, the whole note', () => {
    const lines = L('---', 'a: 1', '---', '', '# Only', 'text', '');
    const s = sectionAt(lines, 0, true);
    assert.deepEqual([s.kind, s.from, s.to], ['note', 4, 5]);
});

test('a note with no headings is one section', () => {
    const s = sectionAt(L('just', 'prose'), 1, true);
    assert.deepEqual([s.kind, s.from, s.to], ['preamble', 0, 1]);
});

test('an empty note has nothing to print', () => {
    assert.equal(sectionAt(L('', ''), 0, true), null);
    assert.equal(wholeNote(L('---', 'a: 1', '---', ''), undefined), null);
});

test('a setext heading opens a section like any other', () => {
    const lines = L('Alpha', '=====', 'one', '', 'Beta', '----', 'two');
    assert.deepEqual([sectionAt(lines, 2, true).from, sectionAt(lines, 2, true).to], [0, 6]);
    assert.deepEqual([sectionAt(lines, 6, true).from, sectionAt(lines, 6, true).to], [4, 6]);
    assert.deepEqual([sectionAt(lines, 2, false).from, sectionAt(lines, 2, false).to], [0, 2]);
});

test('a setext underline takes the whole paragraph above it', () => {
    // No blank line between them, so "one" and "Beta" are one paragraph —
    // and the underline makes all of it the heading, as CommonMark says.
    const note = scanNote(L('one', 'Beta', '----'));
    assert.deepEqual(note.headings.map((h) => [h.line, h.endLine, h.text]), [[0, 2, 'one Beta']]);
});

// --- Fragments that render on their own -----------------------------------

test('whole lines print as they are', () => {
    assert.equal(linesMarkdown(DOC, 6, 8), 'Chapter text.\n## Part A\nA text.');
});

test('the front matter never prints as text', () => {
    assert.equal(linesMarkdown(DOC, 0, 3), 'Intro line.');
});

test('a run cut from inside a code block gets its fence back', () => {
    const lines = L('```js', 'const a = 1;', 'const b = 2;', 'const c = 3;', '```');
    assert.equal(linesMarkdown(lines, 2, 3), '```js\nconst b = 2;\nconst c = 3;\n```');
    assert.equal(linesMarkdown(lines, 0, 2), '```js\nconst a = 1;\nconst b = 2;\n```');
    assert.equal(linesMarkdown(lines, 1, 4), '```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```');
});

test('a fence line alone at either end is dropped', () => {
    const lines = L('```', 'code', '```', 'after', 'more', '```py', 'x = 1', '```');
    assert.equal(linesMarkdown(lines, 2, 4), 'after\nmore');
    assert.equal(linesMarkdown(lines, 3, 5), 'after\nmore');
});

test('a run crossing from one block into another closes the second', () => {
    const lines = L('```a', '1', '```', 'between', '```b', '2', '3', '```');
    assert.equal(linesMarkdown(lines, 1, 5), '```a\n1\n```\nbetween\n```b\n2\n```');
});

test('rows from the middle of a table keep the header row', () => {
    const lines = L('| Task | Owner |', '| --- | :-: |', '| a | 1 |', '| b | 2 |', '| c | 3 |');
    assert.equal(linesMarkdown(lines, 3, 4), '| Task | Owner |\n| --- | :-: |\n| b | 2 |\n| c | 3 |');
    assert.equal(linesMarkdown(lines, 1, 2), '| Task | Owner |\n| --- | :-: |\n| a | 1 |');
    assert.equal(linesMarkdown(lines, 0, 2), lines.slice(0, 3).join('\n'));
});

test('tableLead stops at a blank line and ignores prose', () => {
    assert.deepEqual(tableLead(L('| h |', '| - |', '', '| x |'), 3), []);
    assert.deepEqual(tableLead(L('plain prose', 'more'), 1), []);
});

test('lines from inside a callout keep the callout line', () => {
    const lines = L('> [!tip] Remember', '> first', '> second', '', '> plain quote', '> line');
    assert.equal(linesMarkdown(lines, 2, 2 + 0), '> [!tip] Remember\n> second');
    assert.deepEqual(calloutLead(lines, 5), [], 'a plain quote stays a plain quote');
});

test('items from a nested list lose the shared indentation', () => {
    const lines = L('- top', '\t- nested one', '\t\t- deeper', '\t- nested two');
    assert.equal(linesMarkdown(lines, 1, 3), '- nested one\n\t- deeper\n- nested two');
});

test('dedent leaves code indentation alone when the fence is flush left', () => {
    assert.deepEqual(dedent(L('```py', '    x = 1', '```')), L('```py', '    x = 1', '```'));
    assert.deepEqual(dedent(L('  a', '', '  b')), L('a', '', 'b'));
});

test('a run cut from inside a math block keeps its delimiters', () => {
    const lines = L('$$', 'a = b', 'c = d', '$$');
    assert.equal(linesMarkdown(lines, 2, 2), '$$\nc = d\n$$');
});

// --- Editor selections ----------------------------------------------------

const PROSE = L('First line with **bold** words.', 'Second line.', 'Third line.', '```sh', '# a comment', 'ls', '```');

test('a selection within one line is exact', () => {
    assert.equal(selectionMarkdown(PROSE, at(0, 6), at(0, 10)), 'line');
});

test('a phrase lifted from a code block prints as code', () => {
    assert.equal(selectionMarkdown(PROSE, at(4, 0), at(4, 11)), '```sh\n# a comment\n```');
});

test('across lines the selection widens to whole lines', () => {
    assert.equal(selectionMarkdown(PROSE, at(0, 20), at(1, 3)), 'First line with **bold** words.\nSecond line.');
});

test('a selection dragged to the start of a line has not chosen that line', () => {
    assert.equal(selectionMarkdown(PROSE, at(1, 0), at(3, 0)), 'Second line.\nThird line.');
});

test('a selection of only whitespace prints nothing', () => {
    assert.equal(selectionMarkdown(L('a   b'), at(0, 1), at(0, 4)), '');
});

test('a whole note prints without its front matter', () => {
    assert.equal(noteTarget('---\na: 1\n---\n\n# T\nbody\n').markdown, '# T\nbody');
    assert.equal(noteTarget('---\na: 1\n---\n').markdown, '');
});

test('Windows line endings are understood', () => {
    assert.deepEqual(splitLines('a\r\nb\nc'), ['a', 'b', 'c']);
});

// --- Text helpers -----------------------------------------------------------

test('plainText strips the markup a heading can carry', () => {
    assert.equal(
        plainText('<span style="display:block; text-align:center">Daily Meals</span>'),
        'Daily Meals', 'the centred-title pattern');
    assert.equal(plainText('See [[Other note|the other]] and [[Note#Part]]'), 'See the other and Note › Part');
    assert.equal(plainText('**Bold** and `code` and [a link](https://x.y)'), 'Bold and code and a link');
    assert.equal(plainText('Fish &amp; chips&nbsp;&lt;3'), 'Fish & chips <3');
});

test('truncate, fileSafe and cssString', () => {
    assert.equal(truncate('abcdef', 4), 'abc…');
    assert.equal(truncate('abc', 4), 'abc');
    assert.equal(fileSafe('Plan: Q3 / Q4 <draft>?'), 'Plan Q3 Q4 draft');
    assert.equal(cssString('Say "hi" \\ bye'), '"Say \\"hi\\" \\\\ bye"');
    assert.equal(cssString('two\nlines'), '"two lines"');
});

test('menu labels say what will print', () => {
    assert.equal(menuLabel({ kind: 'selection' }), 'Print selection');
    assert.equal(menuLabel({ kind: 'note' }), 'Print note');
    assert.equal(menuLabel({ kind: 'preamble' }), 'Print text above the first heading');
    assert.equal(menuLabel({ kind: 'section', heading: { text: '**Budget** 2026' } }), 'Print section “Budget 2026”');
    assert.equal(menuLabel({ kind: 'section', heading: { text: '' } }), 'Print section');
    const long = menuLabel({ kind: 'section', heading: { text: 'x'.repeat(80) } });
    assert.ok(long.length < 60 && long.endsWith('…”'));
});
