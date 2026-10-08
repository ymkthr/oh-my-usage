import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {fmt} from './model.js';
import {defaultOmpPath} from './store.js';

const PANEL_DISPLAY = [
    {nick: 'bars-and-text', label: () => _('Bars and text')},
    {nick: 'bars-only', label: () => _('Bars only')},
    {nick: 'text-only', label: () => _('Text only')},
];

export default class OmpUsagePreferences extends ExtensionPreferences {
    /** @param {Adw.PreferencesWindow} window */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const data = new Adw.PreferencesGroup({
            title: _('Data'),
            description: fmt(_('Leave the path empty to use %s.'), defaultOmpPath()),
        });
        data.add(pathRow(settings));
        data.add(intervalRow(settings));
        page.add(data);

        const panel = new Adw.PreferencesGroup({title: _('Panel')});
        panel.add(panelDisplayRow(settings));
        page.add(panel);

        const primary = new Adw.PreferencesGroup({
            title: _('Primary account'),
            description: _('Pick an account by activating its title in the top bar menu.'),
        });
        primary.add(primaryAccountRow(settings));
        page.add(primary);

        window.add(page);
    }
}

/**
 * @param {Gio.Settings} settings
 * @returns {Adw.EntryRow}
 */
function pathRow(settings) {
    const row = new Adw.EntryRow({
        title: _('omp binary'),
        show_apply_button: true,
        text: settings.get_string('omp-path'),
    });
    row.connect('apply', () => settings.set_string('omp-path', row.text));
    settings.connect('changed::omp-path', () => {
        const path = settings.get_string('omp-path');
        if (row.text !== path)
            row.text = path;
    });
    return row;
}

/**
 * @param {Gio.Settings} settings
 * @returns {Adw.SpinRow}
 */
function intervalRow(settings) {
    const row = new Adw.SpinRow({
        title: _('Refresh interval'),
        subtitle: _('Seconds between reads; the timer never invalidates the cache'),
        adjustment: new Gtk.Adjustment({
            lower: 30,
            upper: 3600,
            step_increment: 30,
            page_increment: 300,
        }),
    });
    settings.bind('refresh-interval', row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/**
 * GJS hands bind_with_mapping()'s get mapping its GValue as a plain number,
 * so that direction cannot set the row; both directions are synced by hand.
 * @param {Gio.Settings} settings
 * @returns {Adw.ComboRow}
 */
function panelDisplayRow(settings) {
    const nicks = PANEL_DISPLAY.map(p => p.nick);
    const row = new Adw.ComboRow({
        title: _('Top bar shows'),
        model: Gtk.StringList.new(PANEL_DISPLAY.map(p => p.label())),
        selected: Math.max(0, nicks.indexOf(settings.get_string('panel-display'))),
    });
    row.connect('notify::selected', () => {
        if (settings.get_string('panel-display') !== nicks[row.selected])
            settings.set_string('panel-display', nicks[row.selected]);
    });
    settings.connect('changed::panel-display', () => {
        const i = nicks.indexOf(settings.get_string('panel-display'));
        if (i >= 0 && i !== row.selected)
            row.selected = i;
    });
    return row;
}

/**
 * @param {Gio.Settings} settings
 * @returns {Adw.ActionRow}
 */
function primaryAccountRow(settings) {
    const row = new Adw.ActionRow({title: _('Account shown in the top bar')});
    const reset = new Gtk.Button({label: _('Use first account'), valign: Gtk.Align.CENTER});
    reset.connect('clicked', () => settings.set_string('primary-account', ''));
    row.add_suffix(reset);

    const sync = () => {
        const key = settings.get_string('primary-account');
        row.subtitle = key || _('first account');
        reset.sensitive = key !== '';
    };
    settings.connect('changed::primary-account', sync);
    sync();
    return row;
}
