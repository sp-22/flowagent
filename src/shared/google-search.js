import { TIME_FILTERS } from "./constants.js";

export function buildGoogleSearchUrl({ query, timeFilter, siteQuery = "" }) {
  const terms = [String(query || "").trim(), String(siteQuery || "").trim()]
    .filter(Boolean)
    .join(" ");
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", terms);
  url.searchParams.set("hl", "en");
  url.searchParams.set("num", "20");

  if (timeFilter === TIME_FILTERS.LAST_24_HOURS) {
    url.searchParams.set("tbs", "qdr:d");
  } else if (timeFilter === TIME_FILTERS.LAST_WEEK) {
    url.searchParams.set("tbs", "qdr:w");
  }

  return url.toString();
}

export function getGoogleSearchText(searchUrl) {
  try {
    const parsed = new URL(searchUrl);
    return parsed.searchParams.get("q") || "";
  } catch {
    return "";
  }
}
