/** @typedef {'normal' | 'warning' | 'error'} Level */

/** @typedef {string} AccountKey */

/**
 * @typedef {object} UsageWindow
 * @property {string} id
 * @property {string} kind
 * @property {string|null} tier
 * @property {string} label
 * @property {number|null} usedFraction
 * @property {number|null} spentUsd  OpenRouter spend in the window; null for omp quotas
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
 * @property {string|null} [problem]  why the numbers may be stale; shown in the subtitle
 * @property {SpendDay[]|null} [history]  completed UTC days of spend, drawn as the daily chart
 */

/**
 * @typedef {object} SpendDay
 * @property {string} date  UTC calendar day, YYYY-MM-DD
 * @property {number} usd
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
 * @typedef {{kind: 'http', status: number}
 *   | {kind: 'network', detail: string}
 *   | {kind: 'invalid-json', detail: string}} OpenRouterError
 */

/**
 * @typedef {object} OpenRouterState
 * @property {Account|null} account  null until the first successful read or when no key is set
 * @property {OpenRouterError|null} error
 * @property {SpendDay[]|null} history  null without a management key
 * @property {OpenRouterError|null} historyError
 */

/** @typedef {{apiKey: string|null, managementKey: string|null}} OpenRouterKeys */

/**
 * @typedef {object} StoreState
 * @property {Snapshot|null} snapshot
 * @property {AccountPolicy[]} policies
 * @property {FetchError|null} error
 * @property {boolean} inFlight
 * @property {OpenRouterState} [openRouter]
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
 * @property {string} detail
 */

/**
 * @typedef {object} ChartView
 * @property {string} label
 * @property {string} detail
 * @property {{fraction: number, today: boolean}[]} bars  oldest first, today last
 */

/**
 * @typedef {object} SectionView
 * @property {AccountKey} key
 * @property {string} title
 * @property {string} subtitle
 * @property {string|null} badge
 * @property {boolean} primary
 * @property {RowView[]} rows
 * @property {ChartView|null} chart
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
    ['openrouter', 'OpenRouter'],
]);

const SHORT_NAMES = new Map([
    ['anthropic', 'Claude'],
    ['openai-codex', 'Codex'],
    ['opencode-go', 'Go'],
]);

const PANEL_TAGS = new Map([['monthly', '1mo']]);

/**
 * Run by the login shell with -l -i, so keys exported from either the
 * profile or the rc file are found. The markers cut the values out of whatever
 * greeting or prompt escapes an interactive shell prints.
 */
export const OPENROUTER_KEY_SCRIPT =
    'printf "\\n__OMU__%s__OMU__%s__OMU__\\n" "$OPENROUTER_API_KEY" "$OPENROUTER_MANAGEMENT_KEY"';

const CHART_DAYS = 30;
const DAY_MS = 86_400_000;

// OpenRouter counts usage_daily/weekly/monthly in UTC, weeks starting Monday.
const SPEND_PERIODS = [
    {field: 'usage_daily', kind: '1d', label: 'Today', next: d => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)},
    {field: 'usage_weekly', kind: '7d', label: 'This week', next: d => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(),
        d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7))},
    {field: 'usage_monthly', kind: 'monthly', label: 'This month', next: d => Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)},
];

const BUDGET_KINDS = new Map([['daily', '1d'], ['weekly', '7d'], ['monthly', 'monthly']]);

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
 * @returns {OpenRouterKeys}  null for a variable that is unset or empty
 */
export function parseShellKeys(stdout) {
    const match = /__OMU__(.*?)__OMU__(.*?)__OMU__/.exec(stdout);
    return {apiKey: stringOrNull(match?.[1].trim()), managementKey: stringOrNull(match?.[2].trim())};
}

/**
 * Parses the body of OpenRouter's `GET /api/v1/activity`: one row per model
 * and day over the last 30 completed UTC days, summed here per day. Only
 * credits spent through OpenRouter count, as in the daily total of `/key`.
 * The API sends `date` as "YYYY-MM-DD 00:00:00" although its reference shows
 * a bare date, so only the first ten characters are read.
 * @param {string} body
 * @returns {SpendDay[]}  oldest first
 */
