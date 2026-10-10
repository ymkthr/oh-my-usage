/** @typedef {'normal' | 'warning' | 'error'} Level */

/** @typedef {string} AccountKey */

/**
 * @typedef {object} UsageWindow
 * @property {string} id
 * @property {string} kind
 * @property {string|null} tier
 * @property {string} label
 * @property {number|null} usedFraction
 * @property {number|null} resetsAt
 */

/**
 * @typedef {object} Account
 * @property {AccountKey} key
 * @property {string} provider
 * @property {number} ordinal
 * @property {string|null} accountId
 * @property {string|null} orgId
 * @property {string|null} org
 * @property {string|null} plan
 * @property {string|null} email
 * @property {number} resetCredits
 * @property {UsageWindow[]} windows
 */

/**
 * @typedef {object} Snapshot
 * @property {number} generatedAt
 * @property {Account[]} accounts
 */

/**
 * @typedef {object} AccountSelector
 * @property {string} [email]
 * @property {string} [accountId]
 * @property {string} [projectId]
 * @property {string} [orgId]
 */

/**
 * @typedef {object} AccountPolicy
 * @property {string} provider
 * @property {AccountSelector} selector
 * @property {number|null} priority
 */

/**
 * @typedef {{kind: 'missing-binary', path: string}
 *   | {kind: 'spawn', path: string, detail: string}
 *   | {kind: 'exit', status: number, stderrHead: string}
 *   | {kind: 'invalid-json', detail: string}} FetchError
 */

/**
 * @typedef {object} StoreState
 * @property {Snapshot|null} snapshot
 * @property {AccountPolicy[]} policies
 * @property {FetchError|null} error
 * @property {boolean} inFlight
 */

/** @typedef {{fraction: number, level: Level}} BarView */

/**
 * @typedef {object} PanelView
 * @property {BarView[]} bars
 * @property {string} text
 * @property {Level} level
 * @property {boolean} stale
 * @property {{text: string, level: Level}|null} alert
 */

/**
 * @typedef {object} RowView
 * @property {string} label
 * @property {number} fraction
 * @property {Level} level
 * @property {string} detail
 */

/**
 * @typedef {object} SectionView
 * @property {AccountKey} key
 * @property {string} title
 * @property {string} subtitle
 * @property {string|null} badge
 * @property {boolean} primary
 * @property {RowView[]} rows
 */

/**
 * @typedef {object} ProviderView
 * @property {string} provider
 * @property {string} title
 * @property {string} count
 * @property {SectionView[]} accounts  priority descending, then the snapshot order
 */

/**
 * @typedef {object} AlertView
 * @property {AccountKey} key
 * @property {string} title
 * @property {string} label
 * @property {string} detail
 * @property {'warning'|'error'} level
 */

/**
 * @typedef {object} View
 * @property {PanelView} panel
 * @property {string} status
 * @property {Level} statusLevel
 * @property {string|null} notice
 * @property {ProviderView[]} providers
 * @property {AlertView[]} alerts
 */

/**
 * @typedef {object} ViewPrefs
 * @property {AccountKey|''} primaryAccount
 */

/**
 * @typedef {object} I18n
 * @property {(msgid: string) => string} gettext
 * @property {(msgid: string, plural: string, n: number) => string} ngettext
 */

/** @type {I18n} */
export const IDENTITY_I18N = {
    gettext: s => s,
    ngettext: (s, p, n) => (n === 1 ? s : p),
};

// omp's own `status` turns to warning at 0.8 for some providers and 0.9 for
// others, so colors come from usedFraction to keep one scale across providers.
const WARNING_FRACTION = 0.8;
const ERROR_FRACTION = 0.9;

const PROVIDER_NAMES = new Map([
    ['anthropic', 'Anthropic'],
    ['openai-codex', 'OpenAI Codex'],
    ['opencode-go', 'OpenCode Go'],
]);

const SHORT_NAMES = new Map([
    ['anthropic', 'Claude'],
    ['openai-codex', 'Codex'],
    ['opencode-go', 'Go'],
]);

const PANEL_TAGS = new Map([['monthly', '1mo']]);

