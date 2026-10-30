// PMO dashboard: reads the four Jira reports from this server (read-only towards
// Jira) and lets you give feedback on follow-ups and edit tracked features.
// All Jira text is inserted as text, never as HTML.
'use strict';

const REPORTS = ['scrum', 'releases', 'features', 'prod'];
const state = { data: {}, errors: {}, loading: new Set() };

// ─── tiny DOM helpers ────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.setAttribute('style', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
// replaceChildren() would print a missing (null) part as the text "null".
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
const link = (i) => (safeUrl(i?.url) ? h('a', { href: i.url, target: '_blank', rel: 'noopener' }, i.key) : h('span', {}, i?.key ?? ''));
const pct = (n) => `${Math.round(n ?? 0)}%`;
const meter = (value, cls = '') => h('div', { class: `meter ${cls}`, role: 'img', 'aria-label': pct(value) }, h('span', { style: `width:${Math.max(0, Math.min(100, value ?? 0))}%` }));
const chip = (text, tone = '') => h('span', { class: `chip ${tone}` }, text);
const card = (title, ...kids) => h('div', { class: 'card' }, title ? h('h2', {}, title) : null, ...kids);
const sectionTitle = (text, ...extra) => h('div', { class: 'section-title' }, h('h2', {}, text), ...extra);
const HEALTH_TONE = { 'off track': 'red', blocked: 'red', 'at risk': 'amber', 'too early': 'blue', 'on track': 'green', complete: 'green', 'all work done': 'green', 'in final review / QA': 'blue', 'in progress': '' };
const healthChip = (s) => chip(s, HEALTH_TONE[s] ?? '');
const PHASE_COLORS = { todo: '#9aa5b3', blocked: 'var(--red)', inProgress: 'var(--accent)', review: 'var(--qa)', done: 'var(--green)' };
const PHASE_LABEL = { todo: 'To do', blocked: 'Blocked', inProgress: 'In progress', review: 'Review / QA', done: 'Done' };

function phaseStack(byPhase, key = (v) => v) {
  const entries = Object.entries(byPhase).map(([p, v]) => [p, key(v)]).filter(([, n]) => n > 0);
  const total = entries.reduce((s, [, n]) => s + n, 0) || 1;
  return h('div', {},
    h('div', { class: 'stack', role: 'img', 'aria-label': entries.map(([p, n]) => `${PHASE_LABEL[p]} ${n}`).join(', ') },
      entries.map(([p, n]) => h('span', { style: `width:${(n / total) * 100}%;background:${PHASE_COLORS[p]}`, title: `${PHASE_LABEL[p]}: ${n}` }))),
    h('div', { class: 'legend' }, entries.map(([p, n]) => h('span', {}, h('i', { style: `background:${PHASE_COLORS[p]}` }), `${PHASE_LABEL[p]} ${n}`))));
}

