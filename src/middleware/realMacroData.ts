import type { RequestHandler } from 'express';

/** Composite screens require all their inputs; never label mixed examples as live. */
export function missingMacroInputs(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    if (!value.length) return [path || 'data'];
    return value.flatMap((item, index) => missingMacroInputs(item, `${path}[${index}]`));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return [path];
  if (!value || typeof value !== 'object') return [];
  // A provider may be explicitly unavailable alongside independent real metrics.
  // Null readings in that item are displayed as unavailable, never as zero.
  const item = value as Record<string, unknown>;
  if (item.available === false && item.source !== 'dummy') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const name = path ? `${path}.${key}` : key;
    if ((key === 'source' && item === 'dummy') || (key === 'live' && item === false)) return [name];
    if (item === null && ['value', 'change', 'zscore', 'latest'].includes(key)) return [name];
    return missingMacroInputs(item, name);
  });
}

export const requireRealMacroData: RequestHandler = (req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode < 400) {
      const missing = missingMacroInputs(body);
      if (missing.length) {
        res.removeHeader('X-Cache');
        res.status(503);
        return send({
          error: 'macro_data_unavailable',
          message: '실제 시장 데이터를 가져오지 못했습니다. 데이터 제공처 또는 서버 설정을 확인한 뒤 다시 시도해 주세요.',
          endpoint: req.baseUrl + req.path,
          unavailable: missing,
        });
      }
    }
    return send(body);
  };
  next();
};
