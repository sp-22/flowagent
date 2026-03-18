import { PLATFORM_IDS } from "../shared/constants.js";
import { buildGoogleSearchUrl } from "../shared/google-search.js";

export function buildXSearchUrl(query, timeFilter) {
  return buildGoogleSearchUrl({
    query: query.trim(),
    timeFilter
  });
}

export function isXPostUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^(x\.com|twitter\.com)$/i.test(parsed.hostname)) {
      return false;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) {
      return false;
    }

    if (segments[0] === "i" && (segments[1] === "status" || (segments[1] === "web" && segments[2] === "status"))) {
      return /^\d+$/.test(segments.at(-1));
    }

    return segments.length >= 3 && segments[1] === "status" && /^\d+$/.test(segments[2]);
  } catch {
    return false;
  }
}

export function canonicalizeXUrl(url) {
  try {
    if (!isXPostUrl(url)) {
      return "";
    }
    const parsed = new URL(url);
    parsed.hostname = "x.com";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString();
  } catch {
    return "";
  }
}

export function createXRuntimeConfig() {
  return {
    platformId: PLATFORM_IDS.X,
    postTextSelectors: [
      '[data-testid="tweetText"]',
      "article div[lang]"
    ],
    authorSelectors: [
      '[data-testid="User-Name"] a[role="link"] span',
      'article a[href^="/"][role="link"] span'
    ],
    metadataSelectors: [
      "time",
      '[data-testid="socialContext"]'
    ],
    composerSelectors: [
      '[data-testid="tweetTextarea_0"]',
      '[data-testid="tweetTextarea_0"] div[contenteditable="true"]',
      'div[role="textbox"][data-testid*="tweet"]'
    ],
    confirmationTextPatterns: [
      "Your post was sent",
      "Your reply was sent"
    ]
  };
}
