/**
 * Appends an actionable hint to git transport failures.
 *
 * The panel shows the raw git stderr, which for a blocked or unauthenticated
 * remote reads like "Connection closed by 20.205.243.166 port 22" — accurate,
 * but it does not tell the user that their other git actions will fail the same
 * way or what to change. These are the three recurring causes on a self-hosted
 * setup: port 22 is blocked somewhere on the path, the SSH key is not accepted,
 * or the host name does not resolve.
 */
const SSH_BLOCKED_PATTERNS = [
  /connection closed by .* port 22/i,
  /connection reset by peer/i,
  /kex_exchange_identification/i,
  /connection timed out/i,
  /operation timed out/i,
];

const SSH_AUTH_PATTERNS = [
  /permission denied \(publickey\)/i,
  /could not read from remote repository/i,
  /host key verification failed/i,
];

const DNS_PATTERNS = [
  /could not resolve host/i,
  /name or service not known/i,
  /unable to access/i,
];

export function describeGitError(rawMessage: string, t: (key: string) => string): string {
  const message = rawMessage ?? '';
  if (!message) {
    return message;
  }

  if (SSH_AUTH_PATTERNS.some((pattern) => pattern.test(message))) {
    return `${message}\n${t('git:errors.sshAuthHint')}`;
  }

  if (SSH_BLOCKED_PATTERNS.some((pattern) => pattern.test(message))) {
    return `${message}\n${t('git:errors.sshBlockedHint')}`;
  }

  if (DNS_PATTERNS.some((pattern) => pattern.test(message))) {
    return `${message}\n${t('git:errors.dnsHint')}`;
  }

  return message;
}
