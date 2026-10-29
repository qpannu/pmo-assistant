// Plain-text rendering of a priority report (terminal, notifications, email body).

const SECTIONS = [
  ['critical', '1. CRITICAL — needs immediate attention'],
  ['waitingOnMe', '2. DECISIONS & RESPONSES WAITING FOR YOU'],
  ['releaseRisks', '3. UPCOMING RELEASE RISKS'],
  ['followUps', '4. FOLLOW-UPS & OVERDUE COMMITMENTS'],
];

function formatItem(item, n) {
  const lines = [`  ${n}. [${item.score}] ${item.title}`];
  for (const s of item.sources) {
    lines.push(`     Source:   ${s.system}${s.url ? ` — ${s.url}` : ''}`);
    lines.push(`     Evidence: ${s.text}`);
  }
  lines.push(`     Why:      ${item.reasons.slice(0, 3).map((r) => r.label).join('; ')}`);
  lines.push(`     Next:     ${item.nextAction}`);
  return lines.join('\n');
}

export function formatReport(report, { maxPerSection = 10 } = {}) {
  const out = [`PMO priorities — ${report.generatedAt.slice(0, 16).replace('T', ' ')} UTC`, ''];

  out.push(`5. RECOMMENDED TOP THREE (${report.topThree.method})`);
  if (report.topThree.summary) out.push(`  ${report.topThree.summary}`);
  report.topThree.items.forEach((t, i) => {
    out.push(`  ${i + 1}. ${t.title}`, `     Why:  ${t.why}`, `     Next: ${t.nextAction}`);
  });
  if (!report.topThree.items.length) out.push('  Nothing open.');
  out.push('');

  for (const [key, heading] of SECTIONS) {
    const items = report[key];
    out.push(`${heading} (${items.length})`);
    if (!items.length) out.push('  None.');
    items.slice(0, maxPerSection).forEach((item, i) => out.push(formatItem(item, i + 1)));
    if (items.length > maxPerSection) out.push(`  …and ${items.length - maxPerSection} more`);
    out.push('');
  }

  if (report.newAlerts.length) {
    out.push(`NEW ALERTS (${report.newAlerts.length})`);
    for (const a of report.newAlerts) out.push(`  ! ${a.title} → ${a.nextAction}`);
  }
  return out.join('\n').trimEnd() + '\n';
}