function issueList(items, render, { limit = 8, empty = 'None' } = {}) {
  if (!items?.length) return h('p', { class: 'muted' }, empty);
  const shown = items.slice(0, limit).map((i) => h('li', {}, render(i)));
  const rest = items.slice(limit).map((i) => h('li', {}, render(i)));
  return h('div', {},
    h('ul', { class: 'list' }, shown),
    rest.length ? h('details', {}, h('summary', {}, `Show ${rest.length} more`), h('ul', { class: 'list' }, rest)) : null);
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── data ────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: opts.body ? { 'Content-Type': 'application/json' } : {}, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function load(fresh = false) {
  document.getElementById('refresh').disabled = true;
  document.getElementById('asof').textContent = fresh ? 'Reading Jira…' : 'Loading…';
  await Promise.all(REPORTS.map(async (name) => {
    state.loading.add(name);
    renderAll();
    try {
      state.data[name] = await api(`/reports/${name}${fresh ? '?fresh=1' : ''}`);
      delete state.errors[name];
    } catch (err) {
      state.errors[name] = err.message;
    } finally {
      state.loading.delete(name);
      renderAll();
    }
  }));
  const times = REPORTS.map((n) => state.data[n]?.asOf).filter(Boolean).sort();
  document.getElementById('asof').textContent = times.length ? `Jira data as of ${new Date(times[0]).toLocaleString()}` : 'No data';
  document.getElementById('refresh').disabled = false;
}

async function giveFeedback(ref, verdict) {
  const note = verdict === 'clear' ? null : prompt(`Optional note for "${verdict}":`) ?? undefined;
  if (note === undefined) return; // cancelled
  try {
    await api(`/risks/${encodeURIComponent(ref)}`, { method: 'POST', body: JSON.stringify({ verdict, note: note || null }) });
    toast(verdict === 'clear' ? 'Verdict cleared' : `Marked ${verdict}. It takes effect on the next refresh.`);
    markLocal(ref, verdict);
  } catch (err) {
    toast(`Could not save: ${err.message}`);
  }
}
const verdicts = new Map();
function markLocal(ref, verdict) { verdicts.set(ref, verdict === 'clear' ? null : verdict); renderAll(); }

// ─── shared bits ─────────────────────────────────────────────────────────────
function followUpItem(f, source) {
  const v = verdicts.has(f.ref) ? verdicts.get(f.ref) : null;
  return h('div', { class: 'fu' },
    h('div', { class: 'txt' },
      f.status === 'new' ? chip('new', 'blue') : f.status === 'changed' ? chip('changed', 'amber') : null, ' ',
      f.text,
      f.note ? h('div', { class: 'why' }, f.note) : null,
      h('div', { class: 'tag' }, [source && `${source} · `, `ref ${f.ref ?? '—'}`, f.why?.length ? ` · ranked by ${f.why.join(', ')}` : ''].filter(Boolean).join(''),
        v ? h('span', {}, ' · ', chip(`you: ${v}`, v === 'valid' ? 'green' : v === 'dismissed' ? '' : 'blue')) : null)),
    f.ref ? h('div', { class: 'acts' },
      h('button', { onclick: () => giveFeedback(f.ref, 'valid'), title: 'Keep showing it, ranked higher' }, 'Valid'),
      h('button', { onclick: () => giveFeedback(f.ref, 'dismissed'), title: 'Hide it until the facts change' }, 'Dismiss'),
      h('button', { onclick: () => giveFeedback(f.ref, 'resolved'), title: 'Handled; flag it if Jira still shows it' }, 'Resolved'),
      v ? h('button', { onclick: () => giveFeedback(f.ref, 'clear'), title: 'Forget the verdict' }, 'Undo') : null) : null);
}

function followUpsBlock(list, learning, source, { limit = 6 } = {}) {
  return h('div', { class: 'inferred' },
    h('p', { class: 'fact-note' }, 'Recommended follow-ups — rule-based inferences, not Jira facts.'),
    issueList(list, (f) => followUpItem(f, source), { limit, empty: 'Nothing needs your attention' }),
    learning?.unchanged?.length ? h('details', {}, h('summary', {}, `${learning.unchanged.length} unchanged since the last report`),
      h('ul', { class: 'list' }, learning.unchanged.map((f) => h('li', {}, followUpItem(f, source))))) : null,
    learning?.suppressed?.length ? h('p', { class: 'why' }, `${learning.suppressed.length} hidden because you dismissed them and nothing changed.`) : null,
    learning?.penalised?.length ? h('p', { class: 'why' }, `Ranked lower because you usually dismiss them: ${learning.penalised.join(', ')}.`) : null);
}

function status(name, title) {
  if (state.errors[name]) return card(title, h('div', { class: 'err' }, state.errors[name]));
  if (!state.data[name]) return card(title, h('p', { class: 'loading' }, 'Loading from Jira…'));
  return null;
}
const warnings = (rep) => (rep?.warnings?.length ? h('div', { class: 'card', style: 'margin-bottom:12px' }, rep.warnings.map((w) => h('div', { class: 'why' }, `⚠️ ${w}`))) : null);
const recurringBlock = (rep) => (rep?.recurring?.length ? card('🔁 Recurring blockers', issueList(rep.recurring, (r) => h('span', {}, r.key, ' — ', r.episodes > 1 ? `blocked ${r.episodes} times` : `blocked ${r.blockedDays} days`, r.current ? ' (blocked now)' : ''))) : null);

// ─── Overview ────────────────────────────────────────────────────────────────
function renderOverview() {
  const el = document.getElementById('overview');
  const s = state.data.scrum?.sprints?.[0];
  const r = state.data.releases;
  const f = state.data.features;
  const p = state.data.prod;
  const all = allFollowUps().slice(0, 8);
  fill(el, 
    h('div', { class: 'grid' },
      status('scrum', 'Sprint') ?? card('Sprint',
        s ? [h('h3', {}, s.name), h('div', { class: 'row' }, h('span', { class: 'big' }, pct(s.donePct.points || s.donePct.issues)), h('span', { class: 'sub' }, `done · day ${s.daysElapsed} of ${s.daysTotal}`), healthChip(s.health.status)),
          phaseStack(s.byPhase, (v) => v.issues),
          h('div', { class: 'sub' }, `${s.totals.issues} issues · ${s.blockers.length} blockers · ${s.atRisk.length} at risk`)] : h('p', { class: 'muted' }, 'No active sprint')),
      status('releases', 'Releases') ?? card('Releases',
        h('div', { class: 'row' }, h('span', { class: 'big' }, r.totals.active), h('span', { class: 'sub' }, 'active releases')),
        h('div', { class: 'row' }, chip(`${r.totals.datePassed} past target`, r.totals.datePassed ? 'red' : ''), chip(`${r.totals.approaching} due soon`, r.totals.approaching ? 'amber' : ''), chip(`${r.totals.noDate} no date`)),
        h('div', { class: 'sub', style: 'margin-top:6px' }, `${r.active.filter((x) => x.blocked.length).length} with blocked work · ${r.totals.complete} done but not marked released`)),
      status('prod', 'Production') ?? card('Production issues',
        h('div', { class: 'row' }, h('span', { class: 'big' }, p.totals.open), h('span', { class: 'sub' }, `open · ${p.totals.withEngineering} with engineering, ${p.totals.waiting} waiting`)),
        h('div', { class: 'row' }, chip(`${p.totals.urgentWithEngineering} crit/high with eng.`, p.totals.urgentWithEngineering ? 'red' : ''), chip(`${p.totals.blocked} blocked`, p.totals.blocked ? 'amber' : ''), chip(`${p.totals.longWait} waiting 30+ d`)),
        h('div', { class: 'sub', style: 'margin-top:6px' }, `Last 7 days: ${p.totals.new} new · ${p.totals.resolved} resolved`))),
    sectionTitle('Features'),
    status('features', 'Features') ?? h('div', { class: 'grid' }, f.features.map(featureSummaryCard)),
    sectionTitle('Top follow-ups', h('span', { class: 'sub' }, 'from all reports, highest score first')),
    card(null, all.length ? h('ul', { class: 'list' }, all.map(([fu, src]) => h('li', {}, followUpItem(fu, src)))) : h('p', { class: 'muted' }, REPORTS.some((n) => state.loading.has(n)) ? 'Loading…' : 'Nothing needs your attention')));
}

function featureSummaryCard(x) {
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, link(x), healthChip(x.health.status)),
    h('h3', {}, x.summary),
    h('div', { class: 'sub' }, `Dev ${pct(x.dev.pct)}`), meter(x.dev.pct, 'dev'),
    h('div', { class: 'sub' }, `QA ${pct(x.qa.pct)}`), meter(x.qa.pct, 'qa'),
    h('div', { class: 'sub' }, x.timeline.estimate ? `Estimated finish ~${x.timeline.estimate.finish} (inferred)` : `No finish estimate — ${x.timeline.reason}`));
}

