#!/usr/bin/env -S gjs -m

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {
    parseUsage, parsePolicies, renderView, levelOf, formatRemaining, formatAge, fmt,
    primaryOf, panelWindowsOf, accountTitle, IDENTITY_I18N, parseShellKeys, parseOpenRouterKey, parseOpenRouterActivity,
} from '../src/model.js';

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

/** @param {string} name @param {() => unknown} f @param {RegExp} re */
function throws(name, f, re) {
    let message = null;
    try {
        f();
    } catch (e) {
        message = String(e.message);
    }
    eq(name, message !== null && re.test(message), true);
}

const here = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
const [, bytes] = Gio.File.new_for_path(`${here}/fixtures/usage.json`).load_contents(null);
const fixtureText = new TextDecoder().decode(bytes);

const snapshot = parseUsage(fixtureText);
const [anthropic, codexPlus, codexTeam, opencodeGo] = snapshot.accounts;
eq('parse: generatedAt is the CLI timestamp', snapshot.generatedAt, 1791328899152);
eq('parse: accounts sorted by provider name, email, ordinal',
    snapshot.accounts.map(a => [a.provider, a.email]), [
        ['anthropic', 'work@example.com'],
        ['openai-codex', 'personal@example.com'],
        ['openai-codex', 'work@example.com'],
        ['opencode-go', null],
    ]);
eq('parse: keys are human readable and unique', snapshot.accounts.map(a => a.key), [
    'anthropic:work@example.com',
    'openai-codex:personal@example.com',
    'openai-codex:work@example.com',
    'opencode-go:1',
]);
eq('parse: anthropic windows keep wire order and tier',
    anthropic.windows.map(w => [w.kind, w.tier]), [['5h', null], ['7d', null], ['7d', 'fable']]);
eq('parse: tiered window carries id, label, fraction and reset time',
    anthropic.windows[2],
    {id: 'anthropic:7d:fable', kind: '7d', tier: 'fable', label: '7 Day', usedFraction: 0.12, spentUsd: null, resetsAt: 1791874799775});
eq('parse: org and plan come from metadata',
    snapshot.accounts.map(a => [a.org, a.plan]),
    [['Acme', null], ['plus', 'plus'], ['team', 'team'], [null, 'OpenCode Go']]);
eq('parse: accountId and orgId come from metadata',
    snapshot.accounts.map(a => [a.accountId, a.orgId]), [
        ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'],
        ['00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000004'],
        ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003'],
        [null, null],
    ]);
eq('parse: reset credits counted', snapshot.accounts.map(a => a.resetCredits), [1, 2, 1, 0]);

throws('parse: empty stdout (omp failure mode) is rejected', () => parseUsage(''), /empty stdout/);
throws('parse: whitespace-only stdout is rejected', () => parseUsage(' \n'), /empty stdout/);
throws('parse: stack trace on stdout is rejected', () => parseUsage('Error: boom\n  at x'), /not JSON/);
throws('parse: object without reports is rejected', () => parseUsage('{}'), /no reports/);
eq('parse: reports: [] is a legal empty snapshot', parseUsage('{"generatedAt":1,"reports":[]}').accounts, []);
eq('parse: a limit without scope is skipped, not fatal',
    parseUsage('{"generatedAt":1,"reports":[{"provider":"x","limits":[{"id":"a"}]}]}').accounts[0].windows, []);
eq('parse: a limit without window is skipped, not fatal',
    parseUsage('{"generatedAt":1,"reports":[{"provider":"x","limits":[{"id":"a","scope":{"windowId":"5h"}}]}]}')
        .accounts[0].windows, []);
eq('parse: corrupt usedFraction becomes unknown, out-of-range is clamped',
    parseUsage(`{"generatedAt":1,"reports":[{"provider":"x","limits":[
        {"id":"a","scope":{"windowId":"5h"},"window":{"label":"A"},"amount":{"usedFraction":"12"}},
        {"id":"b","scope":{"windowId":"7d"},"window":{"label":"B"},"amount":{"usedFraction":1.7}}]}]}`)
        .accounts[0].windows.map(w => [w.usedFraction, w.resetsAt]), [[null, null], [1, null]]);
eq('parse: same provider twice without email gets ordinal keys',
    parseUsage('{"generatedAt":1,"reports":[{"provider":"x"},{"provider":"x"}]}').accounts.map(a => a.key),
    ['x:1', 'x:2']);

const antigravity = parseUsage(`{"generatedAt":1,"reports":[{"provider":"google-antigravity","limits":[
    {"id":"gemini-weekly","label":"Gemini","scope":{"windowId":"weekly"},"window":{"label":"Weekly"}},
    {"id":"anthropic-3p","label":"Claude & GPT (shared)","scope":{"windowId":"weekly","shared":true,"sharedGroup":"3p-weekly:weekly"},"window":{"label":"Weekly"}},
    {"id":"openai-3p","label":"Claude & GPT (shared)","scope":{"windowId":"weekly","shared":true,"sharedGroup":"3p-weekly:weekly"},"window":{"label":"Weekly"}}]}]}`)
    .accounts[0].windows;