const LEVEL_RANK = {normal: 0, warning: 1, error: 2};

const SELECTOR_FIELDS = ['email', 'accountId', 'projectId', 'orgId'];

/**
 * @param {string} stdout
 * @returns {Snapshot}
 */
export function parseUsage(stdout) {
    const wire = parseJson(stdout);
    if (!Array.isArray(wire?.reports))
        throw new Error('no reports array');

    const ordinals = new Map();
    const accounts = wire.reports.map(report => parseAccount(report ?? {}, ordinals));
    accounts.sort(compareAccounts);
    return {generatedAt: finiteOr(wire.generatedAt, Date.now()), accounts};
}

/**
 * Parses `omp config get auth.accountPolicies --json`.
 * @param {string} stdout
 * @returns {AccountPolicy[]}
 */
export function parsePolicies(stdout) {
    const wire = parseJson(stdout);
    if (!Array.isArray(wire?.value))
        throw new Error('no value array');

    return wire.value.flatMap(entry => {
        if (typeof entry?.provider !== 'string' || typeof entry.account !== 'object' || entry.account === null)
            return [];
        const selector = Object.fromEntries(SELECTOR_FIELDS.flatMap(field => {
            const value = stringOrNull(entry.account[field]);
            return value === null ? [] : [[field, value]];
        }));
        return [{provider: entry.provider, selector, priority: finiteOrNull(entry.priority)}];
    });
}

/**
 * @param {string} stdout
 * @returns {any}
 */
function parseJson(stdout) {
    const text = stdout.trim();
    if (!text)
        throw new Error('empty stdout');
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`not JSON: ${e.message}`);
    }
}

/**
 * @param {object} report
 * @param {Map<string, number>} ordinals
 * @returns {Account}
 */
function parseAccount(report, ordinals) {
    const provider = String(report.provider ?? 'unknown');
    const ordinal = (ordinals.get(provider) ?? 0) + 1;
    ordinals.set(provider, ordinal);

    const meta = report.metadata ?? {};
    const email = stringOrNull(meta.email);
    const accountId = stringOrNull(meta.accountId);
    const limits = Array.isArray(report.limits) ? report.limits : [];
    return {
        key: `${provider}:${email ?? accountId ?? ordinal}`,
        provider,
        ordinal,
        accountId,
        orgId: stringOrNull(meta.orgId),
        org: stringOrNull(meta.orgName),
        plan: stringOrNull(meta.planType),
        email,
        resetCredits: finiteOr(report.resetCredits?.availableCount, 0),
        windows: uniqueShared(limits).flatMap(limit => parseWindow(limit) ?? []),
    };
}

/**
 * @param {object} limit
 * @returns {UsageWindow|null}
 */
function parseWindow(limit) {
    const kind = stringOrNull(limit?.scope?.windowId);
    const window = limit?.window;
    if (kind === null || !window || typeof window !== 'object')
        return null;

    return {
        id: String(limit.id ?? kind),
        kind,
        tier: stringOrNull(limit.scope.tier),
        label: labelOf(limit, window, kind),
        usedFraction: clamp01(limit.amount?.usedFraction),
        resetsAt: finiteOrNull(window.resetsAt),
    };
}

/**
 * Google Antigravity reports one quota shared by several models once per model.
 * @param {object[]} limits
 * @returns {object[]}
 */
function uniqueShared(limits) {
    const seen = new Set();
    return limits.filter(limit => {
        const group = limit?.scope?.sharedGroup;
        if (group === undefined)
            return true;
        if (seen.has(group))
            return false;
        seen.add(group);
        return true;
    });
}

/**
 * The short window label wins when the limit label only prefixes it with the
 * provider ("Claude 5 Hour"), because the provider heading already says that.
 * @param {object} limit
 * @param {object} window
 * @param {string} kind
 * @returns {string}
 */
function labelOf(limit, window, kind) {
    const windowLabel = stringOrNull(window.label);
    const limitLabel = stringOrNull(limit.label);
    if (limitLabel === null)
        return windowLabel ?? kind;
    if (windowLabel === null || !limitLabel.toLowerCase().includes(windowLabel.toLowerCase()))
        return limitLabel;
    return windowLabel;
}

