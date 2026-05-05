/**
 * True when the caller is a member of the GROUP_APP_ADMINS_ID group
 * (the in-app admin group). Admins are a SUPERSET of uploaders:
 *
 *   - read every document in every department (ACL filter bypassed)
 *   - upload to any group (no membership-of-target-group check)
 *   - delete any uploaded doc
 *   - manage users + groups via /admin
 *
 * Returns false when GROUP_APP_ADMINS_ID is unset — in that mode the
 * admin feature is disabled entirely. No silent escalation.
 */
export function isAppAdmin(groups: readonly string[]): boolean {
  const adminGroup = (process.env.GROUP_APP_ADMINS_ID || '').trim();
  if (!adminGroup) return false;
  return groups.includes(adminGroup);
}
