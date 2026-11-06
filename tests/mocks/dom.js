'use strict';

// A DOM stand-in covering the slice of the API the plugin touches, including
// Obsidian's own HTMLElement extensions (createDiv, addClass, hasClass, ...),
// plus a window and document around it. Enough to run a whole printout under
// Node and check that everything it changed is put back.

class FakeStyle {
    constructor() {
        this.props = {};
    }
    setProperty(name, value) { this.props[name] = String(value); }
    removeProperty(name) { delete this.props[name]; }
    getPropertyValue(name) { return this.props[name] || ''; }
}

class FakeEl {
    constructor(tag, ownerDocument) {
        this.tag = String(tag || 'div').toLowerCase();
        this.nodeType = 1;
        this.ownerDocument = ownerDocument || null;
        this.children = [];
        this.parentElement = null;
        this.classes = new Set();
        this.listeners = {};
        this.attributes = {};
        this.text = '';
        this.style = new FakeStyle();
        this.loading = 'auto';
        this.complete = true;
    }

    get className() { return [...this.classes].join(' '); }
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
    get firstChild() { return this.children[0] || null; }

    make(tag, o) {
        const child = new FakeEl(tag, this.ownerDocument);
        if (o && o.cls) {
            const list = Array.isArray(o.cls) ? o.cls : String(o.cls).split(/\s+/);
            list.filter(Boolean).forEach((c) => child.classes.add(c));
        }
        if (o && o.text) child.text = o.text;
        return this.appendChild(child);
    }

    createDiv(o) { return this.make('div', o); }
    createSpan(o) { return this.make('span', o); }
    createEl(tag, o) { return this.make(tag, o); }

    appendChild(child) {
        if (child.tag === '#fragment') {
            for (const c of child.children) this.appendChild(c);
            child.children = [];
            return child;
        }
        child.parentElement = this;
        child.ownerDocument = this.ownerDocument;
        this.children.push(child);
        return child;
    }

    remove() {
        if (this.parentElement) {
            const siblings = this.parentElement.children;
            const i = siblings.indexOf(this);
            if (i !== -1) siblings.splice(i, 1);
        }
        this.parentElement = null;
        this.removed = true;
    }

    empty() { this.children = []; }
    setText(t) { this.text = String(t); }
    addClass(...c) { c.forEach((x) => this.classes.add(x)); }
    removeClass(...c) { c.forEach((x) => this.classes.delete(x)); }
    hasClass(c) { return this.classes.has(c); }
    toggleClass(c, on) { if (on) this.classes.add(c); else this.classes.delete(c); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }

    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    removeEventListener(name, fn) {
        this.listeners[name] = (this.listeners[name] || []).filter((f) => f !== fn);
    }
    fire(name, evt) {
        for (const fn of [...(this.listeners[name] || [])]) fn(evt || { type: name });
    }

    contains(node) {
        for (let n = node; n; n = n.parentElement) if (n === this) return true;
        return false;
    }

    // Every descendant, not including this element.
    descendants(out) {
        const acc = out || [];
        for (const c of this.children) {
            acc.push(c);
            c.descendants(acc);
        }
        return acc;
    }

    querySelectorAll(selector) {
        const tags = selector.split(',').map((s) => s.trim().toLowerCase());
        return this.descendants().filter((el) => tags.includes(el.tag));
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    // Classes of every descendant, for asserting on what was built.
    find(cls) {
        return this.descendants().find((el) => el.classes.has(cls)) || null;
    }
}

function fragment(doc, text) {
    const f = new FakeEl('#fragment', doc);
    if (text) f.createEl('p', { text });
    return f;
}

// A window and document shaped like Obsidian's: <body> carries the theme
// class, and the theme's colours are readable through getComputedStyle.
function makeWindow(options) {
    const opts = Object.assign({ theme: 'dark', printFiresAfterprint: true }, options);
    const listeners = {};
    const win = {
        printed: 0,
        listeners,
        computed: {
            '--background-primary': '#1e1e1e',
            '--text-normal': '#dadada',
            backgroundColor: 'rgb(30, 30, 30)',
            color: 'rgb(218, 218, 218)',
            fontFamily: '"Inter", sans-serif',
        },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        requestAnimationFrame: (fn) => setTimeout(fn, 0),
        getComputedStyle(el) {
            const values = win.computed;
            return {
                getPropertyValue: (name) => values[name] || '',
                backgroundColor: values.backgroundColor,
                color: values.color,
                fontFamily: el && el.style && el.style.props['font-family'] ? el.style.props['font-family'] : values.fontFamily,
            };
        },
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
        addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
        removeEventListener(name, fn) {
            listeners[name] = (listeners[name] || []).filter((f) => f !== fn);
        },
        fire(name) {
            for (const fn of [...(listeners[name] || [])]) fn({ type: name });
        },
        // Snapshot of the document at the moment print() is called — that is
        // what would reach the paper.
        print() {
            win.printed++;
            win.atPrint = snapshot(doc);
            if (opts.printFiresAfterprint) win.fire('afterprint');
        },
    };

    const doc = {
        title: 'Note - Vault - Obsidian',
        fonts: { ready: Promise.resolve() },
        defaultView: win,
        selection: null,
        getSelection() { return doc.selection; },
    };
    doc.documentElement = new FakeEl('html', doc);
    doc.head = doc.documentElement.createEl('head');
    doc.body = doc.documentElement.createEl('body');
    doc.body.addClass(opts.theme === 'dark' ? 'theme-dark' : 'theme-light');
    doc.body.createDiv({ cls: 'app-container' });
    win.document = doc;
    return { win, doc };
}

function snapshot(doc) {
    return {
        title: doc.title,
        bodyClasses: [...doc.body.classes],
        htmlVars: Object.assign({}, doc.documentElement.style.props),
        bodyChildren: doc.body.children.map((c) => [...c.classes].join(' ')),
    };
}

module.exports = { FakeEl, FakeStyle, fragment, makeWindow, snapshot };