function allFollowUps() {
  const out = [];
  const s = state.data.scrum;
  for (const sp of s?.sprints ?? []) for (const f of sp.followUps ?? []) out.push([f, 'Sprint']);
  for (const [name, label] of [['releases', 'Releases'], ['features', 'Features'], ['prod', 'Production']]) {
    for (const f of state.data[name]?.followUps ?? []) out.push([f, label]);
  }
  return out.sort((a, b) => (b[0].score ?? 0) - (a[0].score ?? 0));
}

// ─── Sprint ──────────────────────────────────────────────────────────────────
function renderScrum() {
  const el = document.getElementById('scrum');
  const st = status('scrum', 'Sprint');
  if (st) return fill(el, st);
  const rep = state.data.scrum;
  fill(el, warnings(rep), ...rep.sprints.map((s) => h('div', {},
    sectionTitle(s.name, healthChip(s.health.status), h('span', { class: 'sub' }, `${s.start?.slice(0, 10)} → ${s.end?.slice(0, 10)} · day ${s.daysElapsed} of ${s.daysTotal}`)),
    h('div', { class: 'grid' },
      card('Progress (Jira)',
        h('div', { class: 'row' }, h('span', { class: 'big' }, pct(s.donePct.points)), h('span', { class: 'sub' }, `of ${s.totals.points} pts done · ${pct(s.donePct.issues)} of ${s.totals.issues} issues`)),
        phaseStack(s.byPhase, (v) => v.issues),
        h('div', { class: 'sub' }, `${s.carryover.open} carried over · ${s.totals.unestimated} without points`)),
      card('Health (inferred)', h('p', {}, healthChip(s.health.status), ' ', s.health.reason))),
    h('div', { style: 'margin-top:12px' }, card('By component', h('div', { class: 'scroll' }, h('table', {},
      h('tr', {}, h('th', {}, 'Component'), h('th', {}, 'Progress'), h('th', {}, 'In progress'), h('th', {}, 'To do'), h('th', {}, 'Blocked')),
      s.components.map((c) => h('tr', {}, h('td', {}, c.name), h('td', { style: 'min-width:140px' }, `${c.done}/${c.issues} done (${c.donePct}%)`, meter(c.donePct)), h('td', {}, c.inProgress), h('td', {}, c.todo), h('td', {}, c.blocked || ''))))))),
    h('div', { class: 'grid', style: 'margin-top:12px' },
      card(`Blockers (${s.blockers.length})`, issueList(s.blockers, (b) => h('span', {}, link(b), ' ', b.summary, h('div', { class: 'why' }, `${b.owner ?? 'no owner'} — ${b.why.join('; ')}`)))),
      card(`At risk (${s.atRisk.length}, inferred)`, issueList(s.atRisk, (i) => h('span', {}, link(i), ' ', i.summary, h('div', { class: 'why' }, i.reasons.join('; '))))),
      s.changes ? card('Since last report', changesList(s.changes)) : null),
    h('div', { class: 'grid', style: 'margin-top:12px' },
      card(`In progress (${s.inProgress.length})`, issueList(s.inProgress, (i) => h('span', {}, link(i), ' ', i.summary, h('div', { class: 'why' }, `${i.status} — ${i.owner ?? 'no owner'}`)))),
      card(`Not started (${s.remaining.filter((i) => i.phase === 'todo').length})`, issueList(s.remaining.filter((i) => i.phase === 'todo'), (i) => h('span', {}, link(i), ' ', i.summary, h('div', { class: 'why' }, i.owner ?? 'no owner')))),
      card(`Completed (${s.completed.length})`, issueList(s.completed, (i) => h('span', {}, link(i), ' ', i.summary)))),
    sectionTitle('Follow-ups'),
    card(null, followUpsBlock(s.followUps, s.learning, 'Sprint')))), recurringBlock(rep));
}