eq('parse: a limit label that does not repeat the window label names the row',
    antigravity.map(w => w.label), ['Gemini', 'Claude & GPT (shared)']);
eq('parse: a shared quota reported per model appears once', antigravity.map(w => w.id), ['gemini-weekly', 'anthropic-3p']);

/** @param {object[]} value @returns {import('../src/model.js').AccountPolicy[]} */
function policiesOf(value) {
    return parsePolicies(JSON.stringify({key: 'auth.accountPolicies', value, type: 'array', description: ''}));
}

eq('policies: omp config shape becomes provider, selector and priority', policiesOf([
    {provider: 'openai-codex', account: {email: 'work@example.com'}, priority: 10, reservePct: 20},
    {provider: 'anthropic', account: {accountId: 'a1', orgId: 'o1'}},
]), [
    {provider: 'openai-codex', selector: {email: 'work@example.com'}, priority: 10},
    {provider: 'anthropic', selector: {accountId: 'a1', orgId: 'o1'}, priority: null},
]);
eq('policies: unset policies are an empty list', parsePolicies('{"key":"auth.accountPolicies","value":[]}'), []);
eq('policies: entries without provider or account object are skipped',
    policiesOf([{account: {email: 'a'}}, {provider: 'x', account: 'a'}, {provider: 'x', account: null}, null]), []);
throws('policies: empty stdout is rejected', () => parsePolicies(''), /empty stdout/);
throws('policies: non-JSON is rejected', () => parsePolicies('Unknown setting'), /not JSON/);
throws('policies: value that is not an array is rejected', () => parsePolicies('{"value":{}}'), /no value array/);

eq('level: below 0.8 is normal', levelOf(0.79), 'normal');
eq('level: at 0.8 is warning', levelOf(0.8), 'warning');
eq('level: at 0.9 is error', levelOf(0.9), 'error');
eq('level: unknown usage is normal', levelOf(null), 'normal');

const t0 = 1_000_000_000_000;
eq('remaining: unknown reset time', formatRemaining(null, t0), '—');
eq('remaining: in the past', formatRemaining(t0 - 1, t0), 'now');
eq('remaining: exactly now', formatRemaining(t0, t0), 'now');
eq('remaining: under a minute', formatRemaining(t0 + 59_999, t0), '<1m');
eq('remaining: one minute', formatRemaining(t0 + 60_000, t0), '1m');
eq('remaining: under an hour', formatRemaining(t0 + 59 * 60_000 + 59_000, t0), '59m');
eq('remaining: one hour', formatRemaining(t0 + 3_600_000, t0), '1h0m');
eq('remaining: under a day', formatRemaining(t0 + (2 * 60 + 54) * 60_000 + 30_000, t0), '2h54m');
eq('remaining: just under a day', formatRemaining(t0 + 86_400_000 - 1, t0), '23h59m');
eq('remaining: one day', formatRemaining(t0 + 86_400_000, t0), '1d0h');
eq('remaining: a day or more', formatRemaining(t0 + (6 * 24 + 7) * 3_600_000 + 5 * 60_000, t0), '6d7h');

eq('age: under 5 s', formatAge(t0 - 4_999, t0, IDENTITY_I18N), 'just now');
eq('age: future timestamp', formatAge(t0 + 10_000, t0, IDENTITY_I18N), 'just now');
eq('age: 5 s', formatAge(t0 - 5_000, t0, IDENTITY_I18N), '5 s ago');
eq('age: under a minute', formatAge(t0 - 59_999, t0, IDENTITY_I18N), '59 s ago');
eq('age: one minute', formatAge(t0 - 60_000, t0, IDENTITY_I18N), '1 min ago');
eq('age: under an hour', formatAge(t0 - 3_599_999, t0, IDENTITY_I18N), '59 min ago');
eq('age: one hour', formatAge(t0 - 3_600_000, t0, IDENTITY_I18N), '1 h ago');
eq('age: under a day', formatAge(t0 - 86_399_999, t0, IDENTITY_I18N), '23 h ago');
eq('age: one day', formatAge(t0 - 86_400_000, t0, IDENTITY_I18N), '1 d ago');
eq('age: goes through gettext', formatAge(t0 - 46_000, t0, {...IDENTITY_I18N, gettext: s => `[${s}]`}), '[46 s ago]');

eq('fmt: substitutes in order', fmt('%s of %s', 1, 'two'), '1 of two');

