#!/usr/bin/env -S gjs -m

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {
    parseUsage, renderView, levelOf, formatRemaining, formatAge, fmt,
    primaryOf, panelWindowsOf, accountTitle, IDENTITY_I18N,
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
    {id: 'anthropic:7d:fable', kind: '7d', tier: 'fable', label: '7 Day', usedFraction: 0.12, resetsAt: 1791874799775});
eq('parse: org and plan come from metadata',
    snapshot.accounts.map(a => [a.org, a.plan]),
    [['Acme', null], ['plus', 'plus'], ['team', 'team'], [null, 'OpenCode Go']]);
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
const fresh = {snapshot, error: null, inFlight: false};

const v = renderView(fresh, {primaryAccount: ''}, now);
eq('view: header age at generation time', v.status, 'updated just now');
eq('view: header level', v.statusLevel, 'normal');
eq('view: no notice when accounts exist', v.notice, null);
eq('view: panel text for the default primary', v.panel.text, '5h 5% · 7d 12%');
eq('view: panel bars', v.panel.bars, [{fraction: 0.05, level: 'normal'}, {fraction: 0.12, level: 'normal'}]);
eq('view: panel level and freshness', [v.panel.level, v.panel.stale], ['normal', false]);
eq('view: primary flag on the first section', v.sections.map(s => s.primary), [true, false, false, false]);
eq('view: section keys follow the accounts', v.sections.map(s => s.key), snapshot.accounts.map(a => a.key));
eq('view: section titles', v.sections.map(s => s.title),
    ['Anthropic · Acme', 'OpenAI Codex · plus', 'OpenAI Codex · team', 'OpenCode Go']);
eq('view: subtitles are emails or an ordinal', v.sections.map(s => s.subtitle),
    ['work@example.com', 'personal@example.com', 'work@example.com', 'account 1']);
eq('view: badges count reset credits', v.sections.map(s => s.badge), ['✦ 1 reset', '✦ 2 resets', '✦ 1 reset', null]);
eq('view: row labels append the tier', v.sections[0].rows.map(r => r.label), ['5 Hour', '7 Day', '7 Day (Fable)']);
eq('view: fable row detail is percent · remaining', v.sections[0].rows[2].detail, '12% · 6d7h');
eq('view: fable row fraction and level', [v.sections[0].rows[2].fraction, v.sections[0].rows[2].level], [0.12, 'normal']);
eq('view: 84% row is a warning', [v.sections[1].rows[1].detail, v.sections[1].rows[1].level], ['84% · 6d9h', 'warning']);
eq('view: 93% row is an error', [v.sections[3].rows[2].detail, v.sections[3].rows[2].level], ['93% · 6d5h', 'error']);

const goMonthlyAlert = {key: 'opencode-go:1', title: 'OpenCode Go', label: 'Monthly', detail: '93% · 6d5h', level: 'error'};
const codexWeeklyAlert = {
    key: 'openai-codex:personal@example.com', title: 'OpenAI Codex · plus', label: '7 days', detail: '84% · 6d9h', level: 'warning',
};
eq('alerts: off-panel windows above the warning line, most used first', v.alerts, [goMonthlyAlert, codexWeeklyAlert]);
eq('alerts: panel names the worst and counts the rest', v.panel.alert, {text: '⚠ Go 1mo 93% +1', level: 'error'});

eq('view: header age 46 s later', renderView(fresh, {primaryAccount: ''}, now + 46_000).status, 'updated 46 s ago');
eq('view: badge goes through ngettext',
    renderView(fresh, {primaryAccount: ''}, now, {...IDENTITY_I18N, ngettext: (s, p, n) => `${n === 1 ? s : p}!`})
        .sections.map(s => s.badge), ['✦ 1 reset!', '✦ 2 resets!', '✦ 1 reset!', null]);

const goPrimary = renderView(fresh, {primaryAccount: 'opencode-go:1'}, now);
eq('view: chosen primary drives the panel', goPrimary.panel.text, '5h 0% · 7d 0%');
eq('view: chosen primary is flagged', goPrimary.sections.map(s => s.primary), [false, false, false, true]);
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

const rowWithoutReset = renderView({
    snapshot: parseUsage('{"generatedAt":1,"reports":[{"provider":"x","limits":[{"id":"a","scope":{"windowId":"monthly"},"window":{"label":"Monthly"},"amount":{"usedFraction":0.5}}]}]}'),
    error: null,
    inFlight: false,
}, {primaryAccount: ''}, 2);
eq('view: row without reset time shows a dash', rowWithoutReset.sections[0].rows[0].detail, '50% · —');
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
    error: null,
    inFlight: false,
}, {primaryAccount: ''}, 2);
eq('alerts: ties keep account order then window order', tied.alerts.map(a => [a.key, a.label]),
    [['a:1', 'Monthly'], ['a:1', 'Daily'], ['b:1', '5 Hour']]);
