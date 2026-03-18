import {
  buildXSearchUrl,
  isXPostUrl,
  canonicalizeXUrl,
  createXRuntimeConfig
} from "./x.js";
import {
  buildLinkedInSearchUrl,
  isLinkedInPostUrl,
  canonicalizeLinkedInUrl,
  createLinkedInRuntimeConfig
} from "./linkedin.js";
import { PLATFORM_IDS } from "../shared/constants.js";

export const platformAdapters = {
  [PLATFORM_IDS.X]: {
    id: PLATFORM_IDS.X,
    label: "X",
    buildSearchUrl: buildXSearchUrl,
    matchesUrl: isXPostUrl,
    canonicalizeUrl: canonicalizeXUrl,
    getRuntimeConfig: createXRuntimeConfig
  },
  [PLATFORM_IDS.LINKEDIN]: {
    id: PLATFORM_IDS.LINKEDIN,
    label: "LinkedIn",
    buildSearchUrl: buildLinkedInSearchUrl,
    matchesUrl: isLinkedInPostUrl,
    canonicalizeUrl: canonicalizeLinkedInUrl,
    getRuntimeConfig: createLinkedInRuntimeConfig
  }
};

export function getPlatformAdapter(platformId) {
  return platformAdapters[platformId] || null;
}

export function getAllPlatformAdapters() {
  return Object.values(platformAdapters);
}

export function getAdapterForUrl(url) {
  return getAllPlatformAdapters().find((adapter) => adapter.matchesUrl(url)) || null;
}