export function parseOpenRouterActivity(body) {
    const data = parseJson(body)?.data;
    if (!Array.isArray(data))
        throw new Error('no data array');

    const byDate = new Map();
    for (const item of data) {
        const date = stringOrNull(item?.date)?.slice(0, 10) ?? null;
        const usd = finiteOrNull(item?.usage);
        if (date === null || usd === null || !/^\d{4}-\d{2}-\d{2}$/.test(date))
            continue;
        byDate.set(date, (byDate.get(date) ?? 0) + usd);
    }
    return [...byDate].sort(([a], [b]) => compareStrings(a, b)).map(([date, usd]) => ({date, usd}));
}

/**
 * Parses the body of OpenRouter's `GET /api/v1/key`. Budgets (key limits,
 * guardrails, workspace budgets) are quotas with a fraction; the daily,
 * weekly and monthly spend has no ceiling, so it carries only an amount.
 * @param {string} body
 * @param {number} now
 * @returns {Account}
 */
export function parseOpenRouterKey(body, now) {
    const data = parseJson(body)?.data;
    if (typeof data !== 'object' || data === null)
        throw new Error('no data object');

    const budgets = Array.isArray(data.budgets) ? data.budgets : [];
    const today = new Date(now);
    return {
        key: 'openrouter:1',
        provider: 'openrouter',
        ordinal: 1,
        accountId: null,
        orgId: null,
        org: null,
        plan: null,
        email: null,
        resetCredits: 0,
        windows: [
            ...budgets.flatMap(budget => budgetWindow(budget) ?? []),
            ...SPEND_PERIODS.flatMap(period => {
                const spent = finiteOrNull(data[period.field]);
                return spent === null ? [] : [{
                    id: `openrouter:${period.field}`,
                    kind: period.kind,
                    tier: null,
                    label: period.label,
                    usedFraction: null,
                    spentUsd: spent,
                    resetsAt: period.next(today),
                }];
            }),
        ],
    };
}

/**
 * @param {object} budget
 * @returns {UsageWindow|null}
 */
