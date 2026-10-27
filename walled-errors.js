// Keep validation paths/messages, never the rejected input or request headers.
export function walledErrorDetails(result, secrets = []) {
  const messages = [];
  const collect = (value, depth = 0) => {
    if (!value || depth > 4 || messages.length >= 12) return;
    if (typeof value === 'string') { messages.push(value); return; }
    if (Array.isArray(value)) { value.forEach(item => collect(item, depth + 1)); return; }
    if (typeof value !== 'object') return;
    if (Array.isArray(value.loc) && (value.msg || value.type)) {
      messages.push(value.loc.filter(part => typeof part === 'string' || typeof part === 'number').join('.') + ': ' + (value.msg || value.type));
      return;
    }
    for (const key of ['code', 'message', 'detail', 'error', 'errors']) collect(value[key], depth + 1);
  };
  collect(result);
  let detail = [...new Set(messages)].join(' | ').replace(/\s+/g, ' ');
  for (const secret of secrets.filter(Boolean)) detail = detail.split(secret).join('[redacted]');
  return detail.slice(0, 1200) || 'No structured error details returned';
}
