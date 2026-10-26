// A language code like the frontend's (pt-BR, en-UK, es-BO): a language, and maybe a region
const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export const isValidLocale = (locale) => typeof locale === "string" && LOCALE_PATTERN.test(locale);
