import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {parsePolicies, parseUsage} from './model.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

/** @typedef {'read' | 'invalidate'} Request */

/**
 * @typedef {object} FetchOptions
 * @property {string} ompPath
 * @property {number} intervalSeconds
 */

/** @typedef {import('./model.js').StoreState} StoreState */
/** @typedef {import('./model.js').Snapshot} Snapshot */
/** @typedef {import('./model.js').AccountPolicy} AccountPolicy */
/** @typedef {import('./model.js').FetchError} FetchError */

const WATCHDOG_SECONDS = 60;

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

    /** @param {FetchOptions} options */
    constructor(options) {
        super();
        this.configure(options);
    }

    /** @returns {StoreState} */
    get state() {
        return {snapshot: this.#snapshot, policies: this.#policies, error: this.#error, inFlight: this.#inFlight};
    }

    get #destroyed() {
        return this.#cancellable.is_cancelled();
    }

    /** @param {FetchOptions} options */
    configure(options) {
        this.#ompPath = options.ompPath || defaultOmpPath();
        this.#intervalSeconds = options.intervalSeconds;
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
        const path = this.#ompPath;
        if (!GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) {
            this.#error = {kind: 'missing-binary', path};
            return;
        }

        try {
            if (request === 'invalidate')
                await this.#spawn(['usage', 'invalidate']);

            const run = await this.#spawn(['usage', '--json']);
            if (!run.ok) {
                this.#error = {kind: 'exit', status: run.status, stderrHead: firstLine(run.stderr)};
                return;
            }
            this.#snapshot = parseUsage(run.stdout);
            this.#error = null;
            await this.#readPolicies();
        } catch (e) {
            if (e instanceof Gio.IOErrorEnum && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this.#error = classify(e, path);
        }
    }

    /**
     * Priorities only order the accounts, so an omp that cannot answer the
     * config read keeps the last policies instead of failing the refresh.
     */
    async #readPolicies() {
        try {
            const run = await this.#spawn(['config', 'get', 'auth.accountPolicies', '--json']);
            if (run.ok)
                this.#policies = parsePolicies(run.stdout);
        } catch {
        }
    }

    /**
     * @param {string[]} args
     * @returns {Promise<{ok: boolean, status: number, stdout: string, stderr: string}>}
     * @throws {GLib.Error} SpawnError (NOENT for a missing binary) or IOErrorEnum.CANCELLED
     */
    async #spawn(args) {
        this.#cancellable.set_error_if_cancelled();

        const proc = Gio.Subprocess.new([this.#ompPath, ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
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
