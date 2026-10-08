import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Indicator} from './indicator.js';
import {UsageStore} from './store.js';

/**
 * @param {Gio.Settings} settings
 * @returns {import('./store.js').FetchOptions}
 */
function fetchOptions(settings) {
    return {
        ompPath: settings.get_string('omp-path'),
        intervalSeconds: settings.get_uint('refresh-interval'),
    };
}

export default class OmpUsageExtension extends Extension {
    /** @type {Gio.Settings|null} */
    _settings = null;
    /** @type {UsageStore|null} */
    _store = null;
    /** @type {Indicator|null} */
    _indicator = null;

    enable() {
        this._settings = this.getSettings();
        this._store = new UsageStore(fetchOptions(this._settings));
        this._settings.connectObject(
            'changed::omp-path', () => {
                this._store.configure(fetchOptions(this._settings));
                this._store.refresh('read');
            },
            'changed::refresh-interval', () => this._store.configure(fetchOptions(this._settings)),
            this);

        this._indicator = new Indicator(this._store, this._settings, () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._store.refresh('read');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._store?.destroy();
        this._store = null;
        this._settings?.disconnectObject(this);
        this._settings = null;
    }
}
