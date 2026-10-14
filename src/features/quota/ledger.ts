/** Redact addresses wherever they appear, including addresses embedded in filenames. */
export function maskQuotaIdentity(value: string): string {
  return value.replace(
    /([\w.+-]+)@([\w.-]+\.[a-z]{2,})/gi,
    (_match, local: string, domain: string) => {
      const prefix =
        local.match(/^(?:claude|codex|antigravity|xai|kimi|devin|meta)-(?:[a-f0-9]{8}-)?/i)?.[0] ??
        '';
      const filenameSuffix = domain.match(/(?:-(?:pro|plus|max|team|free))?\.json$/i)?.[0] ?? '';
      const parts = (filenameSuffix ? domain.slice(0, -filenameSuffix.length) : domain).split('.');
      const suffix = parts.pop();
      return `${prefix}${local.slice(prefix.length, prefix.length + 1)}•••@${parts.map((part) => `${part.slice(0, 1)}•••`).join('.')}.${suffix}${filenameSuffix}`;
    }
  );
}

