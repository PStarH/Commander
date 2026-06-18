import type { SynthesisStrategy, SynthesisConfig, ArtifactReference, TaskTreeNode, QualityGateConfig } from './types';
export declare class MultiAgentSynthesizer {
    private artifactSystem;
    synthesize(strategy: SynthesisStrategy, config: SynthesisConfig, taskTree: TaskTreeNode, artifacts: ArtifactReference[]): Promise<{
        synthesis: string;
        artifactsUsed: string[];
        qualityScore: number;
        gateResults: Array<{
            gate: string;
            passed: boolean;
            score: number;
        }>;
    }>;
    private leadSynthesis;
    private hierarchicalSynthesis;
    private voteSynthesis;
    private ensembleSynthesis;
    runQualityGatesStrict(gates: QualityGateConfig[], synthesis: string, taskTree: TaskTreeNode): Promise<Array<{
        gate: string;
        passed: boolean;
        score: number;
    }>>;
    private runQualityGates;
    private checkHallucination;
    private checkConsistency;
    private checkCompleteness;
    private checkAccuracy;
    private checkSafety;
    private collectCompleted;
    private collectFailed;
    private countAllNodes;
    private getDepth;
    private getMaxDepth;
}
//# sourceMappingURL=synthesizer.d.ts.map