eq('title: provider and org', accountTitle(anthropic), 'Anthropic · Acme');
eq('title: provider and plan-like org', accountTitle(codexPlus), 'OpenAI Codex · plus');
eq('title: suffix equal to the provider name is dropped', accountTitle(opencodeGo), 'OpenCode Go');
eq('title: unknown provider is title-cased',
    accountTitle({provider: 'some-new_provider', org: null, plan: 'some new provider'}), 'Some New Provider');
eq('title: unknown provider keeps a distinct org',
    accountTitle({provider: 'foo', org: 'Bar', plan: null}), 'Foo · Bar');

eq('panel windows: worst 7d wins over the shared one',
    panelWindowsOf(anthropic).map(w => w.id), ['anthropic:5h', 'anthropic:7d:fable']);
eq('panel windows: only existing kinds are shown',
    panelWindowsOf({windows: [anthropic.windows[0]]}).map(w => w.id), ['anthropic:5h']);
eq('panel windows: fall back to the first two windows',
    panelWindowsOf({windows: [opencodeGo.windows[2]]}).map(w => w.kind), ['monthly']);
eq('panel windows: nothing to show', panelWindowsOf({windows: []}), []);

eq('primary: by key', primaryOf(snapshot.accounts, 'opencode-go:1').key, 'opencode-go:1');
eq('primary: falls back to first on unknown key', primaryOf(snapshot.accounts, 'nope:x').key, anthropic.key);
eq('primary: empty key selects the first account', primaryOf(snapshot.accounts, '').key, anthropic.key);
eq('primary: no accounts', primaryOf([], ''), null);

const now = snapshot.generatedAt;
const fresh = {snapshot, policies: [], error: null, inFlight: false};
/** @param {import('../src/model.js').View} view */
const accountsOf = view => view.providers.flatMap(p => p.accounts);

const v = renderView(fresh, {primaryAccount: ''}, now);
eq('view: header age at generation time', v.status, 'updated just now');
eq('view: header level', v.statusLevel, 'normal');
eq('view: no notice when accounts exist', v.notice, null);
eq('view: panel text for the default primary', v.panel.text, '5h 5% · 7d 12%');
eq('view: panel bars', v.panel.bars, [{fraction: 0.05, level: 'normal'}, {fraction: 0.12, level: 'normal'}]);
eq('view: panel level and freshness', [v.panel.level, v.panel.stale], ['normal', false]);
eq('view: primary flag on the first account', accountsOf(v).map(s => s.primary), [true, false, false, false]);
eq('view: account keys follow the accounts', accountsOf(v).map(s => s.key), snapshot.accounts.map(a => a.key));
eq('view: providers by display name', v.providers.map(p => [p.provider, p.title]),
    [['anthropic', 'Anthropic'], ['openai-codex', 'OpenAI Codex'], ['opencode-go', 'OpenCode Go']]);
eq('view: provider counts go through ngettext', v.providers.map(p => p.count), ['1 account', '2 accounts', '1 account']);
eq('view: account titles are emails or an ordinal', accountsOf(v).map(s => s.title),
    ['work@example.com', 'personal@example.com', 'work@example.com', 'account 1']);
eq('view: subtitles carry org or plan unless it repeats the provider', accountsOf(v).map(s => s.subtitle),
    ['Acme', 'plus', 'team', '']);
eq('view: badges count reset credits', accountsOf(v).map(s => s.badge), ['✦ 1 reset', '✦ 2 resets', '✦ 1 reset', null]);
eq('view: row labels append the tier', accountsOf(v)[0].rows.map(r => r.label), ['5 Hour', '7 Day', '7 Day (Fable)']);
eq('view: fable row detail is percent · remaining', accountsOf(v)[0].rows[2].detail, '12% · 6d7h');
eq('view: fable row fraction and level', [accountsOf(v)[0].rows[2].fraction, accountsOf(v)[0].rows[2].level], [0.12, 'normal']);
eq('view: 84% row is a warning', [accountsOf(v)[1].rows[1].detail, accountsOf(v)[1].rows[1].level], ['84% · 6d9h', 'warning']);
eq('view: 93% row is an error', [accountsOf(v)[3].rows[2].detail, accountsOf(v)[3].rows[2].level], ['93% · 6d5h', 'error']);

const goMonthlyAlert = {key: 'opencode-go:1', title: 'OpenCode Go', label: 'Monthly', detail: '93% · 6d5h', level: 'error'};
const codexWeeklyAlert = {
    key: 'openai-codex:personal@example.com', title: 'OpenAI Codex · plus', label: '7 days', detail: '84% · 6d9h', level: 'warning',
};
eq('alerts: off-panel windows above the warning line, most used first', v.alerts, [goMonthlyAlert, codexWeeklyAlert]);
eq('alerts: panel names the worst and counts the rest', v.panel.alert, {text: '⚠ Go 1mo 93% +1', level: 'error'});

