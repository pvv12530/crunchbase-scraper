import { SOURCE_CRUNCHBASE_DISCOVER_ORGS } from '@shared/constants';

/** Maps source id to host patterns and content bundle name (for future multi-source). */
export const sourceRegistry = {
  [SOURCE_CRUNCHBASE_DISCOVER_ORGS]: {
    hostSuffixes: ['www.crunchbase.com', 'crunchbase.com'],
    contentEntry: 'content/crunchbase.js',
  },
} as const;

export function isKnownSource(id: string): id is keyof typeof sourceRegistry {
  return id in sourceRegistry;
}
