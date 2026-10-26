import { MAX_CATEGORY_SELECTIONS } from "./constants.js";
import { cleanText } from "./text.js";

const MAX_CATEGORY_NAME_LENGTH = 50;

export const sanitizeCategoryName = (name) => cleanText(name, MAX_CATEGORY_NAME_LENGTH);

// The categories of a guest's vote: up to MAX_CATEGORY_SELECTIONS, each one once, blank ones left
// out
export const sanitizeCategoryVote = (categories) => {
  const selection = [];
  for (const rawCategory of categories) {
    if (selection.length >= MAX_CATEGORY_SELECTIONS) {
      break;
    }
    const name = sanitizeCategoryName(rawCategory);
    if (name && !selection.includes(name)) {
      selection.push(name);
    }
  }
  return selection;
};

// Each voted category with its votes, the most voted first (then by name)
export const getCategoryTotals = (channel) => {
  if (!channel || !channel.votes) {
    return [];
  }

  const counts = new Map();
  channel.votes.forEach((selection) => {
    selection.forEach((category) => {
      const key = sanitizeCategoryName(category);
      if (!key) {
        return;
      }
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .map(([name, votes]) => ({ name, votes }))
    .sort((a, b) => {
      if (b.votes !== a.votes) {
        return b.votes - a.votes;
      }
      return a.name.localeCompare(b.name);
    });
};
