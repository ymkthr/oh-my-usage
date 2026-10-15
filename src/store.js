import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';

import {
    OPENROUTER_KEY_SCRIPT, parseOpenRouterActivity, parseOpenRouterKey, parsePolicies, parseShellKeys, parseUsage,
} from './model.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

/** @typedef {'read' | 'invalidate'} Request */

/**
 * @typedef {object} FetchOptions
 * @property {string} ompPath
 * @property {number} intervalSeconds
 * @property {string} [openRouterBase]  `/key` and `/activity` are appended; tests point it at a local server
 */

/** @typedef {import('./model.js').StoreState} StoreState */
/** @typedef {import('./model.js').Snapshot} Snapshot */
/** @typedef {import('./model.js').AccountPolicy} AccountPolicy */
/** @typedef {import('./model.js').FetchError} FetchError */
/** @typedef {import('./model.js').OpenRouterState} OpenRouterState */
/** @typedef {import('./model.js').OpenRouterError} OpenRouterError */
/** @typedef {import('./model.js').OpenRouterKeys} OpenRouterKeys */

const WATCHDOG_SECONDS = 60;

export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

/** @type {OpenRouterState} */
const NO_OPENROUTER = {account: null, error: null, history: null, historyError: null};

/**
 * The Shell's PATH does not contain ~/.bun/bin, so find_program_in_path() would miss omp.
 * @returns {string}
 */
export function defaultOmpPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.bun', 'bin', 'omp']);
}

/**
 * @param {Request|null} queued
 * @param {Request} incoming
 * @returns {Request}
 */
function mergeRequests(queued, incoming) {
    return queued === 'invalidate' || incoming === 'invalidate' ? 'invalidate' : 'read';
}

export class UsageStore extends GObject.Object {
    static {
        GObject.registerClass({
            Signals: {'changed': {}},
        }, this);
    }

    /** @type {Snapshot|null} */
    #snapshot = null;
    /** @type {AccountPolicy[]} */
    #policies = [];
    /** @type {FetchError|null} */
    #error = null;
    /** @type {OpenRouterState} */
    #openRouter = NO_OPENROUTER;
    /**
     * @type {OpenRouterKeys|null}
     */
    #openRouterKeys = null;
    #session = new Soup.Session({timeout: WATCHDOG_SECONDS});

    #inFlight = false;
    /**
     * Cancelling #cancellable only abandons communicate()'s pipes; the child
     * itself has to be force_exit()ed.
     * @type {Gio.Subprocess|null}
     */
    #proc = null;
    /** @type {Request|null} */
    #queued = null;

    #cancellable = new Gio.Cancellable();
    #timerId = 0;

    /** @type {string} */
    #ompPath = defaultOmpPath();
    #intervalSeconds = 300;
    #openRouterBase = OPENROUTER_API_BASE;

    /** @param {FetchOptions} options */
    constructor(options) {
        super();
        this.configure(options);
    }

    /** @returns {StoreState} */
    get state() {
        return {
            snapshot: this.#snapshot,
            policies: this.#policies,
            error: this.#error,
            inFlight: this.#inFlight,
            openRouter: this.#openRouter,
        };
    }

