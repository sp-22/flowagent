import { PLATFORM_IDS } from "../shared/constants.js";
import { buildGoogleSearchUrl } from "../shared/google-search.js";

export function buildLinkedInSearchUrl(query, timeFilter) {
  return buildGoogleSearchUrl({
    query: query.trim(),
    timeFilter
  });
}

export function isLinkedInPostUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^www\.linkedin\.com$/i.test(parsed.hostname)) {
      return false;
    }

    const path = parsed.pathname.replace(/\/$/, "");
    return path.startsWith("/feed/update/urn:li:activity:")
      || path.startsWith("/posts/")
      || path.startsWith("/pulse/");
  } catch {
    return false;
  }
}

export function canonicalizeLinkedInUrl(url) {
  try {
    if (!isLinkedInPostUrl(url)) {
      return "";
    }
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString();
  } catch {
    return "";
  }
}

export function createLinkedInRuntimeConfig() {
  return {
    platformId: PLATFORM_IDS.LINKEDIN,
    postTextSelectors: [
      ".feed-shared-update-v2__description",
      ".update-components-text",
      ".feed-shared-inline-show-more-text"
    ],
    authorSelectors: [
      ".update-components-actor__title span[aria-hidden='true']",
      ".feed-shared-actor__name"
    ],
    metadataSelectors: [
      ".update-components-actor__sub-description",
      "time"
    ],
    composerSelectors: [
      ".comments-comment-box__editor",
      ".ql-editor[contenteditable='true']",
      "div[role='textbox'][contenteditable='true']"
    ],
    confirmationTextPatterns: [
      "Comment posted",
      "Your comment has been posted"
    ]
  };
}
