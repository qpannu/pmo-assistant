// One-time interactive sign-in: `npm run ms:login`.
// You enter the shown code at microsoft.com/devicelogin and sign in there;
// this script never sees your password.

import { config, msScopes } from '../config.js';
import { createMsAuth } from './auth.js';
import { createGraphClient } from './graph.js';
import { setLogLevel } from '../logger.js';

setLogLevel('warn');

if (!config.ms.tenantId || !config.ms.clientId) {
  console.error('Set MS_TENANT_ID and MS_CLIENT_ID in .env first (see README → Microsoft app registration).');
  process.exit(1);
}

const scopes = msScopes(config.ms);
const auth = createMsAuth({ ...config.ms, scopes });

console.log(`\nRequesting read-only permissions: ${scopes.join(', ')}\n`);
try {
  await auth.deviceCodeLogin({ onPrompt: (message) => console.log(`${message}\n\nWaiting for you to finish signing in…`) });
  const me = await createGraphClient(auth).me();
  console.log(`\nSigned in as ${me.displayName} (${me.mail ?? me.userPrincipalName}).`);
  console.log(`Granted: ${auth.grantedScopes()}`);
  console.log(`Token saved to ${config.ms.tokenCachePath} (git-ignored, owner-only).\n`);
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}
