#!/usr/bin/env -S gjs -m

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {UsageStore, defaultOmpPath} from '../src/store.js';

const here = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
const FAKE_OMP = `${here}/fixtures/fake-omp`;
const SELF_PID = Gio.Credentials.new().get_unix_pid();
const POLICIES = 'config get auth.accountPolicies --json';
const NO_OPENROUTER = {account: null, error: null, history: null, historyError: null};

// GLib.get_home_dir() caches HOME on its first call, so HOME is replaced
// before anything reads it.
const HOME = GLib.Dir.make_tmp('omp-store-test-XXXXXX');
GLib.setenv('HOME', HOME, true);
GLib.mkdir_with_parents(`${HOME}/.bun/bin`, 0o755);
Gio.File.new_for_path(`${HOME}/.bun/bin/omp`).make_symbolic_link(FAKE_OMP, null);

GLib.unsetenv('OPENROUTER_API_KEY');
GLib.unsetenv('OPENROUTER_MANAGEMENT_KEY');
const FAKE_SHELL = `${HOME}/fake-shell`;
GLib.file_set_contents(FAKE_SHELL, `#!/bin/sh
echo "$@" >> "$FAKE_SHELL_LOG"
echo 'Welcome to fake-shell'
OPENROUTER_API_KEY="$FAKE_OPENROUTER_KEY"
OPENROUTER_MANAGEMENT_KEY="$FAKE_OPENROUTER_MANAGEMENT_KEY"
eval "$4"
`);
GLib.chmod(FAKE_SHELL, 0o755);
GLib.setenv('SHELL', FAKE_SHELL, true);

let checks = 0;
let failures = 0;

/** @param {string} name @param {unknown} actual @param {unknown} expected */
function eq(name, actual, expected) {
    checks++;
    const got = JSON.stringify(actual);
    const want = JSON.stringify(expected);
    if (got === want) {
        print(`ok ${name}`);
    } else {
        failures++;
        print(`not ok ${name}\n  got  ${got}\n  want ${want}`);
    }
}

/** @param {number} ms */
function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

/**
 * @template T
 * @param {() => T} probe
 * @param {number} timeoutMs
 * @returns {Promise<T|null>}
 */
function until(probe, timeoutMs) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
            const value = probe();
            if (value) {
                resolve(value);
                return GLib.SOURCE_REMOVE;
            }
            if (GLib.get_monotonic_time() > deadline) {
                resolve(null);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    });
}

/**
 * @param {UsageStore} store
 * @returns {Promise<void>}
 */
function settled(store) {
    return new Promise(resolve => {
        const id = store.connect('changed', () => {
            if (store.state.inFlight)
                return;
            store.disconnect(id);
            resolve();
        });
    });
}

/** @param {string} path @returns {string|null} */
function readFile(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

let logCounter = 0;

/**
 * @param {'ok' | 'fail' | 'hang'} mode
 * @returns {{lines: () => string[]}}
 */
function fakeOmp(mode = 'ok') {
    const logPath = `${HOME}/fake-omp-${++logCounter}.log`;
    GLib.setenv('FAKE_OMP_LOG', logPath, true);
    GLib.setenv('FAKE_OMP_MODE', mode, true);
    return {
        lines: () => (readFile(logPath) ?? '').split('\n').filter(line => line.length > 0),
    };
}

/** @returns {{lines: () => string[]}} */
function fakeShell() {
    const logPath = `${HOME}/fake-shell-${++logCounter}.log`;
    GLib.setenv('FAKE_SHELL_LOG', logPath, true);
    return {
        lines: () => (readFile(logPath) ?? '').split('\n').filter(line => line.length > 0),
    };
}

const KEY_BODY = JSON.stringify({data: {usage_daily: 0.5, usage_weekly: 1.25, usage_monthly: 3, budgets: []}});
const ACTIVITY_BODY = JSON.stringify({data: [{date: '2026-10-13 00:00:00', model: 'openai/gpt-5', usage: 0.25}]});

function fakeOpenRouter() {
    const server = new Soup.Server({});
    const auth = {key: [], activity: []};
    const reply = {key: {status: 200, body: KEY_BODY}, activity: {status: 200, body: ACTIVITY_BODY}};
    for (const route of ['key', 'activity']) {
        server.add_handler(`/api/v1/${route}`, (_server, message) => {
            auth[route].push(message.get_request_headers().get_one('Authorization'));
            message.set_status(reply[route].status, null);
            message.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(reply[route].body));
        });
    }
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    return {
        base: `http://127.0.0.1:${server.get_uris()[0].get_port()}/api/v1`,
        auth: () => [...auth.key],
        activityAuth: () => [...auth.activity],
        reply: reply.key,
        activityReply: reply.activity,
        stop: () => server.disconnect(),
    };
}