/**
 * @param {Account} a
 * @param {Account} b
 * @returns {number}
 */
function compareAccounts(a, b) {
    return compareStrings(providerName(a.provider), providerName(b.provider)) ||
        compareStrings(a.email ?? '', b.email ?? '') ||
        a.ordinal - b.ordinal;
}

/** @typedef {{account: Account, policy: AccountPolicy|null}} Member */

/**
 * Accounts arrive sorted by provider name, so Map insertion order is the
 * provider display order.
 * @param {Account[]} accounts
 * @param {AccountPolicy[]} policies
 * @returns {{provider: string, members: Member[]}[]}
 */
function groupsOf(accounts, policies) {
    /** @type {Map<string, Member[]>} */
    const groups = new Map();
    for (const account of accounts) {
        const members = groups.get(account.provider) ?? [];
        members.push({account, policy: policyOf(policies, account)});
        groups.set(account.provider, members);
    }
    return [...groups].map(([provider, members]) => ({
        provider,
        members: members.sort((a, b) => (b.policy?.priority ?? 0) - (a.policy?.priority ?? 0)),
    }));
}

/**
 * omp's AccountPolicies.find(): the first policy whose set selector fields all
 * equal the account's identity. The usage JSON has no projectId, so a
 * projectId selector never matches.
 * @param {AccountPolicy[]} policies
 * @param {Account} account
 * @returns {AccountPolicy|null}
 */
function policyOf(policies, account) {
    return policies.find(policy => policy.provider === account.provider &&
        Object.entries(policy.selector).every(([field, value]) => account[field] === value)) ?? null;
}

/**
 * @param {StoreState} state
 * @param {ViewPrefs} prefs
 * @param {number} now
 * @param {I18n} [i18n]
 * @returns {View}
 */
export function renderView(state, prefs, now, i18n = IDENTITY_I18N) {
    const _ = i18n.gettext;
    const {snapshot, policies, error, inFlight} = state;
    const accounts = snapshot?.accounts ?? [];
    const groups = groupsOf(accounts, policies);
    const primary = primaryOf(groups.flatMap(g => g.members.map(m => m.account)), prefs.primaryAccount);

    let status;
    let statusLevel = 'normal';
    if (inFlight) {
        status = snapshot ? _('refreshing…') : _('loading…');
    } else if (snapshot && error) {
        status = fmt(_('update failed · last %s'), formatAge(snapshot.generatedAt, now, i18n));
        statusLevel = 'error';
    } else if (snapshot) {
        status = fmt(_('updated %s'), formatAge(snapshot.generatedAt, now, i18n));
    } else if (error) {
        status = '';
        statusLevel = 'error';
    } else {
        status = _('loading…');
    }

    let notice = null;
    if (snapshot && accounts.length === 0)
        notice = _('omp reports no provider accounts');
    else if (!snapshot && error)
        notice = describeError(error, i18n);

    const providers = notice === null ? groups.map(group => providerOf(group, primary, now, i18n)) : [];
    const flagged = notice === null ? flaggedOf(accounts, primary) : [];
    return {
        panel: panelOf(primary, state, panelAlertOf(flagged)),
        status,
        statusLevel,
        notice,
        providers,
        alerts: flagged.map(({account, window}) => alertOf(account, window, now)),
    };
}

/**
 * @param {number|null} usedFraction
 * @returns {Level}
 */
export function levelOf(usedFraction) {
    if (usedFraction === null)
        return 'normal';
    if (usedFraction >= ERROR_FRACTION)
        return 'error';
    if (usedFraction >= WARNING_FRACTION)
        return 'warning';
    return 'normal';
}

/**
 * @param {number|null} resetsAt
 * @param {number} now
 * @returns {string}
 */
