import en from './locales/en.js';
import bg from './locales/bg.js';

export const catalogs = Object.freeze({ en, bg });
export const languages = Object.freeze(['en', 'bg']);

/** Use Bulgarian for Bulgarian system locales and English for all other locales. */
export function resolveLocale(value) {
  return typeof value === 'string' && /^bg(?:-|_|$)/i.test(value) ? 'bg' : 'en';
}

/** Translate trusted UI copy; interpolate values as plain text, never executable markup. */
export function translate(locale, key, values = {}) {
  const catalog = catalogs[resolveLocale(locale)];
  const message = catalog[key] ?? en[key] ?? key;
  return message.replace(/\{([A-Za-z]+)\}/g, (placeholder, name) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}
