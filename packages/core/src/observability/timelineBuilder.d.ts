import type { ExecutionTrace } from '../runtime/types';
import { type SpanTreeView, type TimelineView } from './types';
export declare function buildTimeline(trace: ExecutionTrace): TimelineView;
export declare function buildSpanTree(trace: ExecutionTrace): SpanTreeView;
//# sourceMappingURL=timelineBuilder.d.ts.map