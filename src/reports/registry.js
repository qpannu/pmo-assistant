// The editable list of features (initiatives) the Feature report tracks.
// Stored in the database, so changes need no code edits and survive restarts.
// TRACKED_FEATURES_SEED fills it once on first use; after that only
// add/remove change it (removal keeps the row and its report history).

const KEY_RX = /^[A-Z][A-Z0-9]+-\d+$/;

export class RegistryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
  }
}

export function ensureSeeded(store, config) {
  return store.seedTrackedFeatures(config.reports.featureSeed ?? []);
}

export function listFeatures(store, config) {
  ensureSeeded(store, config);
  const all = store.listTrackedFeatures({ includeRemoved: true });
  return { tracked: all.filter((f) => !f.removed_at), removed: all.filter((f) => f.removed_at) };
}

// Verifies the key in Jira (when connected) and records its type and summary.
export async function addFeature({ store, config, client, key, note = null }) {
  const k = String(key ?? '').trim().toUpperCase();
  if (!KEY_RX.test(k)) throw new RegistryError(`"${key}" is not a Jira issue key (e.g. REST-247)`);
  ensureSeeded(store, config);
  let issue = null;
  const warnings = [];
  if (client) {
    const { issues } = await client.search({ jql: `key = ${k}`, fields: ['summary', 'issuetype', 'status'], limit: 1 });
    issue = issues[0] ?? null;
    if (!issue) throw new RegistryError(`${k} was not found in Jira (or you can't see it)`, 404);
    const level = issue.fields.issuetype?.hierarchyLevel;
    if (level != null && level < 2) {
      warnings.push(`${k} is ${/^[aeiou]/i.test(issue.fields.issuetype.name) ? 'an' : 'a'} ${issue.fields.issuetype.name}, not an initiative; its child issues are reported directly`);
    }
  } else {
    warnings.push('Jira is not connected, so the key was not verified');
  }
  const result = store.addTrackedFeature({
    key: k, note,
    summary: issue?.fields.summary ?? null,
    type: issue?.fields.issuetype?.name ?? null,
  });
  return { key: k, result, type: issue?.fields.issuetype?.name ?? null, summary: issue?.fields.summary ?? null, warnings };
}

export function removeFeature({ store, config, key }) {
  const k = String(key ?? '').trim().toUpperCase();
  ensureSeeded(store, config);
  if (!store.removeTrackedFeature(k)) throw new RegistryError(`${k} is not currently tracked`, 404);
  return { key: k, result: 'removed' };
}