    get #destroyed() {
        return this.#cancellable.is_cancelled();
    }

    /** @param {FetchOptions} options */
    configure(options) {
        this.#ompPath = options.ompPath || defaultOmpPath();
        this.#intervalSeconds = options.intervalSeconds;
        this.#openRouterBase = options.openRouterBase ?? OPENROUTER_API_BASE;
        this.#armTimer();
    }

    /** @param {Request} [request] */
    refresh(request = 'read') {
        if (this.#destroyed)
            return;
        if (this.#inFlight) {
            this.#queued = mergeRequests(this.#queued, request);
            return;
        }
        this.#drain(request).catch(logError);
    }

    destroy() {
        if (this.#destroyed)
            return;
        this.#cancellable.cancel();
        this.#proc?.force_exit();
        this.#stopTimer();
        this.#queued = null;
    }

    #armTimer() {
        this.#stopTimer();
        if (this.#intervalSeconds <= 0 || this.#destroyed)
            return;
        this.#timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this.#intervalSeconds, () => {
            this.refresh('read');
            return GLib.SOURCE_CONTINUE;
        });
    }

    #stopTimer() {
        if (this.#timerId)
            GLib.Source.remove(this.#timerId);
        this.#timerId = 0;
    }

    /** @param {Request} first */
    async #drain(first) {
        this.#inFlight = true;
        this.emit('changed');

        let next = first;
        while (next !== null && !this.#destroyed) {
            await this.#runOnce(next);
            next = this.#queued;
            this.#queued = null;
        }

        this.#inFlight = false;
        if (!this.#destroyed)
            this.emit('changed');
    }

    /** @param {Request} request */
    async #runOnce(request) {
        await this.#readOmp(request);
        if (!this.#destroyed)
            await this.#readOpenRouter();
    }

    /** @param {Request} request */
    async #readOmp(request) {
        const path = this.#ompPath;
        if (!GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) {
            this.#error = {kind: 'missing-binary', path};
            return;
        }

        try {
            if (request === 'invalidate')
                await this.#spawn([path, 'usage', 'invalidate']);

            const run = await this.#spawn([path, 'usage', '--json']);
            if (!run.ok) {
                this.#error = {kind: 'exit', status: run.status, stderrHead: firstLine(run.stderr)};
                return;
            }
            this.#snapshot = parseUsage(run.stdout);
            this.#error = null;
            await this.#readPolicies(path);
        } catch (e) {
            if (isCancelled(e))
                return;
            this.#error = classify(e, path);
        }
    }

    async #readOpenRouter() {
        if (this.#openRouterKeys === null) {
            const keys = await this.#resolveOpenRouterKeys();
            if (keys.apiKey === null) {
                this.#openRouter = NO_OPENROUTER;
                return;
            }
            this.#openRouterKeys = keys;
        }
        const {apiKey, managementKey} = this.#openRouterKeys;

        const key = await this.#get(`${this.#openRouterBase}/key`, apiKey, body => parseOpenRouterKey(body, Date.now()));
        if (key === null)
            return;
        let history = null;
        let historyError = null;
        if (managementKey !== null) {
            const activity = await this.#get(`${this.#openRouterBase}/activity`, managementKey, parseOpenRouterActivity);
            if (activity === null)
                return;
            history = activity.value ?? this.#openRouter.history;
            historyError = activity.error;
        }
        if (isRejection(key.error) || isRejection(historyError))
            this.#openRouterKeys = null;
        this.#openRouter = {account: key.value ?? this.#openRouter.account, error: key.error, history, historyError};
    }

    /**
     * @template T
     * @param {string} url
     * @param {string} token
     * @param {(body: string) => T} parse
     * @returns {Promise<{value: T, error: null} | {value: null, error: OpenRouterError} | null>}  null once destroyed
     */
    async #get(url, token, parse) {
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        let body;
        try {
            const bytes = await this.#session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this.#cancellable);
            body = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
        } catch (e) {
            return isCancelled(e) ? null : {value: null, error: {kind: 'network', detail: String(e?.message ?? e)}};
        }

        const status = message.get_status();
        if (status !== Soup.Status.OK) {
            return {value: null, error: {kind: 'http', status}};
        }
        try {
            return {value: parse(body), error: null};
        } catch (e) {
            return {value: null, error: {kind: 'invalid-json', detail: e.message}};
        }
    }

    /**
     * The Shell inherits the session environment, not the variables a user
     * exports from their shell startup files, so the login shell is asked for
     * whichever key the environment lacks.
     * @returns {Promise<OpenRouterKeys>}
     */
    async #resolveOpenRouterKeys() {
        const env = {
            apiKey: GLib.getenv('OPENROUTER_API_KEY') || null,
            managementKey: GLib.getenv('OPENROUTER_MANAGEMENT_KEY') || null,
        };
        if (env.apiKey !== null && env.managementKey !== null)
            return env;
        let shell = {apiKey: null, managementKey: null};
        try {
            const run = await this.#spawn([GLib.getenv('SHELL') || '/bin/sh', '-l', '-i', '-c', OPENROUTER_KEY_SCRIPT]);
            shell = parseShellKeys(run.stdout);
        } catch {
        }
        return {apiKey: env.apiKey ?? shell.apiKey, managementKey: env.managementKey ?? shell.managementKey};
    }

    /**
     * Priorities only order the accounts, so an omp that cannot answer the
     * config read keeps the last policies instead of failing the refresh.
     * @param {string} path
     */
    async #readPolicies(path) {
        try {
            const run = await this.#spawn([path, 'config', 'get', 'auth.accountPolicies', '--json']);
            if (run.ok)
                this.#policies = parsePolicies(run.stdout);
        } catch {
        }
    }

    /**
     * @param {string[]} argv
     * @returns {Promise<{ok: boolean, status: number, stdout: string, stderr: string}>}
     * @throws {GLib.Error} SpawnError (NOENT for a missing binary) or IOErrorEnum.CANCELLED
     */
    async #spawn(argv) {
        this.#cancellable.set_error_if_cancelled();

        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this.#proc = proc;

        let watchdogId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WATCHDOG_SECONDS, () => {
            watchdogId = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });

        try {
            const [stdout, stderr] = await proc.communicate_utf8_async(null, this.#cancellable);
            return {ok: proc.get_successful(), status: exitStatus(proc), stdout, stderr};
        } finally {
            if (watchdogId)
                GLib.Source.remove(watchdogId);
            this.#proc = null;
        }
    }
}

/** @param {OpenRouterError|null} error @returns {boolean} */
function isRejection(error) {
    return error?.kind === 'http' && (error.status === 401 || error.status === 403);
}

/** @param {unknown} e @returns {boolean} */
function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * @param {Gio.Subprocess} proc
 * @returns {number}
 */
function exitStatus(proc) {
    return proc.get_if_exited() ? proc.get_exit_status() : 128 + proc.get_term_sig();
}

/**
 * @param {unknown} e
 * @param {string} path
 * @returns {FetchError}
 */
function classify(e, path) {
    if (e instanceof GLib.Error && e.matches(GLib.SpawnError, GLib.SpawnError.NOENT))
        return {kind: 'missing-binary', path};
    if (e instanceof GLib.Error)
        return {kind: 'spawn', path, detail: e.message};
    return {kind: 'invalid-json', detail: String(e?.message ?? e)};
}

/**
 * @param {string} stderr
 * @returns {string}
 */
function firstLine(stderr) {
    return stderr.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? '';
}