eq('view: header age 46 s later', renderView(fresh, {primaryAccount: ''}, now + 46_000).status, 'updated 46 s ago');
eq('view: badge goes through ngettext',
    renderView(fresh, {primaryAccount: ''}, now, {...IDENTITY_I18N, ngettext: (s, p, n) => `${n === 1 ? s : p}!`})
        .providers.flatMap(p => p.accounts).map(s => s.badge), ['✦ 1 reset!', '✦ 2 resets!', '✦ 1 reset!', null]);

const goPrimary = renderView(fresh, {primaryAccount: 'opencode-go:1'}, now);
eq('view: chosen primary drives the panel', goPrimary.panel.text, '5h 0% · 7d 0%');
eq('view: chosen primary is flagged', accountsOf(goPrimary).map(s => s.primary), [false, false, false, true]);
eq('alerts: monthly is not a panel window of the Go primary', goPrimary.alerts, [goMonthlyAlert, codexWeeklyAlert]);
eq('alerts: Go primary panel alert', goPrimary.panel.alert, {text: '⚠ Go 1mo 93% +1', level: 'error'});
eq('alerts: a window already in the panel is not repeated',
    renderView(fresh, {primaryAccount: codexPlus.key}, now).alerts, [goMonthlyAlert]);
eq('view: panel level is the worst shown bar',
    renderView(fresh, {primaryAccount: codexPlus.key}, now).panel, {
        bars: [{fraction: 0.1, level: 'normal'}, {fraction: 0.84, level: 'warning'}],
        text: '5h 10% · 7d 84%',
        level: 'warning',
        stale: false,
        alert: {text: '⚠ Go 1mo 93%', level: 'error'},
    });
eq('view: unknown primary key falls back to the first account',
    renderView(fresh, {primaryAccount: 'nope:x'}, now).panel.text, '5h 5% · 7d 12%');

const workFirst = policiesOf([
    {provider: 'openai-codex', account: {email: 'work@example.com'}, priority: 10},
    {provider: 'openai-codex', account: {email: 'personal@example.com'}, priority: 1},
]);
const ranked = renderView({...fresh, policies: workFirst}, {primaryAccount: ''}, now);
const codexOf = view => view.providers.find(p => p.provider === 'openai-codex');
eq('priority: provider order is unchanged', ranked.providers.map(p => p.title), ['Anthropic', 'OpenAI Codex', 'OpenCode Go']);
eq('priority: counts', ranked.providers.map(p => p.count), ['1 account', '2 accounts', '1 account']);
eq('priority: higher priority first', codexOf(ranked).accounts.map(s => s.title), ['work@example.com', 'personal@example.com']);
eq('priority: subtitle names the matched priority', codexOf(ranked).accounts.map(s => s.subtitle),
    ['team · priority 10', 'plus · priority 1']);
eq('priority: Anthropic keeps its org and Go has no subtitle', ranked.providers.map(p => p.accounts[0].subtitle),
    ['Acme', 'team · priority 10', '']);
eq('priority: no policies fall back to the email order', codexOf(v).accounts.map(s => [s.title, s.subtitle]),
    [['personal@example.com', 'plus'], ['work@example.com', 'team']]);
eq('priority: alerts keep the provider-qualified title and order', ranked.alerts, v.alerts);

const personalFirst = renderView({...fresh, policies: policiesOf([
    {provider: 'openai-codex', account: {email: 'work@example.com'}, priority: 1},
    {provider: 'openai-codex', account: {email: 'personal@example.com'}, priority: 5},
])}, {primaryAccount: ''}, now);
eq('priority: a higher priority on personal flips the order', codexOf(personalFirst).accounts.map(s => s.title),
    ['personal@example.com', 'work@example.com']);

const firstWins = renderView({...fresh, policies: policiesOf([
    {provider: 'openai-codex', account: {orgId: '00000000-0000-4000-8000-000000000004'}, priority: 7},
    {provider: 'openai-codex', account: {email: 'personal@example.com'}, priority: 99},
    {provider: 'openai-codex', account: {email: 'work@example.com'}, priority: 3},
])}, {primaryAccount: ''}, now);
eq('priority: the first matching policy wins', codexOf(firstWins).accounts.map(s => s.subtitle),
    ['plus · priority 7', 'team · priority 3']);

const unmatchable = renderView({...fresh, policies: policiesOf([
    {provider: 'openai-codex', account: {email: 'work@example.com', projectId: 'p1'}, priority: 10},
    {provider: 'anthropic', account: {email: 'personal@example.com'}, priority: 10},
    {provider: 'openai-codex', account: {accountId: '00000000-0000-4000-8000-000000000004'}},
])}, {primaryAccount: ''}, now);
eq('priority: projectId selectors, other providers and priority-less policies do not reorder',
    codexOf(unmatchable).accounts.map(s => [s.title, s.subtitle]),
    [['personal@example.com', 'plus'], ['work@example.com', 'team']]);

