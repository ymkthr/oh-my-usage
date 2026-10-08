import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {renderView} from './model.js';

/** @typedef {import('./model.js').PanelView} PanelView */
/** @typedef {import('./model.js').AlertView} AlertView */
/** @typedef {import('./model.js').SectionView} SectionView */
/** @typedef {import('./model.js').RowView} RowView */
/** @typedef {import('./model.js').BarView} BarView */
/** @typedef {import('./store.js').UsageStore} UsageStore */

/** @type {import('./model.js').I18n} */
const SHELL_I18N = {gettext: _, ngettext};

export class UsageBar extends St.Widget {
    static {
        GObject.registerClass(this);
    }

    #fill = new St.Widget({style_class: 'omp-usage-bar-fill'});
    #fraction = 0;

    /** @param {object} params */
    constructor(params) {
        super({...params, style_class: `omp-usage-bar ${params.style_class}`});
        this.add_child(this.#fill);
    }

    /** @param {BarView} bar */
    setBar({fraction, level}) {
        this.#fill.style_class = `omp-usage-bar-fill level-${level}`;
        if (fraction !== this.#fraction) {
            this.#fraction = fraction;
            this.queue_relayout();
        }
    }

    /** @param {Clutter.ActorBox} box */
    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        content.x2 = content.x1 + Math.round((content.x2 - content.x1) * this.#fraction);
        this.#fill.allocate(content);
    }
}

export class Indicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    /** @type {UsageStore} */
    #store;
    /** @type {Gio.Settings} */
    #settings;

    /** @type {UsageBar[]} */
    #panelBars;
    /** @type {St.BoxLayout} */
    #panelBarsBox;
    /** @type {St.Label} */
    #panelLabel;
    /** @type {St.Label} */
    #panelAlert;

    /** @type {St.Label} */
    #statusLabel;
    /** @type {PopupMenu.PopupMenuSection} */
    #alerts;
    /** @type {PopupMenu.PopupSeparatorMenuItem} */
    #alertsSeparator;
    /** @type {PopupMenu.PopupMenuSection} */
    #sections;
    /** @type {Map<string, PopupMenu.PopupBaseMenuItem>} */
    #titleItems = new Map();

    /**
     * @param {UsageStore} store
     * @param {Gio.Settings} settings
     * @param {() => void} openPreferences
     */
    constructor(store, settings, openPreferences) {
        super(0.5, _('LLM usage'));
        this.#store = store;
        this.#settings = settings;
        this.#buildPanel();
        this.#buildMenu(openPreferences);

        store.connectObject('changed', () => this.#render(), this);
        settings.connectObject(
            'changed::panel-display', () => this.#syncPanelDisplay(),
            'changed::primary-account', () => this.#syncPrimary(),
            this);
        this.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                store.refresh('read');
        }, this);

