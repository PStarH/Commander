/**
 * P-obs-3: Dataset + DatasetStore (Braintrust-style).
 *
 * A Dataset is a named collection of test cases. Each case has an
 * `input` (the agent's goal), an optional `expected` (what the
 * agent should produce), and a rubric reference. The store is
 * in-memory with optional JSON-file persistence — production
 * deployments can mount a writable volume and call `saveAll()` on
 * shutdown to keep the dataset across restarts.
 *
 * Braintrust parity:
 *  - dataset has id, name, description, rubricId, cases
 *  - case has id, input, expected, metadata, rubricId
 *  - store exposes list/get/create/update/delete + bulk load/save
 */
export interface DatasetCase {
    /** Unique within the dataset. */
    id: string;
    /** The agent's input (goal + optional context). */
    input: {
        goal: string;
        contextData?: Record<string, unknown>;
        availableTools?: string[];
        maxSteps?: number;
        tokenBudget?: number;
    };
    /** What the agent should produce. */
    expected?: {
        /** Output must contain all of these substrings. */
        outputContains?: string[];
        /** Output must match all of these regular expressions. */
        outputMatches?: string[];
        /** Tool names that must have been called. */
        toolsExpected?: string[];
    };
    /** Free-form metadata for filtering / display. */
    metadata?: Record<string, unknown>;
    /** Per-case rubric override. Falls back to the dataset's rubric. */
    rubricId?: string;
}
export interface Dataset {
    id: string;
    name: string;
    description?: string;
    /** Default rubric for cases that don't override. */
    rubricId: string;
    cases: DatasetCase[];
    createdAt: string;
    updatedAt: string;
}
export interface DatasetStoreConfig {
    /** Optional directory for JSON persistence. When set, `saveAll()` writes here. */
    persistenceDir?: string;
}
/**
 * In-memory dataset store with optional JSON file persistence.
 * Thread-safety: not thread-safe; intended for single-process use.
 */
export declare class DatasetStore {
    private datasets;
    private readonly persistenceDir;
    constructor(config?: DatasetStoreConfig);
    list(): Dataset[];
    get(id: string): Dataset | undefined;
    create(input: Omit<Dataset, 'id' | 'createdAt' | 'updatedAt'> & {
        id?: string;
    }): Dataset;
    update(id: string, patch: Partial<Omit<Dataset, 'id' | 'createdAt'>>): Dataset | undefined;
    delete(id: string): boolean;
    /** Write a single dataset to disk. No-op when persistence is disabled. */
    save(id: string): boolean;
    /** Write all datasets to disk. */
    saveAll(): number;
    /** Load a dataset from a JSON file and add it to the store. */
    loadFromFile(filePath: string): Dataset | undefined;
    /** Load every `*.json` file in the persistence directory. */
    loadAllFromDir(): number;
    /** Count of datasets in memory. */
    size(): number;
}
//# sourceMappingURL=dataset.d.ts.map