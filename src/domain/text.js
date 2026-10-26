// Control characters (line breaks, escape sequences...) and the invisible marks that reorder text
// (they'd show a name backwards): nothing a name or a category needs
const UNSAFE_CHARACTERS = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

// Cuts the text at `length` UTF-16 code units, without splitting an emoji in two
const truncate = (text, length) => {
  const cut = text.substring(0, length);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/**
 * A name or a label as the room shows it: without control characters, trimmed, and cut at
 * `maxLength`
 *
 * @param text - The text a device sent
 * @param maxLength - Its longest length
 * @returns The clean text, empty for anything that isn't text
 */
export const cleanText = (text, maxLength) =>
  typeof text === "string" ? truncate(text.replace(UNSAFE_CHARACTERS, "").trim(), maxLength) : "";
