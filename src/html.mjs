const NAMED = new Map([
  ['nbsp', ' '],
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['ensp', ' '],
  ['emsp', ' '],
  ['middot', '·'],
  ['hellip', '…'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['times', '×'],
  ['divide', '÷'],
  ['le', '≤'],
  ['ge', '≥'],
  ['ne', '≠'],
  ['deg', '°'],
]);

export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    return NAMED.get(entity.toLowerCase()) ?? whole;
  });
}

/** Convert the platform's rich text into the plain text expected by the public Question DTO. */
export function htmlToText(value) {
  const source = String(value ?? '');
  if (!source) return '';
  if (!/[<&]/.test(source)) return source.trim();
  const text = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function absoluteImage(source, base) {
  const raw = decodeEntities(source).trim();
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
  try {
    if (raw.startsWith('//')) return `https:${raw}`;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return new URL(raw).toString();
    return new URL(raw, base).toString();
  } catch {
    return '';
  }
}

export function htmlImages(value, allowedHost, base = 'https://downloadres.qlteacher.com/') {
  const source = String(value ?? '');
  const images = [];
  const pattern = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of source.matchAll(pattern)) {
    const url = absoluteImage(match[1] ?? match[2] ?? match[3] ?? '', base);
    if (!url) continue;
    try {
      if (!allowedHost(new URL(url).hostname)) continue;
    } catch {
      continue;
    }
    if (!images.includes(url)) images.push(url);
  }
  return images;
}

export function answerList(value) {
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (value === null || value === undefined) return [];
  const text = String(value).trim();
  if (!text) return [];
  return text.split(',').map(item => item.trim()).filter(Boolean);
}
