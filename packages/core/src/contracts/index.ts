/**
 * Commander Architecture Contract Layer
 *
 * Abstract interface contracts for all four pillars, per the Commander
 * Ultimate Target Architecture Blueprint. These interfaces define the
 * formal boundaries between architecture layers and their implementations.
 *
 * Design constraints (per requirements document):
 * - C-05: TypeScript-first, zero external dependencies
 * - IF-01: All contracts as abstract classes or interfaces
 * - IF-03: Fully typed with no `any` types
 * - IF-05: Discriminated unions for state variants
 * - IF-06: Each Pillar defines its contract independently (loose coupling)
 * - CON-P-02: Contracts precede implementations (contract-first design)
 *
 * @module contracts
 */

export * from './pillarI';
export * from './pillarII';
export * from './pillarIII';
export * from './pillarIV';