export function formatRemaining(resetsAt, now) {
    if (resetsAt === null)
        return '—';
    if (resetsAt <= now)
        return 'now';

    const minutes = Math.floor((resetsAt - now) / 60_000);
    if (minutes < 1)
        return '<1m';
    if (minutes < 60)
        return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/**
 * @param {number} then
 * @param {number} now
 * @param {I18n} i18n
 * @returns {string}
 */
export function formatAge(then, now, i18n) {
    const seconds = Math.max(0, Math.floor((now - then) / 1000));
    if (seconds < 5)
        return i18n.gettext('just now');
    if (seconds < 60)
        return fmt(i18n.gettext('%s s ago'), seconds);

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return fmt(i18n.gettext('%s min ago'), minutes);

    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return fmt(i18n.gettext('%s h ago'), hours);
    return fmt(i18n.gettext('%s d ago'), Math.floor(hours / 24));
}

/**
 * @param {Account[]} accounts  in display order
 * @param {AccountKey|''} primaryAccount
 * @returns {Account|null}
 */
export function primaryOf(accounts, primaryAccount) {
    return accounts.find(a => a.key === primaryAccount) ?? accounts[0] ?? null;
}

/**
 * @param {Account} account
 * @returns {UsageWindow[]}
 */
export function panelWindowsOf(account) {
    const picked = ['5h', '7d'].flatMap(kind => {
        const candidates = account.windows.filter(w => w.kind === kind);
        return candidates.length ? [candidates.reduce(moreUsed)] : [];
    });
    return picked.length ? picked : account.windows.slice(0, 2);
}

/**
 * @param {Account} account
 * @returns {string}
 */
export function accountTitle(account) {
    const name = providerName(account.provider);
    const suffix = suffixOf(account);
    return suffix === null ? name : `${name} · ${suffix}`;
}

/**
 * @param {Account} account
 * @returns {string|null}
 */
function suffixOf(account) {
    const suffix = account.org ?? account.plan;
    return suffix && suffix.toLowerCase() !== providerName(account.provider).toLowerCase() ? suffix : null;
}

/**
 * The Shell's String.prototype.format does not exist under plain gjs.
 * @param {string} template
 * @param {...(string|number)} args
 * @returns {string}
 */
export function fmt(template, ...args) {
    let i = 0;
    return template.replace(/%s/g, () => String(args[i++]));
}

/**
 * @param {{provider: string, members: Member[]}} group
 * @param {Account|null} primary
 * @param {number} now
 * @param {I18n} i18n
 * @returns {ProviderView}
 */
function providerOf({provider, members}, primary, now, i18n) {
    const n = members.length;
    return {
        provider,
        title: providerName(provider),
        count: fmt(i18n.ngettext('%s account', '%s accounts', n), n),
        accounts: members.map(({account, policy}) => sectionOf(account, policy, account === primary, now, i18n)),
    };
}

/**
 * @param {Account} account
 * @param {AccountPolicy|null} policy
 * @param {boolean} primary
 * @param {number} now
 * @param {I18n} i18n
 * @returns {SectionView}
 */
function sectionOf(account, policy, primary, now, i18n) {
    const credits = account.resetCredits;
    const priority = policy?.priority ?? null;
    const parts = [suffixOf(account), priority === null ? null : fmt(i18n.gettext('priority %s'), priority)];
    return {
        key: account.key,
        title: account.email ?? fmt(i18n.gettext('account %s'), account.ordinal),
        subtitle: parts.filter(part => part !== null).join(' · '),
        badge: credits > 0 ? fmt(i18n.ngettext('✦ %s reset', '✦ %s resets', credits), credits) : null,
        primary,
        rows: account.windows.map(w => rowOf(w, now)),
    };
}

/**
 * @param {UsageWindow} w
 * @param {number} now
 * @returns {RowView}
 */
function rowOf(w, now) {
    return {
        label: w.tier ? `${w.label} (${titleCase(w.tier)})` : w.label,
        fraction: w.usedFraction ?? 0,
        level: levelOf(w.usedFraction),
        detail: `${percentOf(w.usedFraction)} · ${formatRemaining(w.resetsAt, now)}`,
    };
}

/**
 * @param {Account[]} accounts
 * @param {Account|null} primary
 * @returns {{account: Account, window: UsageWindow}[]}
 */
function flaggedOf(accounts, primary) {
    const shown = new Set(primary ? panelWindowsOf(primary).map(w => w.id) : []);
    return accounts
        .flatMap(account => account.windows
            .filter(w => !(account.key === primary?.key && shown.has(w.id)) && levelOf(w.usedFraction) !== 'normal')
            .map(window => ({account, window})))
        .sort((a, b) => b.window.usedFraction - a.window.usedFraction);
}

/**
 * @param {Account} account
 * @param {UsageWindow} window
 * @param {number} now
 * @returns {AlertView}
 */
function alertOf(account, window, now) {
    const {label, detail, level} = rowOf(window, now);
    return {key: account.key, title: accountTitle(account), label, detail, level};
}

/**
 * @param {{account: Account, window: UsageWindow}[]} flagged
 * @returns {PanelView['alert']}
 */
function panelAlertOf(flagged) {
    if (flagged.length === 0)
        return null;
    const [{account, window}] = flagged;
    const name = SHORT_NAMES.get(account.provider) ?? providerName(account.provider);
    const more = flagged.length > 1 ? ` +${flagged.length - 1}` : '';
    return {text: `⚠ ${name} ${panelTextOf(window)}${more}`, level: levelOf(window.usedFraction)};
}

/**
 * @param {Account|null} primary
 * @param {StoreState} state
 * @param {PanelView['alert']} alert
 * @returns {PanelView}
 */
function panelOf(primary, state, alert) {
    const stale = state.error !== null;
    if (primary === null) {
        const untried = state.snapshot === null && state.error === null;
        return {bars: [], text: untried ? '…' : '!', level: stale ? 'error' : 'normal', stale, alert};
    }

    const windows = panelWindowsOf(primary);
    const bars = windows.map(w => ({fraction: w.usedFraction ?? 0, level: levelOf(w.usedFraction)}));
    return {
        bars,
        text: windows.map(panelTextOf).join(' · ') || '!',
        level: bars.reduce((max, bar) => (LEVEL_RANK[bar.level] > LEVEL_RANK[max] ? bar.level : max), 'normal'),
        stale,
        alert,
    };
}

/** @param {UsageWindow} w @returns {string} */
function panelTextOf(w) {
    return `${PANEL_TAGS.get(w.kind) ?? w.kind} ${percentOf(w.usedFraction)}`;
}

/**
 * @param {FetchError} error
 * @param {I18n} i18n
 * @returns {string}
 */
function describeError(error, i18n) {
    const _ = i18n.gettext;
    switch (error.kind) {
    case 'missing-binary':
        return fmt(_('omp not found at %s. Set the path in Settings.'), error.path);
    case 'spawn':
        return fmt(_('Could not run %s: %s'), error.path, error.detail);
    case 'exit':
        return error.stderrHead
            ? fmt(_('omp usage failed (exit %s): %s'), error.status, error.stderrHead)
            : fmt(_('omp usage failed (exit %s)'), error.status);
    default:
        return fmt(_('omp printed something that is not usage JSON (%s)'), error.detail);
    }
}

/** @param {UsageWindow} a @param {UsageWindow} b @returns {UsageWindow} */
function moreUsed(a, b) {
    return (b.usedFraction ?? -1) > (a.usedFraction ?? -1) ? b : a;
}

/** @param {number|null} usedFraction @returns {string} */
function percentOf(usedFraction) {
    return usedFraction === null ? '?' : `${Math.round(usedFraction * 100)}%`;
}

/** @param {string} provider @returns {string} */
function providerName(provider) {
    return PROVIDER_NAMES.get(provider) ?? titleCase(provider);
}

function titleCase(id) {
    return id.split(/[-_\s]+/)
        .filter(part => part.length > 0)
        .map(part => part[0].toUpperCase() + part.slice(1))
        .join(' ');
}

/** @param {string} a @param {string} b @returns {number} */
function compareStrings(a, b) {
    if (a < b)
        return -1;
    return a > b ? 1 : 0;
}

/** @param {unknown} value @returns {string|null} */
function stringOrNull(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/** @param {unknown} value @returns {number|null} */
function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function finiteOr(value, fallback) {
    return finiteOrNull(value) ?? fallback;
}

/** @param {unknown} value @returns {number|null} */
function clamp01(value) {
    const n = finiteOrNull(value);
    return n === null ? null : Math.min(1, Math.max(0, n));
}