const codexOnly = renderView({
    ...fresh,
    snapshot: {...snapshot, accounts: snapshot.accounts.filter(a => a.provider === 'openai-codex')},
    policies: workFirst,
}, {primaryAccount: ''}, now);
eq('priority: the default primary is the first ranked account',
    accountsOf(codexOnly).map(s => [s.title, s.primary]), [['work@example.com', true], ['personal@example.com', false]]);
eq('priority: the default primary drives the panel', codexOnly.panel.text,
    renderView(fresh, {primaryAccount: codexTeam.key}, now).panel.text);

const rowWithoutReset = renderView({
    snapshot: parseUsage('{"generatedAt":1,"reports":[{"provider":"x","limits":[{"id":"a","scope":{"windowId":"monthly"},"window":{"label":"Monthly"},"amount":{"usedFraction":0.5}}]}]}'),
    policies: [],
    error: null,
    inFlight: false,
}, {primaryAccount: ''}, 2);
eq('view: row without reset time shows a dash', accountsOf(rowWithoutReset)[0].rows[0].detail, '50% · —');
eq('view: panel falls back to the first window with its kind as tag', rowWithoutReset.panel.text, '1mo 50%');
eq('alerts: none when every window is normal', [rowWithoutReset.alerts, rowWithoutReset.panel.alert], [[], null]);

const tied = renderView({
    snapshot: parseUsage(`{"generatedAt":1,"reports":[
        {"provider":"b","limits":[{"id":"b5","scope":{"windowId":"5h"},"window":{"label":"5 Hour"},"amount":{"usedFraction":0.85}}]},
        {"provider":"a","limits":[
            {"id":"a5","scope":{"windowId":"5h"},"window":{"label":"5 Hour"},"amount":{"usedFraction":0.1}},
            {"id":"a7","scope":{"windowId":"7d"},"window":{"label":"7 Day"},"amount":{"usedFraction":0.1}},
            {"id":"am","scope":{"windowId":"monthly"},"window":{"label":"Monthly"},"amount":{"usedFraction":0.85}},
            {"id":"ad","scope":{"windowId":"daily"},"window":{"label":"Daily"},"amount":{"usedFraction":0.85}}]}]}`),
    policies: [],
    error: null,
    inFlight: false,
}, {primaryAccount: ''}, 2);
eq('alerts: ties keep account order then window order', tied.alerts.map(a => [a.key, a.label]),
    [['a:1', 'Monthly'], ['a:1', 'Daily'], ['b:1', '5 Hour']]);
eq('alerts: unknown provider uses its display name in the panel', tied.panel.alert, {text: '⚠ A 1mo 85% +2', level: 'warning'});

const untried = renderView({snapshot: null, policies: [], error: null, inFlight: false}, {primaryAccount: ''}, now);
eq('view: before the first refresh', [untried.status, untried.panel.text, untried.notice], ['loading…', '…', null]);

const loading = renderView({snapshot: null, policies: [], error: null, inFlight: true}, {primaryAccount: ''}, now);
eq('view: first load status', loading.status, 'loading…');
eq('view: first load panel', loading.panel, {bars: [], text: '…', level: 'normal', stale: false, alert: null});
eq('view: first load has no notice and no providers', [loading.notice, loading.providers], [null, []]);
eq('alerts: none before the first snapshot', loading.alerts, []);

const refreshing = renderView({...fresh, inFlight: true}, {primaryAccount: ''}, now);
eq('view: refresh with data says refreshing', [refreshing.status, refreshing.statusLevel], ['refreshing…', 'normal']);
eq('view: refresh keeps the accounts', accountsOf(refreshing).length, 4);

const exitError = {kind: 'exit', status: 1, stderrHead: 'AuthBrokerError: Auth broker request failed after 2 attempt(s)'};
const stale = renderView({...fresh, error: exitError}, {primaryAccount: ''}, now + 12 * 60_000);
eq('view: stale status names the age', stale.status, 'update failed · last 12 min ago');
eq('view: stale status level', stale.statusLevel, 'error');
eq('view: stale keeps the accounts', accountsOf(stale).length, 4);
eq('view: stale has no notice', stale.notice, null);
eq('view: stale panel keeps the numbers and is flagged', stale.panel, {
    bars: [{fraction: 0.05, level: 'normal'}, {fraction: 0.12, level: 'normal'}],
    text: '5h 5% · 7d 12%',
    level: 'normal',
    stale: true,
    alert: {text: '⚠ Go 1mo 93% +1', level: 'error'},
});

const neverSucceeded = renderView({snapshot: null, policies: [], error: exitError, inFlight: false}, {primaryAccount: ''}, now);
eq('view: first failure notice quotes the stderr head', neverSucceeded.notice,
    'omp usage failed (exit 1): AuthBrokerError: Auth broker request failed after 2 attempt(s)');
