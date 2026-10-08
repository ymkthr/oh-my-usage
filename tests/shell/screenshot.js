import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'omp-usage@ymkthr.github.io';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area', 'screenshot_area_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

export const METRICS = {};

function env(name, fallback = null) {
    return GLib.getenv(name) ?? fallback;
}

function check(condition, what) {
    if (!condition)
        throw new Error(`omp-usage test: FAIL ${what}`);
    log(`omp-usage test: ok ${what}`);
}

function labelsIn(actor, styleClass) {
    const found = [];
    const visit = a => {
        if (a instanceof St.Label && a.has_style_class_name(styleClass))
            found.push(a);
        for (const child of a.get_children())
            visit(child);
    };
    visit(actor);
    return found;
}

function textsIn(actor, styleClass) {
    return labelsIn(actor, styleClass).map(l => l.text);
}

async function waitFor(what, predicate, timeoutMs = 30000) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        if (await predicate())
            return;
        await Scripting.sleep(250);
    }
    throw new Error(`omp-usage test: FAIL timeout waiting for ${what}`);
}

async function shoot(path, area) {
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    const shooter = new Shell.Screenshot();
    const [ok] = area
        ? await shooter.screenshot_area(area.x, area.y, area.width, area.height, stream)
        : await shooter.screenshot(false, stream);
    stream.close(null);
    check(ok, `screenshot written to ${path}`);
}

async function captureMenu(indicator, shotPath) {
    indicator.menu.open(PopupAnimation.NONE);
    await Scripting.waitLeisure();
    await Scripting.sleep(500);
    await shoot(shotPath);
    const menuActor = indicator.menu.actor;
    const [x, y] = menuActor.get_transformed_position();
    const [width, height] = menuActor.get_transformed_size();
    const stage = global.stage;
    const crop = {
        x: Math.max(0, Math.floor(x) - 12),
        y: 0,
        width: Math.min(stage.width, Math.ceil(width) + 24),
        height: Math.min(stage.height, Math.ceil(y + height) + 12),
    };
    await shoot(shotPath.replace(/\.png$/, '-menu.png'), crop);
}

async function childAlive(pattern) {
    const shellPid = String(new Gio.Credentials().get_unix_pid());
    const proc = Gio.Subprocess.new(['pgrep', '-P', shellPid, '-f', pattern], Gio.SubprocessFlags.STDOUT_SILENCE);
    try {
        await proc.wait_check_async(null);
        return true;
    } catch {
        return false;
    }
}

function indicatorOf() {
    const indicator = Main.panel.statusArea[UUID];
    check(indicator, 'indicator is in the panel status area');
    return indicator;
}

// gnome-shell-test-tool gives only the shell its private XDG dirs and keyfile
// settings backend; a D-Bus-activated service would get the dbus-daemon's
// environment, which points at the real user profile.
function startPrefsService() {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('WAYLAND_DISPLAY', 'gnome-shell-test-display', true);
    launcher.setenv('GDK_BACKEND', 'wayland', true);
    launcher.setenv('SHELL_DBUS_PERSIST', '1', true);
    return launcher.spawnv(['gjs', '-m', '/usr/share/gnome-shell/org.gnome.Shell.Extensions']);
}

async function nameHasOwner(name) {
    const reply = await Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', [name]),
        new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, -1, null);
    return reply.deepUnpack()[0];
}

function prefsWindow() {
    return global.display.list_all_windows().find(w => w.get_title() === 'omp usage') ?? null;
}

async function shootWindow(path) {
    const rect = prefsWindow().get_frame_rect();
    await shoot(path, {x: rect.x, y: rect.y, width: rect.width, height: rect.height});
}

async function openPrefs(what) {
    check(Main.extensionManager.openExtensionPrefs(UUID, '', {}), `${what} requested`);
    await waitFor(`${what} window`, () => prefsWindow() !== null);
    await Scripting.sleep(1000);
}

async function closePrefs(what) {
    prefsWindow().delete(global.get_current_time());
    await waitFor(`${what} window to close`, () => prefsWindow() === null);
}

export async function run() {
    await runScenario();
    log('omp-usage test: done');
}