function changesList(c) {
  const rows = [
    c.newlyDone?.length && `Done: ${c.newlyDone.join(', ')}`,
    c.newlyBlocked?.length && `Newly blocked: ${c.newlyBlocked.join(', ')}`,
    c.moved?.filter((m) => m.backwards).length && `↩ Moved backwards: ${c.moved.filter((m) => m.backwards).map((m) => `${m.key} ${PHASE_LABEL[m.from]} → ${PHASE_LABEL[m.to]}`).join('; ')}`,
    c.added?.length && `Added: ${c.added.join(', ')}`,
    c.removed?.length && `Removed: ${c.removed.join(', ')}`,
  ].filter(Boolean);
  return rows.length ? h('ul', { class: 'list' }, rows.map((r) => h('li', {}, r))) : h('p', { class: 'muted' }, 'No changes');
}

// ─── Releases ────────────────────────────────────────────────────────────────
function renderReleases() {
  const el = document.getElementById('releases');
  const st = status('releases', 'Releases');
  if (st) return fill(el, st);
  const rep = state.data.releases;
  const dateText = (x) => (x.dateStatus === 'no date' ? 'no target date' : x.dateStatus === 'date passed' ? `target ${x.releaseDate} · ${-x.daysToTarget} d past` : `target ${x.releaseDate} · in ${x.daysToTarget} d`);
  fill(el, warnings(rep),
    h('p', { class: 'fact-note' }, `Tracking versions starting with ${rep.prefixes.join(', ') || 'anything'}${rep.untrackedVersions ? ` (${rep.untrackedVersions} others not shown)` : ''}. Release readiness counts every issue tagged with the version, whichever sprint it is in.`),
    card(null, h('div', { class: 'scroll' }, h('table', {},
      h('tr', {}, h('th', {}, 'Release'), h('th', {}, 'Target'), h('th', {}, 'Progress'), h('th', {}, 'Open'), h('th', {}, 'Blocked'), h('th', {}, 'Bugs'), h('th', {}, 'Readiness (inferred)')),
      rep.active.map((x) => h('tr', {},
        h('td', {}, h('strong', {}, x.name), x.bucket ? h('div', { class: 'why' }, 'placeholder version') : null),
        h('td', {}, x.dateStatus === 'date passed' ? chip(dateText(x), 'red') : x.dateStatus === 'due soon' ? chip(dateText(x), 'amber') : h('span', { class: 'sub' }, dateText(x))),
        h('td', { style: 'min-width:120px' }, `${x.done}/${x.total} (${x.donePct}%)`, meter(x.donePct)),
        h('td', {}, x.open, x.notInActiveSprint ? h('div', { class: 'why' }, `${x.notInActiveSprint} not in sprint`) : null),
        h('td', {}, x.blocked.length ? h('details', {}, h('summary', {}, String(x.blocked.length)), x.blocked.map((b) => h('div', { class: 'why' }, link(b), ` ${b.why.join('; ')}`))) : ''),
        h('td', {}, x.bugs.length ? `${x.bugs.length}${x.urgentBugs.length ? ` (${x.urgentBugs.length} high)` : ''}` : ''),
        h('td', {}, healthChip(x.readiness.status), x.risks.length ? h('div', { class: 'why' }, x.risks.join('; ')) : null)))))),
    h('div', { class: 'grid', style: 'margin-top:12px' },
      card(`Done, not marked released (${rep.complete.length})`, h('p', { class: 'sub' }, rep.complete.map((x) => x.name).join(', ') || 'None')),
      card(`Dormant (${rep.dormant.length})`, h('p', { class: 'sub' }, rep.dormant.map((x) => `${x.name} (${x.open} open, idle ${x.idleDays} d)`).join(', ') || 'None'))),
    sectionTitle('Actions and decisions'),
    card(null, followUpsBlock(rep.followUps, rep.learning, 'Releases')), recurringBlock(rep));
}