eq('view: first failure header is empty but marked', [neverSucceeded.status, neverSucceeded.statusLevel], ['', 'error']);
eq('view: first failure panel', neverSucceeded.panel, {bars: [], text: '!', level: 'error', stale: true, alert: null});
eq('alerts: none under a failure notice', neverSucceeded.alerts, []);
eq('view: killed child has no stderr to quote',
    renderView({snapshot: null, policies: [], error: {kind: 'exit', status: 137, stderrHead: ''}, inFlight: false},
        {primaryAccount: ''}, now).notice,
    'omp usage failed (exit 137)');

const missing = renderView({snapshot: null, policies: [], error: {kind: 'missing-binary', path: '/home/u/.bun/bin/omp'}, inFlight: false},
    {primaryAccount: ''}, now);
eq('view: missing binary notice names the path', missing.notice, 'omp not found at /home/u/.bun/bin/omp. Set the path in Settings.');
eq('view: missing binary panel', missing.panel.text, '!');
eq('view: missing binary has no providers', missing.providers, []);

eq('view: spawn failure notice',
    renderView({snapshot: null, policies: [], error: {kind: 'spawn', path: '/x/omp', detail: 'Permission denied'}, inFlight: false},
        {primaryAccount: ''}, now).notice, 'Could not run /x/omp: Permission denied');
eq('view: invalid json notice',
    renderView({snapshot: null, policies: [], error: {kind: 'invalid-json', detail: 'no reports array'}, inFlight: false},
        {primaryAccount: ''}, now).notice, 'omp printed something that is not usage JSON (no reports array)');

const empty = renderView({...fresh, snapshot: parseUsage('{"generatedAt":1,"reports":[]}')}, {primaryAccount: ''}, 2);
eq('view: no accounts notice', empty.notice, 'omp reports no provider accounts');
eq('view: no accounts panel', empty.panel, {bars: [], text: '!', level: 'normal', stale: false, alert: null});
eq('alerts: none under the no-accounts notice', empty.alerts, []);
eq('view: no accounts status still shows the age', empty.status, 'updated just now');

eq('shell keys: the values between the markers, around banner and prompt noise',
    parseShellKeys('Welcome!\n\x1b]0;title\x07\n__OMU__sk-or-v1-abc__OMU__sk-or-mgmt__OMU__\n% '),
    {apiKey: 'sk-or-v1-abc', managementKey: 'sk-or-mgmt'});
eq('shell keys: an unset management key leaves only the API key',
    parseShellKeys('\n__OMU__sk-or-v1-abc__OMU____OMU__\n'), {apiKey: 'sk-or-v1-abc', managementKey: null});
eq('shell keys: unset variables are no keys', parseShellKeys('\n__OMU____OMU____OMU__\n'), {apiKey: null, managementKey: null});
eq('shell keys: a shell that never ran the script is no key',
    parseShellKeys('zsh: command not found'), {apiKey: null, managementKey: null});

// The API sends dates as "YYYY-MM-DD 00:00:00" (seen live); its reference shows bare dates.
const activityBody = JSON.stringify({data: [
    {date: '2026-10-13 00:00:00', model: 'openai/gpt-5', usage: 0.16, byok_usage_inference: 9, requests: 4},
    {date: '2026-10-13', model: 'anthropic/claude', usage: 0.16, requests: 1},
    {date: '2026-09-20 00:00:00', model: 'openai/gpt-5', usage: 0.64, requests: 2},
    {date: '2026-10-12', model: 'x', usage: 'n/a'},
    {date: 'yesterday', usage: 1},
    null,
]});
eq('activity: rows are summed per UTC day whether the date carries a time or not, oldest first, malformed rows skipped',
    parseOpenRouterActivity(activityBody), [{date: '2026-09-20', usd: 0.64}, {date: '2026-10-13', usd: 0.32}]);
eq('activity: an empty month is an empty history', parseOpenRouterActivity('{"data":[]}'), []);
throws('activity: an error body is rejected', () => parseOpenRouterActivity('{"error":{"code":403}}'), /no data array/);

const orNow = Date.UTC(2026, 9, 14, 15);
const keyBody = (budgets, spend = {usage_daily: 0.04, usage_weekly: 0.08, usage_monthly: 0.16}) => JSON.stringify({data: {
    label: 'sk-or-v1-abc...xyz', limit: null, usage: 79.52, ...spend, budgets,
}});
const spendOnly = parseOpenRouterKey(keyBody([]), orNow);
eq('openrouter: one account under the openrouter provider', [spendOnly.key, spendOnly.provider], ['openrouter:1', 'openrouter']);
eq('openrouter: daily, weekly and monthly spend reset at the next UTC day, Monday and month',
    spendOnly.windows.map(w => [w.label, w.kind, w.usedFraction, w.spentUsd, new Date(w.resetsAt).toISOString()]), [
        ['Today', '1d', null, 0.04, '2026-10-15T00:00:00.000Z'],
        ['This week', '7d', null, 0.08, '2026-10-19T00:00:00.000Z'],
        ['This month', 'monthly', null, 0.16, '2026-11-01T00:00:00.000Z'],
    ]);