eq('alerts: unknown provider uses its display name in the panel', tied.panel.alert, {text: '⚠ A 1mo 85% +2', level: 'warning'});

const untried = renderView({snapshot: null, error: null, inFlight: false}, {primaryAccount: ''}, now);
eq('view: before the first refresh', [untried.status, untried.panel.text, untried.notice], ['loading…', '…', null]);

const loading = renderView({snapshot: null, error: null, inFlight: true}, {primaryAccount: ''}, now);
eq('view: first load status', loading.status, 'loading…');
eq('view: first load panel', loading.panel, {bars: [], text: '…', level: 'normal', stale: false, alert: null});
eq('view: first load has no notice and no sections', [loading.notice, loading.sections], [null, []]);
eq('alerts: none before the first snapshot', loading.alerts, []);

const refreshing = renderView({snapshot, error: null, inFlight: true}, {primaryAccount: ''}, now);
eq('view: refresh with data says refreshing', [refreshing.status, refreshing.statusLevel], ['refreshing…', 'normal']);
eq('view: refresh keeps the sections', refreshing.sections.length, 4);

const exitError = {kind: 'exit', status: 1, stderrHead: 'AuthBrokerError: Auth broker request failed after 2 attempt(s)'};
const stale = renderView({snapshot, error: exitError, inFlight: false}, {primaryAccount: ''}, now + 12 * 60_000);
eq('view: stale status names the age', stale.status, 'update failed · last 12 min ago');
eq('view: stale status level', stale.statusLevel, 'error');
eq('view: stale keeps the sections', stale.sections.length, 4);
eq('view: stale has no notice', stale.notice, null);
eq('view: stale panel keeps the numbers and is flagged', stale.panel, {
    bars: [{fraction: 0.05, level: 'normal'}, {fraction: 0.12, level: 'normal'}],
    text: '5h 5% · 7d 12%',
    level: 'normal',
    stale: true,
    alert: {text: '⚠ Go 1mo 93% +1', level: 'error'},
});

const neverSucceeded = renderView({snapshot: null, error: exitError, inFlight: false}, {primaryAccount: ''}, now);
eq('view: first failure notice quotes the stderr head', neverSucceeded.notice,
    'omp usage failed (exit 1): AuthBrokerError: Auth broker request failed after 2 attempt(s)');
eq('view: first failure header is empty but marked', [neverSucceeded.status, neverSucceeded.statusLevel], ['', 'error']);
eq('view: first failure panel', neverSucceeded.panel, {bars: [], text: '!', level: 'error', stale: true, alert: null});
eq('alerts: none under a failure notice', neverSucceeded.alerts, []);
eq('view: killed child has no stderr to quote',
    renderView({snapshot: null, error: {kind: 'exit', status: 137, stderrHead: ''}, inFlight: false}, {primaryAccount: ''}, now).notice,
    'omp usage failed (exit 137)');

const missing = renderView({snapshot: null, error: {kind: 'missing-binary', path: '/home/u/.bun/bin/omp'}, inFlight: false},
    {primaryAccount: ''}, now);
eq('view: missing binary notice names the path', missing.notice, 'omp not found at /home/u/.bun/bin/omp. Set the path in Settings.');
eq('view: missing binary panel', missing.panel.text, '!');
eq('view: missing binary has no sections', missing.sections, []);

eq('view: spawn failure notice',
    renderView({snapshot: null, error: {kind: 'spawn', path: '/x/omp', detail: 'Permission denied'}, inFlight: false},
        {primaryAccount: ''}, now).notice, 'Could not run /x/omp: Permission denied');
eq('view: invalid json notice',
    renderView({snapshot: null, error: {kind: 'invalid-json', detail: 'no reports array'}, inFlight: false},
        {primaryAccount: ''}, now).notice, 'omp printed something that is not usage JSON (no reports array)');

const empty = renderView({snapshot: parseUsage('{"generatedAt":1,"reports":[]}'), error: null, inFlight: false}, {primaryAccount: ''}, 2);
eq('view: no accounts notice', empty.notice, 'omp reports no provider accounts');
eq('view: no accounts panel', empty.panel, {bars: [], text: '!', level: 'normal', stale: false, alert: null});
eq('alerts: none under the no-accounts notice', empty.alerts, []);
eq('view: no accounts status still shows the age', empty.status, 'updated just now');

print(failures === 0 ? `# all ${checks} checks passed` : `# ${failures} of ${checks} checks failed`);
System.exit(failures === 0 ? 0 : 1);
