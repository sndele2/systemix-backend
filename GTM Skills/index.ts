/**
 * index.ts
 *
 * Public API surface for the GTM module.
 *
 * Consumers outside this folder should import ONLY from here.
 * Internal cross-file imports can reach deeper, but external modules
 * must treat this as the module boundary.
 *
 * Usage example:
 *   import { startSequence, stopSequence } from '../gtm';
 */

export type {
  Lead,
  LeadStatus,
  EmailStage,
  ReplyClassification,
  GTMConfig,
} from './types';

export { GTMService } from './service';

// TODO: export handler if an HTTP endpoint is added (see handler.ts)