eq('openrouter: on a Monday the week resets the next Monday',
    new Date(parseOpenRouterKey(keyBody([]), Date.UTC(2026, 9, 12, 1)).windows[1].resetsAt).toISOString(),
    '2026-10-19T00:00:00.000Z');

const withLimit = parseOpenRouterKey(keyBody([
    {scope: 'key_limit', limit_usd: 50, spend_usd: 46, reset_interval: 'weekly', resets_at: '2026-10-19T00:00:00.000Z'},
    {scope: 'workspace', budget_id: 'b1', limit_usd: 0, spend_usd: 0, reset_interval: null, resets_at: null},
    {scope: 'member', limit_usd: 'lots'},
]), orNow);
eq('openrouter: budgets come first as quotas with fraction, reset time and spend',
    withLimit.windows.slice(0, 2).map(w => [w.id, w.label, w.kind, w.usedFraction, w.spentUsd, w.resetsAt]), [
        ['openrouter:budget:key_limit:', 'Key Limit', '7d', 0.92, 46, Date.UTC(2026, 9, 19)],
        ['openrouter:budget:workspace:b1', 'Workspace', 'total', 1, 0, null],
    ]);
eq('openrouter: a budget without numbers is skipped', withLimit.windows.length, 5);
throws('openrouter: an error body is rejected', () => parseOpenRouterKey('{"error":{"code":401}}', orNow), /no data object/);
throws('openrouter: HTML is rejected', () => parseOpenRouterKey('<html>', orNow), /not JSON/);

const orState = (account, error = null, history = null, historyError = null) =>
    ({...fresh, openRouter: {account, error, history, historyError}});
const orOf = view => view.providers.find(p => p.provider === 'openrouter');

eq('openrouter view: no key leaves OpenRouter out of the menu',
    orOf(renderView(orState(null), {primaryAccount: ''}, orNow)), undefined);
const orView = renderView(orState(spendOnly), {primaryAccount: ''}, orNow);
eq('openrouter view: providers stay in display-name order',
    orView.providers.map(p => p.title), ['Anthropic', 'OpenAI Codex', 'OpenCode Go', 'OpenRouter']);
eq('openrouter view: spend bars are drawn against the month and show dollars with the time to reset',
    orOf(orView).accounts[0].rows, [
        {label: 'Today', fraction: 0.25, level: 'normal', detail: '$0.04 · 9h0m'},
        {label: 'This week', fraction: 0.5, level: 'normal', detail: '$0.08 · 4d9h'},
        {label: 'This month', fraction: 1, level: 'normal', detail: '$0.16 · 17d9h'},
    ]);
eq('openrouter view: the default primary stays the first omp account', orView.panel.text, '5h 5% · 7d 12%');
eq('openrouter view: spend never raises an alert', orView.alerts.map(a => a.key), v.alerts.map(a => a.key));
const orPrimary = renderView(orState(spendOnly), {primaryAccount: 'openrouter:1'}, orNow).panel;
eq('openrouter view: as primary the panel shows the weekly spend and its share of the month',
    [orPrimary.bars, orPrimary.text, orPrimary.level], [[{fraction: 0.5, level: 'normal'}], '7d $0.08', 'normal']);

const weekAboveMonth = parseOpenRouterKey(keyBody([], {usage_daily: 0.04, usage_weekly: 0.32, usage_monthly: 0.16}), orNow);
eq('openrouter view: the largest window sets the scale, even a week holding the previous month above the month',
    orOf(renderView(orState(weekAboveMonth), {primaryAccount: ''}, orNow)).accounts[0].rows.map(r => r.fraction), [0.125, 1, 0.5]);
eq('openrouter view: nothing spent draws empty bars',
    orOf(renderView(orState(parseOpenRouterKey(keyBody([], {usage_daily: 0, usage_weekly: 0, usage_monthly: 0}), orNow)),
        {primaryAccount: ''}, orNow)).accounts[0].rows.map(r => [r.fraction, r.detail]),
    [[0, '$0.00 · 9h0m'], [0, '$0.00 · 4d9h'], [0, '$0.00 · 17d9h']]);

const limited = renderView(orState(withLimit), {primaryAccount: ''}, orNow);
eq('openrouter view: a budget row has a bar and a level',
    orOf(limited).accounts[0].rows[0], {label: 'Key Limit', fraction: 0.92, level: 'error', detail: '92% · 4d9h'});
eq('openrouter view: spent budgets are alerts, most used first',
    limited.alerts.map(a => [a.key, a.label, a.detail]).filter(([key]) => key === 'openrouter:1'),
    [['openrouter:1', 'Workspace', '100% · —'], ['openrouter:1', 'Key Limit', '92% · 4d9h']]);

