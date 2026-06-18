import type { SagaGraph } from './types';
export interface SagaExample {
    name: string;
    description: string;
    build(): SagaGraph;
}
export declare function listSagaExamples(): SagaExample[];
export declare function getSagaExample(name: string): SagaExample | undefined;
//# sourceMappingURL=examples.d.ts.map