// ─── Features ────────────────────────────────────────────────────────────────
function renderFeatures() {
  const el = document.getElementById('features');
  const st = status('features', 'Features');
  if (st) return fill(el, st, registryCard());
  const rep = state.data.features;
  fill(el, warnings(rep), h('div', { class: 'grid' }, rep.features.map(featureSummaryCard)),
    ...rep.features.map((x) => h('div', {},
      sectionTitle(`${x.key} — ${x.summary}`, healthChip(x.health.status)),
      h('div', { class: 'grid' },
        card('Dev and QA progress (Jira)',
          h('div', { class: 'sub' }, `Dev ${pct(x.dev.pct)} by ${x.dev.basis} · ${x.dev.issuesComplete}/${x.dev.issues} dev-complete · ${x.dev.hours.remaining} h left`), meter(x.dev.pct, 'dev'),
          h('div', { class: 'sub' }, `QA ${pct(x.qa.pct)} by ${x.qa.basis} · ${x.qa.issuesComplete}/${x.qa.issues} QA-complete · ${x.qa.hours.remaining} h left`), meter(x.qa.pct, 'qa'),
          h('div', { class: 'why' }, `${x.totals.done}/${x.totals.issues} issues done · ${x.totals.epicsDone}/${x.totals.epics} epics closed · ${x.totals.openBugs} open bugs · ${x.totals.blocked} blocked`)),
        card('Estimated finish (inferred)', x.timeline.estimate
          ? [h('div', { class: 'big' }, `~${x.timeline.estimate.finish}`), h('div', { class: 'sub' }, `${x.timeline.estimate.workingDays} working days · dev ~${x.timeline.estimate.devDays} d, then QA ~${x.timeline.estimate.qaAfterDevDays} d`),
            x.timeline.busiest ? h('div', { class: 'why' }, `Busiest: ${x.timeline.busiest.name} (${x.timeline.busiest.role}, ${x.timeline.busiest.hours} h)`) : null,
            h('div', { class: 'why' }, `Assumes ${x.timeline.assumes}.`)]
          : h('p', { class: 'muted' }, `Not estimated — ${x.timeline.reason}`)),
        card('Who holds the remaining hours (FYI)',
          h('div', { class: 'sub' }, 'Developers'), h('div', { class: 'why' }, x.people.dev.map((p) => `${p.name ?? 'not assigned'} ${p.hours} h (${p.issues})`).join(', ') || '—'),
          h('div', { class: 'sub', style: 'margin-top:6px' }, 'QA'), h('div', { class: 'why' }, x.people.qa.map((p) => `${p.name ?? 'not assigned'} ${p.hours} h (${p.issues})`).join(', ') || '—'))),
      card(`Epics (${x.epics.length})`, h('div', { class: 'scroll' }, h('table', {},
        h('tr', {}, h('th', {}, 'Epic'), h('th', {}, 'Status'), h('th', {}, 'Done'), h('th', {}, 'Due'), h('th', {}, 'Flags')),
        x.epics.map((e) => h('tr', {}, h('td', {}, link(e), ' ', e.summary), h('td', {}, e.status), h('td', { style: 'min-width:110px' }, `${e.total - e.open}/${e.total}`, meter(e.donePct)), h('td', {}, e.due?.slice(0, 10) ?? ''), h('td', { class: 'why' }, e.flags.join('; '))))))),
      h('div', { class: 'grid', style: 'margin-top:12px' },
        card(`Blocked (${x.blockers.length})`, issueList(x.blockers, (b) => h('span', {}, link(b), ' ', b.summary, h('div', { class: 'why' }, `${b.owner ?? 'no owner'} — ${b.why.join('; ')}${b.blockedIn ? ` — blocked in ${b.blockedIn.role}` : ''}`)))),
        card(`High-priority bugs (${x.criticalBugs.length})`, issueList(x.criticalBugs, (b) => h('span', {}, link(b), ' ', b.summary, h('div', { class: 'why' }, `${b.priority} — ${b.status} — ${b.owner ?? 'no owner'}`)))),
        card('Risks (inferred)', issueList(x.risks, (r) => r, { empty: 'None flagged' }))))),
    sectionTitle('Follow-ups'), card(null, followUpsBlock(rep.followUps, rep.learning, 'Features', { limit: 10 })),
    recurringBlock(rep), sectionTitle('Tracked features'), registryCard());
}