function budgetWindow(budget) {
    const scope = stringOrNull(budget?.scope);
    const limit = finiteOrNull(budget?.limit_usd);
    const spent = finiteOrNull(budget?.spend_usd);
    if (scope === null || limit === null || spent === null)
        return null;

    const resetsAt = typeof budget.resets_at === 'string' ? Date.parse(budget.resets_at) : NaN;
    return {
        id: `openrouter:budget:${scope}:${budget.guardrail_id ?? budget.budget_id ?? ''}`,
        kind: BUDGET_KINDS.get(budget.reset_interval) ?? 'total',
        tier: null,
        label: titleCase(scope),
        usedFraction: limit > 0 ? clamp01(spent / limit) : 1,
        spentUsd: spent,
        resetsAt: finiteOrNull(resetsAt),
    };
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
        spentUsd: null,
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
    const ompAccounts = snapshot?.accounts ?? [];
    const accounts = [...ompAccounts, ...openRouterAccounts(state.openRouter, i18n)].sort(compareAccounts);
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
    if (snapshot && ompAccounts.length === 0)
        notice = _('omp reports no provider accounts');
    else if (!snapshot && error)
        notice = describeError(error, i18n);

    const providers = groups.map(group => providerOf(group, primary, now, i18n));
    const flagged = flaggedOf(accounts, primary);
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
 * @param {OpenRouterState|undefined} openRouter
 * @param {I18n} i18n
 * @returns {Account[]}
 */
function openRouterAccounts(openRouter, i18n) {
    if (!openRouter || (openRouter.account === null && openRouter.error === null))
        return [];
    const account = openRouter.account ?? {
        key: 'openrouter:1', provider: 'openrouter', ordinal: 1, accountId: null, orgId: null,
        org: null, plan: null, email: null, resetCredits: 0, windows: [],
    };
    const problems = [
        openRouter.error === null ? null : describeOpenRouterError(openRouter.error, 'key', i18n),
        openRouter.historyError === null ? null : describeOpenRouterError(openRouter.historyError, 'activity', i18n),
    ].filter(problem => problem !== null);
    return [{...account, problem: problems.length ? problems.join(' · ') : null, history: openRouter.history}];
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
    const parts = [
        suffixOf(account),
        priority === null ? null : fmt(i18n.gettext('priority %s'), priority),
        account.problem ?? null,
    ];
    return {
        key: account.key,
        title: account.email ?? fmt(i18n.gettext('account %s'), account.ordinal),
        subtitle: parts.filter(part => part !== null).join(' · '),
        badge: credits > 0 ? fmt(i18n.ngettext('✦ %s reset', '✦ %s resets', credits), credits) : null,
        primary,
        rows: account.windows.map(w => rowOf(w, now, largestSpendOf(account))),
        chart: account.history ? chartOf(account, account.history, now, i18n) : null,
    };
}

/**
 * @param {Account} account
 * @param {SpendDay[]} history
 * @param {number} now
 * @param {I18n} i18n
 * @returns {ChartView}
 */
function chartOf(account, history, now, i18n) {
    const today = utcDay(now);
    const spent = new Map(history.map(day => [day.date, day.usd]));
    spent.set(today, account.windows.find(w => w.kind === '1d')?.spentUsd ?? 0);
    const days = Array.from({length: CHART_DAYS}, (_, i) => utcDay(now - (CHART_DAYS - 1 - i) * DAY_MS));
    const amounts = days.map(day => spent.get(day) ?? 0);
    const peak = Math.max(0, ...amounts);
    return {
        label: fmt(i18n.gettext('Last %s days'), CHART_DAYS),
        detail: fmt(i18n.gettext('peak %s'), usdOf(peak)),
        bars: amounts.map((usd, i) => ({fraction: peak > 0 ? usd / peak : 0, today: i === CHART_DAYS - 1})),
    };
}

/** @param {number} time @returns {string} */
function utcDay(time) {
    return new Date(time).toISOString().slice(0, 10);
}

/**
 * @param {Account} account
 * @returns {number}
 */
function largestSpendOf(account) {
    return Math.max(0, ...account.windows.filter(w => w.usedFraction === null).map(w => w.spentUsd ?? 0));
}

/**
 * @param {UsageWindow} w
 * @param {number} scale
 * @returns {number}
 */
function barFractionOf(w, scale) {
    if (w.usedFraction !== null)
        return w.usedFraction;
    return w.spentUsd === null || scale <= 0 ? 0 : w.spentUsd / scale;
}

/**
 * @param {UsageWindow} w
 * @param {number} now
 * @param {number} scale
 * @returns {RowView}
 */
function rowOf(w, now, scale) {
    return {
        label: w.tier ? `${w.label} (${titleCase(w.tier)})` : w.label,
        fraction: barFractionOf(w, scale),
        level: levelOf(w.usedFraction),
        detail: `${amountOf(w)} · ${formatRemaining(w.resetsAt, now)}`,
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
    const {label, detail, level} = rowOf(window, now, largestSpendOf(account));
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
    const scale = largestSpendOf(primary);
    const bars = windows.map(w => ({fraction: barFractionOf(w, scale), level: levelOf(w.usedFraction)}));
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
    return `${PANEL_TAGS.get(w.kind) ?? w.kind} ${amountOf(w)}`;
}

/**
 * @param {OpenRouterError} error
 * @param {'key'|'activity'} request
 * @param {I18n} i18n
 * @returns {string}
 */
function describeOpenRouterError(error, request, i18n) {
    const _ = i18n.gettext;
    const activity = request === 'activity';
    switch (error.kind) {
    case 'http':
        if (error.status === 401 || error.status === 403) {
            return activity
                ? fmt(_('OpenRouter rejected the management key (HTTP %s)'), error.status)
                : fmt(_('OpenRouter rejected the API key (HTTP %s)'), error.status);
        }
        return activity
            ? fmt(_('OpenRouter activity request failed (HTTP %s)'), error.status)
            : fmt(_('OpenRouter request failed (HTTP %s)'), error.status);
    case 'network':
        return fmt(_('Could not reach OpenRouter: %s'), error.detail);
    default:
        return activity
            ? fmt(_('OpenRouter returned unexpected activity data (%s)'), error.detail)
            : fmt(_('OpenRouter returned unexpected data (%s)'), error.detail);
    }
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

/** @param {UsageWindow} w @returns {string} */
function amountOf(w) {
    if (w.usedFraction !== null)
        return `${Math.round(w.usedFraction * 100)}%`;
    return w.spentUsd === null ? '?' : usdOf(w.spentUsd);
}

/** @param {number} usd @returns {string} */
function usdOf(usd) {
    return `$${usd.toFixed(2)}`;
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
