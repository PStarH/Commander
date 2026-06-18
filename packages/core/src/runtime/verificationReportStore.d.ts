import type { VerificationReport } from './unifiedVerificationTypes';
export interface StoredVerificationRecord {
    schemaVersion: 1;
    runId: string;
    agentId: string;
    tenantId?: string;
    attempt: number;
    goal: string;
    outputPrefix: string;
    passed: boolean;
    confidence: number;
    skipReason?: string;
    /** Full report for replay. Optional because very old records may lack it. */
    report: VerificationReport;
    capturedAt: string;
}
export declare class VerificationReportStore {
    private baseDir;
    private tenantId?;
    private writeQueue;
    private flushing;
    constructor(baseDir?: string, tenantId?: string);
    write(record: StoredVerificationRecord): Promise<void>;
    readReports(runId: string): StoredVerificationRecord[];
    flush(): Promise<void>;
    getBaseDir(): string;
    private enqueueWrite;
}
export declare function getVerificationReportStore(tenantId?: string): VerificationReportStore;
export declare function resetVerificationReportStore(): void;
//# sourceMappingURL=verificationReportStore.d.ts.map