function registryCard() {
  const reg = state.registry;
  if (!reg) return card(null, h('p', { class: 'loading' }, 'Loading tracked features…'));
  if (reg.error) return card(null, h('div', { class: 'err' }, reg.error));
  const input = h('input', { type: 'text', placeholder: 'REST-12345', 'aria-label': 'Jira key to track', size: 12 });
  const note = h('input', { type: 'text', placeholder: 'note (optional)', 'aria-label': 'Note', size: 20 });
  const remove = async (key) => {
    if (!confirm(`Stop tracking ${key}? Its history is kept.`)) return;
    try { await api(`/features/${encodeURIComponent(key)}`, { method: 'DELETE' }); toast(`${key} removed`); await refreshFeatures(); } catch (e) { toast(e.message); }
  };
  return card(null,
    h('ul', { class: 'list' }, reg.tracked.map((f) => h('li', { class: 'row' }, h('strong', {}, f.key), ' ', f.summary ?? '', f.issue_type ? chip(f.issue_type) : null,
      h('span', { class: 'spacer' }), h('button', { onclick: () => remove(f.key) }, 'Remove')))),
    h('form', { class: 'inline', style: 'margin-top:10px', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('/features', { method: 'POST', body: JSON.stringify({ key: input.value, note: note.value || null }) });
        toast(`${r.key} ${r.result === 'exists' ? 'is already tracked' : 'added'}${r.warnings?.length ? ` — ${r.warnings[0]}` : ''}`);
        await refreshFeatures();
      } catch (err) { toast(err.message); }
    } }, input, note, h('button', { type: 'submit' }, 'Track')),
    reg.removed.length ? h('p', { class: 'why' }, `No longer tracked (history kept): ${reg.removed.map((f) => f.key).join(', ')}`) : null);
}

async function loadRegistry() {
  try { state.registry = await api('/features'); } catch (err) { state.registry = { error: err.message }; }
  renderAll();
}

async function refreshFeatures() {
  await loadRegistry();
  try { state.data.features = await api('/reports/features?fresh=1'); delete state.errors.features; } catch (err) { state.errors.features = err.message; }
  renderAll();
}