/** @returns {number[]} */
function fakeOmpChildren() {
    const dir = GLib.Dir.open('/proc', 0);
    const pids = [];
    for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
        if (!/^\d+$/.test(name))
            continue;
        const stat = readFile(`/proc/${name}/stat`);
        const cmdline = readFile(`/proc/${name}/cmdline`);
        if (stat === null || cmdline === null)
            continue;
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        if (ppid === SELF_PID && cmdline.includes('fake-omp'))
            pids.push(Number(name));
    }
    dir.close();
    return pids;
}

/** @param {string} path */
function removeTree(path) {
    if (GLib.file_test(path, GLib.FileTest.IS_DIR) && !GLib.file_test(path, GLib.FileTest.IS_SYMLINK)) {
        const dir = GLib.Dir.open(path, 0);
        for (let name = dir.read_name(); name !== null; name = dir.read_name())
            removeTree(`${path}/${name}`);
        dir.close();
        GLib.rmdir(path);
    } else {
        GLib.unlink(path);
    }
}

const cases = {
    async 'first read publishes a snapshot'() {
        const fake = fakeOmp();
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 0});
        const states = [];
        store.connect('changed', () => states.push(store.state.inFlight));
        eq('read: state before the first refresh', store.state,
            {snapshot: null, policies: [], error: null, inFlight: false, openRouter: NO_OPENROUTER});
        store.refresh('read');
        await settled(store);
        eq('read: changed fired for in-flight then idle', states, [true, false]);
        eq('read: snapshot has the four accounts', store.state.snapshot?.accounts.length, 4);
        eq('read: no error', store.state.error, null);
        eq('read: usage then policies', fake.lines(), ['usage --json', POLICIES]);
        eq('read: policies come from omp config', store.state.policies, [
            {provider: 'openai-codex', selector: {email: 'work@example.com'}, priority: 10},
            {provider: 'openai-codex', selector: {email: 'personal@example.com'}, priority: 1},
        ]);
        store.destroy();
    },

    async 'empty omp-path resolves to ~/.bun/bin/omp'() {
        const fake = fakeOmp();
        eq('default path: under HOME', defaultOmpPath(), `${HOME}/.bun/bin/omp`);
        const store = new UsageStore({ompPath: '', intervalSeconds: 0});
        store.refresh('read');
        await settled(store);
        eq('default path: the default binary ran', fake.lines(), ['usage --json', POLICIES]);
        eq('default path: snapshot published', [store.state.error, store.state.snapshot?.accounts.length], [null, 4]);
        store.destroy();
    },

    async 'single flight: requests during a read merge into one follow-up'() {
        const fake = fakeOmp();
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 0});
        let changes = 0;
        store.connect('changed', () => changes++);
        store.refresh('read');
        store.refresh('invalidate');
        store.refresh('read');
        store.refresh('read');
        eq('single flight: in flight right after refresh()', store.state.inFlight, true);
        await settled(store);
        eq('single flight: one invalidate and one read follow the first read', fake.lines(),
            ['usage --json', POLICIES, 'usage invalidate', 'usage --json', POLICIES]);
        eq('single flight: one drain, two changed signals', changes, 2);
        eq('single flight: snapshot published', store.state.snapshot?.accounts.length, 4);
        store.refresh('read');
        await settled(store);
        eq('single flight: a later refresh runs again', fake.lines().length, 7);
        store.destroy();
    },

    async 'non-zero exit keeps the last snapshot and reports the stderr head'() {
        const fake = fakeOmp();
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 0});
        store.refresh('read');
        await settled(store);
        const good = store.state.snapshot;

        GLib.setenv('FAKE_OMP_MODE', 'fail', true);
        store.refresh('read');
        await settled(store);
        eq('failure: snapshot retained', store.state.snapshot === good, true);
        eq('failure: error kind, status and message', store.state.error,
            {kind: 'exit', status: 1, stderrHead: 'AuthBrokerError: Auth broker request failed after 2 attempt(s)'});

        GLib.setenv('FAKE_OMP_MODE', 'ok', true);
        store.refresh('read');
        await settled(store);
        eq('failure: success clears the error', store.state.error, null);
        eq('failure: success replaces the snapshot', store.state.snapshot !== good, true);
        eq('failure: policies are read only after a successful usage read', fake.lines(),
            ['usage --json', POLICIES, 'usage --json', 'usage --json', POLICIES]);
        store.destroy();
    },

    async 'a failed policy read keeps the last policies and is not an error'() {
        const fake = fakeOmp();
        GLib.setenv('FAKE_OMP_POLICY_MODE', 'fail', true);
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 0});
        store.refresh('read');
        await settled(store);
        eq('policy failure: first read publishes the snapshot without policies',
            [store.state.error, store.state.snapshot?.accounts.length, store.state.policies], [null, 4, []]);

        GLib.unsetenv('FAKE_OMP_POLICY_MODE');
        store.refresh('read');
        await settled(store);
        const policies = store.state.policies;
        const good = store.state.snapshot;
        eq('policy failure: recovered policies', policies.length, 2);

        GLib.setenv('FAKE_OMP_POLICY_MODE', 'fail', true);
        store.refresh('read');
        await settled(store);
        GLib.unsetenv('FAKE_OMP_POLICY_MODE');
        eq('policy failure: no error', store.state.error, null);
        eq('policy failure: the new snapshot is published', store.state.snapshot !== good && store.state.snapshot !== null, true);
        eq('policy failure: previous policies kept', store.state.policies === policies, true);
        eq('policy failure: each attempt asked for policies', fake.lines(),
            ['usage --json', POLICIES, 'usage --json', POLICIES, 'usage --json', POLICIES]);
        store.destroy();
    },

    async 'missing binary is a state, not an exception'() {
        const fake = fakeOmp();
        const store = new UsageStore({ompPath: '/nonexistent/omp', intervalSeconds: 0});
        const states = [];
        store.connect('changed', () => states.push(store.state.inFlight));
        store.refresh('invalidate');
        await settled(store);
        eq('missing: error names the path', store.state.error, {kind: 'missing-binary', path: '/nonexistent/omp'});
        eq('missing: nothing was spawned', fake.lines(), []);
        eq('missing: still publishes in-flight then idle', states, [true, false]);

        store.configure({ompPath: FAKE_OMP, intervalSeconds: 0});
        store.refresh('read');
        await settled(store);
        eq('missing: a corrected path recovers', [store.state.error, fake.lines()], [null, ['usage --json', POLICIES]]);
        store.destroy();
    },

    async 'destroy() during a read kills the child and goes silent'() {
        const fake = fakeOmp('hang');
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 0});
        let changes = 0;
        store.connect('changed', () => changes++);
        store.refresh('read');
        const child = await until(() => fake.lines().length === 1 ? fakeOmpChildren()[0] : null, 3000);
        eq('destroy: child is running after its start line', [child !== null, fake.lines()], [true, ['usage --json']]);
        eq('destroy: one changed before destroy (in flight)', changes, 1);

        store.destroy();
        store.refresh('read');
        const gone = await until(() => !GLib.file_test(`/proc/${child}`, GLib.FileTest.IS_DIR), 3000);
        eq('destroy: child is gone', gone, true);
        await sleep(300);
        eq('destroy: no changed after destroy', changes, 1);
        eq('destroy: state settles without publishing', store.state,
            {snapshot: null, policies: [], error: null, inFlight: false, openRouter: NO_OPENROUTER});
        eq('destroy: refresh after destroy spawned nothing', fake.lines(), ['usage --json']);
        store.destroy();
        eq('destroy: idempotent', fakeOmpChildren(), []);
    },

    async 'without a key OpenRouter stays out and nothing is requested'() {
        fakeOmp();
        const shell = fakeShell();
        GLib.unsetenv('FAKE_OPENROUTER_KEY');
        GLib.unsetenv('FAKE_OPENROUTER_MANAGEMENT_KEY');
        const server = fakeOpenRouter();
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 0, openRouterBase: server.base});
        store.refresh('read');
        await settled(store);
        eq('no key: OpenRouter state is empty', store.state.openRouter, NO_OPENROUTER);
        eq('no key: the login shell was asked with -l -i -c', shell.lines().map(line => line.split(' ').slice(0, 3)),
            [['-l', '-i', '-c']]);
        eq('no key: OpenRouter was not called', server.auth(), []);
        eq('no key: omp is unaffected', store.state.snapshot?.accounts.length, 4);

        store.refresh('read');
        await settled(store);
        eq('no key: each refresh asks again, so a key set later is picked up', shell.lines().length, 2);
        store.destroy();
        server.stop();
    },

    async 'a key from the login shell reads OpenRouter and is kept'() {
        fakeOmp();
        const shell = fakeShell();
        GLib.setenv('FAKE_OPENROUTER_KEY', 'sk-or-test', true);
        const server = fakeOpenRouter();
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 0, openRouterBase: server.base});
        store.refresh('read');
        await settled(store);
        eq('key: the key goes in the bearer header', server.auth(), ['Bearer sk-or-test']);
        eq('key: spend becomes the OpenRouter account',
            store.state.openRouter.account?.windows.map(w => [w.label, w.spentUsd]),
            [['Today', 0.5], ['This week', 1.25], ['This month', 3]]);
        eq('key: no error', store.state.openRouter.error, null);
        eq('key: without a management key there is no history and no activity request',
            [store.state.openRouter.history, server.activityAuth()], [null, []]);

        store.refresh('read');
        await settled(store);
        eq('key: the shell ran once and OpenRouter twice', [shell.lines().length, server.auth().length], [1, 2]);
        store.destroy();
        server.stop();
    },

    async 'OpenRouter failures keep the last account; a rejected key is asked for again'() {
        fakeOmp();
        const shell = fakeShell();
        GLib.setenv('FAKE_OPENROUTER_KEY', 'sk-or-test', true);
        const server = fakeOpenRouter();
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 0, openRouterBase: server.base});
        store.refresh('read');
        await settled(store);
        const good = store.state.openRouter.account;

        server.reply.status = 500;
        store.refresh('read');
        await settled(store);
        eq('failure: HTTP 500 is reported and the account kept',
            [store.state.openRouter.error, store.state.openRouter.account === good], [{kind: 'http', status: 500}, true]);
        eq('failure: a server error keeps the key', shell.lines().length, 1);

        server.reply.status = 401;
        store.refresh('read');
        await settled(store);
        eq('failure: HTTP 401 is reported', store.state.openRouter.error, {kind: 'http', status: 401});
        store.refresh('read');
        await settled(store);
        eq('failure: after a 401 the shell is asked again', shell.lines().length, 2);

        server.reply.status = 200;
        server.reply.body = '<html>maintenance</html>';
        store.refresh('read');
        await settled(store);
        eq('failure: a body that is not key JSON', store.state.openRouter.error?.kind, 'invalid-json');

        server.stop();
        store.refresh('read');
        await settled(store);
        eq('failure: an unreachable server is a network error with the account kept',
            [store.state.openRouter.error?.kind, store.state.openRouter.account === good], ['network', true]);
        eq('failure: omp keeps working throughout', store.state.error, null);
        store.destroy();
    },

    async 'a management key adds the activity history'() {
        fakeOmp();
        const shell = fakeShell();
        GLib.setenv('FAKE_OPENROUTER_KEY', 'sk-or-test', true);
        GLib.setenv('FAKE_OPENROUTER_MANAGEMENT_KEY', 'sk-or-mgmt', true);
        const server = fakeOpenRouter();
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 0, openRouterBase: server.base});
        store.refresh('read');
        await settled(store);
        eq('history: each endpoint gets its own key', [server.auth(), server.activityAuth()],
            [['Bearer sk-or-test'], ['Bearer sk-or-mgmt']]);
        eq('history: the activity becomes the history',
            [store.state.openRouter.history, store.state.openRouter.historyError], [[{date: '2026-10-13', usd: 0.25}], null]);
        const good = store.state.openRouter.history;

        server.activityReply.status = 500;
        store.refresh('read');
        await settled(store);
        eq('history: a failure keeps the last history and the account', [
            store.state.openRouter.historyError, store.state.openRouter.history === good, store.state.openRouter.error,
        ], [{kind: 'http', status: 500}, true, null]);
        eq('history: a server error keeps both keys', shell.lines().length, 1);

        server.activityReply.status = 403;
        store.refresh('read');
        await settled(store);
        eq('history: HTTP 403 is reported', store.state.openRouter.historyError, {kind: 'http', status: 403});
        server.activityReply.status = 200;
        store.refresh('read');
        await settled(store);
        eq('history: after a 403 the shell is asked again and the retry succeeds',
            [shell.lines().length, store.state.openRouter.historyError], [2, null]);
        store.destroy();
        server.stop();
    },

    async 'keys in the environment skip the shell'() {
        fakeOmp();
        const shell = fakeShell();
        GLib.setenv('OPENROUTER_API_KEY', 'sk-or-env', true);
        GLib.setenv('OPENROUTER_MANAGEMENT_KEY', 'sk-or-env-mgmt', true);
        const server = fakeOpenRouter();
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 0, openRouterBase: server.base});
        store.refresh('read');
        await settled(store);
        eq('env: both keys came from the environment', [server.auth(), server.activityAuth(), shell.lines()],
            [['Bearer sk-or-env'], ['Bearer sk-or-env-mgmt'], []]);

        GLib.unsetenv('OPENROUTER_MANAGEMENT_KEY');
        GLib.setenv('FAKE_OPENROUTER_MANAGEMENT_KEY', 'sk-or-shell-mgmt', true);
        server.activityReply.status = 401;
        store.refresh('read');
        await settled(store);
        server.activityReply.status = 200;
        store.refresh('read');
        await settled(store);
        eq('env: a missing management key is asked from the shell while the API key stays from the environment',
            [shell.lines().length, server.auth().at(-1), server.activityAuth().at(-1)],
            [1, 'Bearer sk-or-env', 'Bearer sk-or-shell-mgmt']);
        GLib.unsetenv('OPENROUTER_API_KEY');
        store.destroy();
        server.stop();
    },

    async 'timer only ever reads; configure() re-arms it and destroy() stops it'() {
        const fake = fakeOmp();
        const reads = () => fake.lines().filter(line => line === 'usage --json').length;
        const store = new UsageStore({ompPath: FAKE_OMP, intervalSeconds: 1});
        eq('timer: first tick arrives', await until(() => fake.lines().length >= 2, 3000), true);
        eq('timer: tick is a plain read', fake.lines(), ['usage --json', POLICIES]);

        store.configure({ompPath: FAKE_OMP, intervalSeconds: 0});
        await sleep(2000);
        eq('timer: interval 0 stops the ticks', reads(), 1);

        store.configure({ompPath: FAKE_OMP, intervalSeconds: 1});
        store.configure({ompPath: FAKE_OMP, intervalSeconds: 1});
        await sleep(3100);
        const ticks = reads() - 1;
        eq('timer: one re-armed timer ticks once a second', ticks >= 2 && ticks <= 3, true);
        eq('timer: never invalidates', fake.lines().includes('usage invalidate'), false);

        store.destroy();
        const after = fake.lines().length;
        await sleep(2000);
        eq('timer: destroy stops the ticks', fake.lines().length, after);
    },
};

const loop = new GLib.MainLoop(null, false);
(async () => {
    for (const [name, run] of Object.entries(cases)) {
        try {
            await run();
        } catch (e) {
            failures++;
            print(`not ok ${name}\n  threw ${e}`);
        }
    }
    removeTree(HOME);
    print(failures === 0 ? `# all ${checks} checks passed` : `# ${failures} of ${checks} checks failed`);
    loop.quit();
})();
loop.run();
System.exit(failures === 0 ? 0 : 1);
