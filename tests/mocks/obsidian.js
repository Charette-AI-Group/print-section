'use strict';

// Minimal stand-in for the 'obsidian' module so main.js can be loaded and
// driven under Node (node --test tests/).

const { FakeEl } = require('./dom.js');

class Component {
    constructor() {
        this.loaded = false;
        this.children = [];
    }
    load() { this.loaded = true; }
    unload() { this.loaded = false; }
    addChild(c) { this.children.push(c); return c; }
}

class Plugin extends Component {
    constructor(app, manifest) {
        super();
        this.app = app;
        this.manifest = manifest;
        this.commands = [];
        this.ribbon = [];
        this.events = [];
        this.postProcessors = [];
        this.settingTabs = [];
        this.saved = null;
        this.stored = {};
    }
    addRibbonIcon(icon, title, cb) { this.ribbon.push({ icon, title, cb }); return new FakeEl('div'); }
    addCommand(cmd) { this.commands.push(cmd); return cmd; }
    addSettingTab(tab) { this.settingTabs.push(tab); }
    registerEvent(ref) { this.events.push(ref); }
    registerMarkdownPostProcessor(fn) { this.postProcessors.push(fn); }
    loadData() { return Promise.resolve(this.stored); }
    saveData(data) { this.saved = JSON.parse(JSON.stringify(data)); return Promise.resolve(); }
}

class PluginSettingTab {
    constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = new FakeEl('div');
    }
}

// Records what was built and keeps each control's onChange, so tests can
// both see the settings page and operate it.
class Setting {
    constructor(containerEl) {
        this.controls = [];
        Setting.all.push(this);
        if (containerEl) containerEl.createDiv({ cls: 'setting-item' });
    }
    setName(n) { this.name = n; return this; }
    setDesc(d) { this.desc = d; return this; }
    setHeading() { this.heading = true; return this; }
    control(kind, cb) {
        const c = {
            kind,
            options: {},
            setValue(v) { c.value = v; return c; },
            onChange(fn) { c.change = fn; return c; },
            setLimits(min, max, step) { c.limits = [min, max, step]; return c; },
            setDynamicTooltip() { return c; },
            addOptions(o) { Object.assign(c.options, o); return c; },
        };
        cb(c);
        this.controls.push(c);
        return this;
    }
    addToggle(cb) { return this.control('toggle', cb); }
    addSlider(cb) { return this.control('slider', cb); }
    addDropdown(cb) { return this.control('dropdown', cb); }
}
Setting.all = [];

class MarkdownView {}

class TFile {
    constructor(path) {
        this.path = path;
        const name = path.split('/').pop();
        this.extension = name.includes('.') ? name.split('.').pop() : '';
        this.basename = name.replace(/\.[^.]*$/, '');
    }
}

// Renders by writing the Markdown into the element as text, unless a test
// supplies its own implementation. Every call is recorded.
const MarkdownRenderer = {
    calls: [],
    impl: null,
    async render(app, markdown, el, sourcePath, component) {
        MarkdownRenderer.calls.push({ markdown, el, sourcePath, component, componentLoaded: component.loaded });
        if (MarkdownRenderer.impl) return MarkdownRenderer.impl(app, markdown, el, sourcePath, component);
        el.createDiv({ cls: 'rendered', text: markdown });
    },
};

const notices = [];
class Notice {
    constructor(msg) { notices.push(msg); }
}

class Menu {
    constructor() { this.items = []; }
    addItem(cb) {
        const item = {
            setTitle(t) { item.title = t; return item; },
            setIcon(i) { item.icon = i; return item; },
            setSection(s) { item.section = s; return item; },
            onClick(fn) { item.click = fn; return item; },
        };
        cb(item);
        this.items.push(item);
        return this;
    }
}

module.exports = {
    Plugin, PluginSettingTab, Setting, MarkdownView, MarkdownRenderer, Component, Notice, TFile, Menu,
    __notices: notices,
};
