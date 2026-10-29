'use strict';

/**
 * Credential check behind an interface (prompt 3a.7, FR-53), so LDAP or Active
 * Directory sign-in can be added later without changing callers.
 *
 * A provider implements:
 *   name: string
 *   verify(user, password) -> Promise<boolean>
 *   setPassword(user, newPassword) -> Promise<void>   (local only; directory providers throw)
 *   supportsPasswordChange: boolean
 *
 * Lockout, MFA and audit stay in the auth controller, so they apply whichever
 * provider answers.
 */

const providers = new Map();

function register(provider) {
  for (const key of ['name', 'verify', 'setPassword']) {
    if (!provider[key]) throw new Error(`Credential provider is missing ${key}`);
  }
  providers.set(provider.name, provider);
}

function forUser(user) {
  const p = providers.get(user.authProvider || 'local');
  if (!p) throw new Error(`No credential provider registered for ${user.authProvider}`);
  return p;
}

register(require('./localCredentialProvider'));

module.exports = { register, forUser };