        this.#render();
    }

    #buildPanel() {
        const box = new St.BoxLayout({style_class: 'omp-usage-panel'});
        this.#panelBarsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'omp-usage-panel-bars',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.#panelBars = [0, 1].map(() => new UsageBar({style_class: 'omp-usage-panel-bar'}));
        this.#panelBars.forEach(bar => this.#panelBarsBox.add_child(bar));
        this.#panelLabel = new St.Label({
            style_class: 'omp-usage-panel-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.#panelAlert = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this.#panelBarsBox);
        box.add_child(this.#panelLabel);
        box.add_child(this.#panelAlert);
        this.add_child(box);
    }

    /** @param {() => void} openPreferences */
    #buildMenu(openPreferences) {
        const header = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'omp-usage-header',
        });
        header.add_child(new St.Label({
            text: _('LLM usage'),
            style_class: 'omp-usage-header-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.#statusLabel = new St.Label({
            style_class: 'omp-usage-status',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this.#statusLabel);
        this.menu.addMenuItem(header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.#alerts = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this.#alerts);
        this.#alertsSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this.#alertsSeparator);

        this.#sections = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this.#sections);
        // PanelMenu.Button caps the menu with max-height on open, so the account
        // list scrolls to keep the footer actions on short screens. addMenuItem()
        // has already wired the section before its actor moves, and PopupMenu
        // finds sections for separator visibility through `_delegate`.
        const scroll = new St.ScrollView({
            style_class: 'omp-usage-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            clip_to_allocation: true,
        });
        scroll._delegate = this.#sections;
        this.menu.box.replace_child(this.#sections.actor, scroll);
        scroll.set_child(this.#sections.actor);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Refresh now (invalidate cache)'), () => this.#store.refresh('invalidate'));
        this.menu.addAction(_('Settings…'), () => openPreferences());
    }

    #syncPanelDisplay() {
        const mode = this.#settings.get_string('panel-display');
        const hasBars = this.#panelBars.some(bar => bar.visible);
        this.#panelBarsBox.visible = mode !== 'text-only' && hasBars;
        this.#panelLabel.visible = mode !== 'bars-only' || !hasBars;
    }

    #view() {
        return renderView(this.#store.state,
            {primaryAccount: this.#settings.get_string('primary-account')}, Date.now(), SHELL_I18N);
    }

    #render() {
        const view = this.#view();

        this.#applyPanel(view.panel);
        this.#applyAlerts(view.alerts);
        this.#statusLabel.text = view.status;
        this.#statusLabel.style_class = `omp-usage-status level-${view.statusLevel}`;

        this.#sections.removeAll();
        this.#titleItems.clear();
        if (view.notice !== null)
            this.#sections.addMenuItem(noticeItem(view.notice));
        view.sections.forEach((section, i) => {
            if (i > 0)
                this.#sections.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.#addSection(section);
        });
    }

    /**
     * Runs inside the activated title item's `activate` emission. Destroying
     * that item here would disconnect PopupMenu's AFTER handler that closes
     * the menu, so the account sections only get their ornaments updated.
     */
    #syncPrimary() {
        const view = this.#view();
        this.#applyPanel(view.panel);
        this.#applyAlerts(view.alerts);
        for (const section of view.sections)
            this.#titleItems.get(section.key)?.setOrnament(ornamentOf(section));
    }

    /** @param {PanelView} panel */
    #applyPanel(panel) {
        this.#panelBars.forEach((bar, i) => {
            bar.visible = i < panel.bars.length;
            if (bar.visible)
                bar.setBar(panel.bars[i]);
        });
        this.#panelLabel.text = panel.text;
        this.#panelLabel.style_class = `omp-usage-panel-text level-${panel.level}${panel.stale ? ' stale' : ''}`;
        this.#syncPanelDisplay();
        this.#panelAlert.visible = panel.alert !== null;
        if (panel.alert !== null) {
            this.#panelAlert.text = panel.alert.text;
            this.#panelAlert.style_class = `omp-usage-panel-alert level-${panel.alert.level}`;
        }
    }

    /** @param {AlertView[]} alerts */
    #applyAlerts(alerts) {
        this.#alerts.removeAll();
        alerts.forEach(alert => this.#alerts.addMenuItem(alertItem(alert)));
        // PopupMenu re-evaluates separators only when the menu opens, and a
        // refresh landing while it is open can add the first alert.
        this.#alertsSeparator.visible = alerts.length > 0;
    }

    /** @param {SectionView} section */
    #addSection(section) {
        const title = new PopupMenu.PopupBaseMenuItem();
        title.setOrnament(ornamentOf(section));
        title.add_child(new St.Label({
            text: section.title,
            style_class: 'omp-usage-section-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (section.badge !== null) {
            title.add_child(new St.Label({
                text: section.badge,
                style_class: 'omp-usage-badge',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        title.connect('activate', () => this.#settings.set_string('primary-account', section.key));
        this.#sections.addMenuItem(title);
        this.#titleItems.set(section.key, title);

        const body = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'omp-usage-section-body-item',
        });
        body.add_child(ornamentWidthSpacer());
        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'omp-usage-section-body',
            x_expand: true,
        });
        column.add_child(new St.Label({text: section.subtitle, style_class: 'omp-usage-section-subtitle'}));
        for (const row of section.rows)
            column.add_child(rowLine(row));
        body.add_child(column);
        this.#sections.addMenuItem(body);
    }
}

/**
 * @param {SectionView} section
 * @returns {PopupMenu.Ornament}
 */
function ornamentOf(section) {
    return section.primary ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT;
}

/**
 * An empty icon in the theme's ornament slot, so a non-reactive item lines up
 * with the titles next to their dots.
 * @returns {St.Icon}
 */
function ornamentWidthSpacer() {
    return new St.Icon({style_class: 'popup-menu-ornament'});
}

/**
 * @param {RowView} row
 * @returns {St.BoxLayout}
 */
function rowLine(row) {
    const line = new St.BoxLayout({style_class: 'omp-usage-row'});
    line.add_child(new St.Label({
        text: row.label,
        style_class: 'omp-usage-row-label',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    const bar = new UsageBar({
        style_class: 'omp-usage-row-bar',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    bar.setBar(row);
    line.add_child(bar);
    line.add_child(new St.Label({
        text: row.detail,
        style_class: `omp-usage-row-detail level-${row.level}`,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    return line;
}

/**
 * @param {AlertView} alert
 * @returns {PopupMenu.PopupBaseMenuItem}
 */
function alertItem(alert) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    item.add_child(ornamentWidthSpacer());
    item.add_child(new St.Label({
        text: `${alert.title} · ${alert.label}`,
        style_class: 'omp-usage-alert-title',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    item.add_child(new St.Label({
        text: alert.detail,
        style_class: `omp-usage-alert-detail level-${alert.level}`,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    return item;
}

/**
 * @param {string} notice
 * @returns {PopupMenu.PopupMenuItem}
 */
function noticeItem(notice) {
    const item = new PopupMenu.PopupMenuItem(notice, {reactive: false, can_focus: false});
    item.label.add_style_class_name('omp-usage-notice');
    item.label.clutter_text.line_wrap = true;
    return item;
}
