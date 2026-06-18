/**
 * Consensus Check
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 *
 * Core insight: 关键决策需要多模型共识
 * - 收集多个模型的独立判断
 * - 分析一致性程度
 * - 低共识时触发讨论或重新评估
 */
export type ConsensusLevel = 'unanimous' | 'strong' | 'moderate' | 'low' | 'diverged';
export interface ModelVote {
    modelId: string;
    modelName: string;
    decision: string;
    confidence: number;
    reasoning: string;
    timestamp: string;
}
export interface ConsensusCheck {
    id: string;
    question: string;
    context: string;
    votes: ModelVote[];
    consensusLevel: ConsensusLevel;
    consensusScore: number;
    agreedDecision?: string;
    disagreementSummary?: string;
    createdAt: string;
    completedAt?: string;
    requiresDiscussion: boolean;
    isLowConfidence?: boolean;
}
export interface ConsensusConfig {
    minVoters: number;
    agreementThreshold: number;
    strongAgreementThreshold: number;
    lowConsensusThreshold: number;
    timeoutMs: number;
    enableDiscussion: boolean;
}
export interface ConsensusResult {
    decision: string;
    consensusLevel: ConsensusLevel;
    consensusScore: number;
    confidence: 'high' | 'medium' | 'low';
    requiresAction: boolean;
    actionType?: 'proceed' | 'discuss' | 'rethink' | 'escalate';
}
export declare class ConsensusChecker {
    private checks;
    private config;
    constructor(config?: Partial<ConsensusConfig>);
    /**
     * 创建共识检查
     */
    createCheck(question: string, context?: string): string;
    /**
     * 添加投票
     */
    addVote(checkId: string, modelId: string, modelName: string, decision: string, confidence: number, reasoning: string): boolean;
    /**
     * 更新共识状态
     */
    private updateConsensus;
    /**
     * 计算共识分数
     */
    private calculateConsensusScores;
    /**
     * 计算文本相似度
     */
    private calculateSimilarity;
    /**
     * 选择共同决策
     */
    private selectAgreedDecision;
    /**
     * 总结分歧
     */
    private summarizeDisagreements;
    /**
     * 完成检查
     */
    completeCheck(checkId: string): ConsensusCheck | undefined;
    /**
     * 获取检查结果
     */
    getCheck(checkId: string): ConsensusCheck | undefined;
    /**
     * 获取共识结果 (用于决策)
     */
    getResult(checkId: string): ConsensusResult | undefined;
    /**
     * 分数转置信度
     */
    private scoreToConfidence;
    /**
     * 确定需要采取的行动
     */
    private determineAction;
    /**
     * 等待足够投票
     */
    waitForVotes(checkId: string): Promise<ConsensusCheck | null>;
    /**
     * 获取统计信息
     */
    getStats(): {
        totalChecks: number;
        completedChecks: number;
        averageConsensusScore: number;
        byLevel: Record<ConsensusLevel, number>;
    };
    /**
     * 清除旧检查
     */
    clearOldChecks(olderThanMs?: number): number;
    /**
     * 生成报告
     */
    generateReport(checkId: string): string;
}
export declare function getGlobalConsensusChecker(): ConsensusChecker;
export declare function createConsensusChecker(config?: Partial<ConsensusConfig>): ConsensusChecker;
export declare function resetConsensusChecker(): void;
//# sourceMappingURL=consensusCheck.d.ts.map