/**
 * Re-export of the canonical P-obs-3 DatasetStore from core observability.
 *
 * Previously this file was a near-verbatim copy of
 * `packages/core/src/observability/dataset.ts` (only the silentFailure import
 * path differed). PRINCIPLES §3 count-guard treats each `export class DatasetStore`
 * as a store impl — keep a single class declaration.
 */
export {
  DatasetStore,
  type Dataset,
  type DatasetCase,
  type DatasetStoreConfig,
} from '../../../observability/dataset';