// ─── Production ──────────────────────────────────────────────────────────────
function renderProd() {
  const el = document.getElementById('prod');
  const st = status('prod', 'Production');
  if (st) return fill(el, st);
  const p = state.data.prod;
  const t = p.totals;
  const row = (i) => h('span', {}, link(i), ' ', i.summary, h('div', { class: 'why' }, `${i.severity ?? 'no severity'}/${i.priority ?? '—'} — ${i.status} — ${i.owner ?? 'no owner'} — open ${i.ageDays} d, updated ${i.idleDays} d ago`));
  fill(el, warnings(p),
    h('p', { class: 'fact-note' }, `${p.scope.issueType} in ${p.scope.project} where Team = ${p.scope.team}; each issue's team is re-checked.`),
    h('div', { class: 'grid' },
      card('Open', h('div', { class: 'row' }, h('span', { class: 'big' }, t.open), h('span', { class: 'sub' }, `${t.withEngineering} with engineering · ${t.waiting} waiting`)),
        h('div', { class: 'sub' }, `Last 7 days: ${t.new} new · ${t.resolved} resolved`)),
      card('Severity', h('div', { class: 'row' }, Object.entries(p.bySeverity).map(([k, v]) => chip(`${k} ${v}`, k === 'Critical' ? 'red' : k === 'High' ? 'amber' : '')))),
      card('Age', p.aging.map((a) => h('div', { class: 'row' }, h('span', { class: 'sub', style: 'width:90px' }, a.label), h('strong', {}, a.all), a.urgent ? chip(`${a.urgent} crit/high`, 'amber') : null)))),
    h('div', { class: 'grid', style: 'margin-top:12px' },
      card(`Critical and high — with engineering (${p.urgent.filter((i) => !i.waiting).length})`, issueList(p.urgent.filter((i) => !i.waiting), row)),
      card(`Critical and high — waiting (${p.urgent.filter((i) => i.waiting).length})`, issueList(p.urgent.filter((i) => i.waiting), row, { limit: 5 }))),
    h('div', { class: 'grid', style: 'margin-top:12px' },
      card(`Blocked (${p.blocked.length})`, issueList(p.blocked, (b) => h('span', {}, link(b), ' ', b.summary, h('div', { class: 'why' }, `${b.severity ?? 'no severity'} — ${b.owner ?? 'no owner'} — ${b.why.join('; ')}`)))),
      card(`Stalled with engineering (${p.stalled.length})`, issueList(p.stalled, row)),
      card(`Recently resolved (${p.resolved.length})`, issueList(p.resolved, (i) => h('span', {}, link(i), ' ', i.summary, h('div', { class: 'why' }, `${i.status}${i.resolution ? ` (${i.resolution})` : ''} — took ${i.daysToResolve ?? '?'} d`))))),
    card(`Waiting ${p.rules.waitingDays}+ days (${p.longWait.length})`, issueList(p.longWait, row, { limit: 5 })),
    sectionTitle('Risks (inferred)'), card(null, issueList(p.risks, (r) => r, { empty: 'None flagged' })),
    sectionTitle('Follow-ups'), card(null, followUpsBlock(p.followUps, p.learning, 'Production')), recurringBlock(p));
}

// ─── Follow-ups (all reports) ────────────────────────────────────────────────
function renderFollowUps() {
  const el = document.getElementById('followups');
  const all = allFollowUps();
  fill(el, 
    h('p', { class: 'fact-note' }, 'Every follow-up from the four reports, highest score first. Valid ranks it higher; Dismiss hides it until its facts change in Jira; Resolved flags it if Jira still shows it. Nothing here changes Jira.'),
    card(null, all.length ? h('ul', { class: 'list' }, all.map(([f, src]) => h('li', {}, followUpItem(f, src)))) : h('p', { class: 'muted' }, 'Nothing yet')));
}

// ─── tabs and boot ───────────────────────────────────────────────────────────
function renderAll() {
  renderOverview(); renderScrum(); renderReleases(); renderFeatures(); renderProd(); renderFollowUps();
}
function show(tab) {
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== tab;
  try { localStorage.setItem('pmo-tab', tab); } catch { /* private mode */ }
  history.replaceState(null, '', `#${tab}`);
}
document.getElementById('tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) show(e.target.dataset.tab); });
document.getElementById('refresh').addEventListener('click', () => load(true));
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (document.getElementById(t)) show(t); });
let first = location.hash.slice(1);
try { first ||= localStorage.getItem('pmo-tab'); } catch { /* ignore */ }
show(['overview', 'scrum', 'releases', 'features', 'prod', 'followups'].includes(first) ? first : 'overview');
load(false);
loadRegistry();
