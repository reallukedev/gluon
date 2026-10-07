/**
 * Commands that carry a secret on the command line. They still run, but never go into the history
 * (a password in a list of suggestions is a password on screen). Leading space skips history too,
 * the way bash's ignorespace does.
 */
const SECRET_PATTERNS: RegExp[] = [
  // --password=x, --token x, --api-key=x, --secret x, --client-secret=x, --passphrase x
  /(^|\s)--?([\w-]*[-_])?(pass|password|passwd|passphrase|secret|token|api[-_]?key|private[-_]?key|credentials?|auth)(=|\s+)[^\s-]/i,
  // PASSWORD=x, DB_PASS=x, GITHUB_TOKEN=x, AWS_SECRET_ACCESS_KEY=x as assignments
  /(^|[\s;&|(])[A-Za-z_]*(PASS(WORD|WD)?|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z_]*=\S/i,
  // user:password@host in URLs
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  // mysql -pSECRET, mariadb -pSECRET (attached; a bare -p prompts instead)
  /(^|[\s;&|])(mysql|mariadb|mysqldump|mariadb-dump)\b[^|;&]*\s-p\S/,
  // curl -u user:pass, wget --user/--password handled above
  /(^|[\s;&|])curl\b[^|;&]*\s(-u|--user)\s*\S+:\S/,
  // Authorization headers
  /authorization:\s*(bearer|basic|token)\s+\S/i,
  // sshpass -p x, htpasswd -b user pass, chpasswd/passwd fed on the line
  /(^|[\s;&|])sshpass\s+-p\s*\S/,
  /(^|[\s;&|])htpasswd\b[^|;&]*\s-\w*b/,
  /(^|[\s;&|])(chpasswd|passwd)\b.*<<</,
  // echo 'x' | passwd --stdin / docker login -p
  /(^|[\s;&|])docker\s+login\b[^|;&]*\s(-p|--password)(?=[\s=])/,
];

export function looksSecret(command: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(command));
}

/** The command as it should be remembered, or null when it shouldn't be. */
export function historyEntry(command: string): string | null {
  if (!command.trim() || /^\s/.test(command)) return null;
  const c = command.trim();
  if (c.length > 2000) return null;
  return looksSecret(c) ? null : c;
}