async function runScenario() {
    Main.overview.hide();
    await Scripting.waitLeisure();

    await waitFor(`extension ${UUID} to become active`,
        () => Main.extensionManager.lookup(UUID)?.state === ExtensionState.ACTIVE)
        .catch(e => {
            const ext = Main.extensionManager.lookup(UUID);
            throw new Error(`${e.message} (state=${ext?.state}, error=${ext?.error}, known=${Main.extensionManager.getUuids().join(',')})`);
        });
    const extension = Main.extensionManager.lookup(UUID);
    check(true, `extension ${UUID} is active`);
    const settings = extension.stateObj.getSettings();
    const mode = env('OMP_USAGE_TEST_MODE', 'success');
    const shotPath = env('OMP_USAGE_TEST_SHOT', `/tmp/omp-usage-${mode}.png`);

    const ompPath = env('OMP_USAGE_TEST_OMP');
    if (ompPath)
        settings.set_string('omp-path', ompPath);

    let indicator = indicatorOf();
    const expectPanel = new RegExp(env('OMP_USAGE_TEST_EXPECT_PANEL', '^5h \\d+% · 7d \\d+%$'));
    await waitFor(`panel label matching ${expectPanel}`,
        () => textsIn(indicator, 'omp-usage-panel-text').some(t => expectPanel.test(t)));
    check(true, `panel label is "${textsIn(indicator, 'omp-usage-panel-text')[0]}"`);

    if (mode === 'success') {
        const expectAlert = env('OMP_USAGE_TEST_EXPECT_ALERT');
        if (expectAlert) {
            const [alert] = labelsIn(indicator, 'omp-usage-panel-alert');
            check(alert?.visible && alert.text === expectAlert && alert.has_style_class_name('level-error'),
                `panel alert is "${alert?.text}" in the error colour`);
            settings.set_string('panel-display', 'bars-only');
            await Scripting.sleep(300);
            check(alert.visible && !labelsIn(indicator, 'omp-usage-panel-text')[0].visible,
                'panel alert stays visible when the display mode hides the text');
            settings.set_string('panel-display', 'bars-and-text');
        }
        await captureMenu(indicator, shotPath);
        const expectAlertRows = env('OMP_USAGE_TEST_EXPECT_ALERT_ROWS');
        if (expectAlertRows) {
            const titles = labelsIn(indicator.menu.box, 'omp-usage-alert-title');
            const rows = titles.map(t => t.text);
            check(JSON.stringify(rows) === expectAlertRows, `dropdown alert rows are ${JSON.stringify(rows)}`);
            const menuBottom = indicator.menu.actor.get_transformed_position()[1] +
                indicator.menu.actor.get_transformed_size()[1];
            check(titles.every(t => t.is_mapped() &&
                t.get_transformed_position()[1] + t.height <= Math.min(menuBottom, global.stage.height)),
            'dropdown alert rows are on screen without scrolling');
        }
        const expectMenu = env('OMP_USAGE_TEST_EXPECT_MENU');
        if (expectMenu) {
            const re = new RegExp(expectMenu);
            const texts = [
                ...textsIn(indicator.menu.box, 'omp-usage-section-title'),
                ...textsIn(indicator.menu.box, 'omp-usage-row-label'),
                ...textsIn(indicator.menu.box, 'omp-usage-row-detail'),
                ...textsIn(indicator.menu.box, 'omp-usage-status'),
            ];
            check(texts.some(t => re.test(t)), `a dropdown label matches ${re} (saw ${JSON.stringify(texts)})`);
        }
        indicator.menu.close(PopupAnimation.NONE);
        return;
    }

    if (mode === 'fail-stale') {
        const before = textsIn(indicator, 'omp-usage-panel-text')[0];
        GLib.setenv('FAKE_OMP_MODE', 'fail', true);
        indicator.menu.open(PopupAnimation.NONE);
        await waitFor('stale header after the menu-open refresh fails',
            () => textsIn(indicator.menu.box, 'omp-usage-status').some(t => /update failed/.test(t)));
        const after = textsIn(indicator, 'omp-usage-panel-text')[0];
        check(after === before, `panel keeps the last good numbers (${after})`);
        check(labelsIn(indicator, 'omp-usage-panel-text')[0].has_style_class_name('stale'),
            'panel label carries the stale class');
        await captureMenu(indicator, shotPath);
        indicator.menu.close(PopupAnimation.NONE);
        return;
    }

    if (mode === 'disable-midfetch') {
        const child = 'fake-omp usage --json';
        GLib.setenv('FAKE_OMP_MODE', 'hang', true);
        indicator.menu.open(PopupAnimation.NONE);
        await waitFor('the menu-open refresh to start a hung omp', () => childAlive(child));
        check(true, 'hung omp child is running');
        GLib.setenv('FAKE_OMP_MODE', 'ok', true);
        Main.extensionManager.disableExtension(UUID);
        await waitFor('extension disabled', () => extension.state === ExtensionState.INACTIVE);
        check(!Main.panel.statusArea[UUID], 'indicator removed from the panel on disable');
        await Scripting.sleep(1000);
        check(!(await childAlive(child)), 'hung omp child was killed on disable');
        Main.extensionManager.enableExtension(UUID);
        await waitFor('extension re-enabled', () => extension.state === ExtensionState.ACTIVE);
        indicator = indicatorOf();
        check(textsIn(indicator, 'omp-usage-panel-text').length === 1, 'indicator rebuilt after re-enable');
        return;
    }

    if (mode === 'prefs') {
        const service = startPrefsService();
        await waitFor('prefs service on the session bus', () => nameHasOwner('org.gnome.Shell.Extensions'));
        await openPrefs('prefs');
        await shootWindow(shotPath.replace(/\.png$/, '-prefs.png'));
        await closePrefs('prefs');

        await openPrefs('reopened prefs');
        settings.set_string('panel-display', 'text-only');
        settings.set_string('primary-account', 'opencode-go:1');
        settings.set_uint('refresh-interval', 600);
        await Scripting.sleep(2000);
        await shootWindow(shotPath.replace(/\.png$/, '-prefs-reopened.png'));
        await closePrefs('reopened prefs');
        const panelText = textsIn(indicator, 'omp-usage-panel-text')[0];
        check(settings.get_string('primary-account') === 'opencode-go:1' &&
            settings.get_uint('refresh-interval') === 600,
        `settings written by the shell survive the open prefs window (primary=${
            settings.get_string('primary-account')}, interval=${settings.get_uint('refresh-interval')})`);
        check(panelText === '5h 0% · 7d 0%', `primary account drives the panel (${panelText})`);
        service.force_exit();
        return;
    }

    throw new Error(`omp-usage test: FAIL unknown mode ${mode}`);
}