const rejected = renderView(orState(spendOnly, {kind: 'http', status: 401}), {primaryAccount: ''}, orNow);
eq('openrouter view: a failure keeps the last rows', orOf(rejected).accounts[0].rows.length, 3);
eq('openrouter view: a rejected key is named in the subtitle',
    orOf(rejected).accounts[0].subtitle, 'OpenRouter rejected the API key (HTTP 401)');
eq('openrouter view: an OpenRouter failure does not mark the omp status or panel',
    [rejected.statusLevel, rejected.panel.stale], ['normal', false]);
eq('openrouter view: a first failure still shows the section with the reason',
    orOf(renderView(orState(null, {kind: 'network', detail: 'Name resolution failed'}), {primaryAccount: ''}, orNow))
        .accounts.map(s => [s.title, s.subtitle, s.rows]),
    [['account 1', 'Could not reach OpenRouter: Name resolution failed', []]]);
eq('openrouter view: other failures',
    [{kind: 'http', status: 500}, {kind: 'invalid-json', detail: 'no data object'}]
        .map(error => orOf(renderView(orState(null, error), {primaryAccount: ''}, orNow)).accounts[0].subtitle),
    ['OpenRouter request failed (HTTP 500)', 'OpenRouter returned unexpected data (no data object)']);

eq('chart: without a management key there is no chart', orOf(orView).accounts[0].chart, null);
const charted = orOf(renderView(orState(spendOnly, null, parseOpenRouterActivity(activityBody)), {primaryAccount: ''}, orNow))
    .accounts[0].chart;
eq('chart: thirty bars ending today, scaled to the peak day', [charted.label, charted.detail, charted.bars.length],
    ['Last 30 days', 'peak $0.64', 30]);
eq('chart: days outside the window are dropped and unmentioned days are empty',
    charted.bars.map((bar, i) => [bar.fraction, bar.today]).filter(([fraction]) => fraction > 0),
    [[1, false], [0.5, false], [0.0625, true]]);
eq('chart: the peak day sits 24 days before today', charted.bars.findIndex(bar => bar.fraction === 1), 29 - 24);
eq('chart: only the last bar is today', charted.bars.map(bar => bar.today).lastIndexOf(true), 29);
eq('chart: today comes from the daily total, so an empty history makes today the peak',
    orOf(renderView(orState(spendOnly, null, []), {primaryAccount: ''}, orNow)).accounts[0].chart.bars.map(bar => bar.fraction).slice(-2),
    [0, 1]);
eq('chart: nothing spent at all draws empty bars under a zero peak',
    (() => {
        const quiet = parseOpenRouterKey(keyBody([], {usage_daily: 0, usage_weekly: 0, usage_monthly: 0}), orNow);
        const chart = orOf(renderView(orState(quiet, null, []), {primaryAccount: ''}, orNow)).accounts[0].chart;
        return [chart.detail, chart.bars.every(bar => bar.fraction === 0)];
    })(), ['peak $0.00', true]);
eq('chart: omp accounts never have one', renderView(fresh, {primaryAccount: ''}, orNow).providers.flatMap(p => p.accounts).map(s => s.chart),
    [null, null, null, null]);

const historyDown = orOf(renderView(orState(spendOnly, null, parseOpenRouterActivity(activityBody), {kind: 'http', status: 401}),
    {primaryAccount: ''}, orNow)).accounts[0];
eq('chart: a rejected management key is named and the last history stays drawn',
    [historyDown.subtitle, historyDown.chart.detail], ['OpenRouter rejected the management key (HTTP 401)', 'peak $0.64']);
eq('chart: both failures are listed',
    orOf(renderView(orState(spendOnly, {kind: 'http', status: 500}, [], {kind: 'http', status: 500}), {primaryAccount: ''}, orNow))
        .accounts[0].subtitle,
    'OpenRouter request failed (HTTP 500) · OpenRouter activity request failed (HTTP 500)');
eq('chart: unexpected activity data is named',
    orOf(renderView(orState(spendOnly, null, null, {kind: 'invalid-json', detail: 'no data array'}), {primaryAccount: ''}, orNow))
        .accounts[0].subtitle,
    'OpenRouter returned unexpected activity data (no data array)');

const ompDown = renderView({snapshot: null, policies: [], error: exitError, inFlight: false,
    openRouter: {account: spendOnly, error: null, history: null, historyError: null}},
    {primaryAccount: ''}, orNow);
eq('openrouter view: OpenRouter stays visible under an omp failure notice',
    [ompDown.notice !== null, ompDown.providers.map(p => p.provider)], [true, ['openrouter']]);

print(failures === 0 ? `# all ${checks} checks passed` : `# ${failures} of ${checks} checks failed`);
System.exit(failures === 0 ? 0 : 1);
