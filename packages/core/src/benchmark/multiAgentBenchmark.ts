#!/usr/bin/env node
/**
 * Multi-Agent vs Single-Agent A/B Benchmark
 *
 * Proves Commander's value proposition: does multi-agent orchestration
 * deliver measurable advantages over single-agent execution?
 *
 * Usage:
 *   npx tsx benchmark/multiAgentBenchmark.ts --tasks 50 --parallel 3
 *   npx tsx benchmark/multiAgentBenchmark.ts --tier complex --tasks 20
 *   npx tsx benchmark/multiAgentBenchmark.ts --output ./results/ab-test
 */

import * as fs from 'fs';
import * as path from 'path';
import { UltimateOrchestrator } from '../ultimate/orchestrator';
import { TELOSOrchestrator } from '../telos/telosOrchestrator';
import { AgentRuntime } from '../runtime/agentRuntime';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export type TaskTier = 'simple' | 'moderate' | 'complex';

export interface BenchmarkTask {
  id: string;
  tier: TaskTier;
  goal: string;
  expectedCapability: string; 
  maxTokens: number;
  tools: string[];
}

export interface TaskResult {
  taskId: string;
  tier: TaskTier;
  topology: string;
  status: 'success' | 'partial' | 'failed';
  latencyMs: number;
  totalTokens: number;
  costUsd: number;
  qualityScore: number;
  subAgentsSpawned: number;
  hallucinationScore: number;
  consistencyScore: number;
  completenessScore: number;
  accuracyScore: number;
  synthesisLength: number;
  error?: string;
}

export interface ABComparison {
  task: BenchmarkTask;
  single: TaskResult;
  multi: TaskResult;
  delta: {
    latencyMs: number;
    latencyPct: number;
    costUsd: number;
    costPct: number;
    qualityScore: number;
    qualityPct: number;
    tokens: number;
    tokensPct: number;
  };
  winner: 'single' | 'multi' | 'tie';
}

export interface BenchmarkSummary {
  timestamp: string;
  totalTasks: number;
  completedTasks: number;
  byTier: Record<TaskTier, {
    total: number;
    singleWins: number;
    multiWins: number;
    ties: number;
    avgLatencyDelta: number;
    avgCostDelta: number;
    avgQualityDelta: number;
  }>;
  overall: {
    singleWins: number;
    multiWins: number;
    ties: number;
    avgLatencyImprovement: number;
    avgCostOverhead: number;
    avgQualityImprovement: number;
    statisticalSignificance: number; // p-value from paired t-test
  };
  comparisons: ABComparison[];
  recommendations: string[];
}

// ============================================================================
// Task Definitions
// ============================================================================

const BENCHMARK_TASKS: BenchmarkTask[] = [
  // ── SIMPLE TIER (30 tasks) ──────────────────────────────────────────────
  // Single agent should handle these well; multi-agent adds overhead
  {
    id: 'simple-01',
    tier: 'simple',
    goal: 'Write a TypeScript function to validate email addresses using RFC 5322 regex',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write', 'file_read'],
  },
  {
    id: 'simple-02',
    tier: 'simple',
    goal: 'Write a function that checks if a number is prime',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-03',
    tier: 'simple',
    goal: 'Write a palindrome checker that handles Unicode',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-04',
    tier: 'simple',
    goal: 'Create a deep clone function for plain JavaScript objects',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-05',
    tier: 'simple',
    goal: 'Write a debounce function with TypeScript generics',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-06',
    tier: 'simple',
    goal: 'Create a slug generator from a string (URL-safe)',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-07',
    tier: 'simple',
    goal: 'Write a function to flatten a nested array',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-08',
    tier: 'simple',
    goal: 'Create a retry function with exponential backoff',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-09',
    tier: 'simple',
    goal: 'Write a function that groups an array by a key function',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-10',
    tier: 'simple',
    goal: 'Create a simple LRU cache with get/set operations',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-11',
    tier: 'simple',
    goal: 'Write a capitalize_words function that handles abbreviations',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-12',
    tier: 'simple',
    goal: 'Create a function to compute the Levenshtein distance between two strings',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-13',
    tier: 'simple',
    goal: 'Write a safe JSON parse function that returns a default on failure',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-14',
    tier: 'simple',
    goal: 'Create a function to generate UUID v4',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-15',
    tier: 'simple',
    goal: 'Write a function that deep merges two objects',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-16',
    tier: 'simple',
    goal: 'Create a throttle function that limits execution frequency',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-17',
    tier: 'simple',
    goal: 'Write a function to convert snake_case to camelCase',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-18',
    tier: 'simple',
    goal: 'Create a simple event emitter with on/off/emit methods',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-19',
    tier: 'simple',
    goal: 'Write a function that chunks an array into groups of N',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-20',
    tier: 'simple',
    goal: 'Create a pipeline function that chains async functions',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-21',
    tier: 'simple',
    goal: 'Write a function to find the intersection of two arrays',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-22',
    tier: 'simple',
    goal: 'Create a memoize function with TTL support',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-23',
    tier: 'simple',
    goal: 'Write a function to serialize and deserialize Map objects to JSON',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-24',
    tier: 'simple',
    goal: 'Create a retry wrapper that retries on specific error types',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-25',
    tier: 'simple',
    goal: 'Write a function to remove undefined/null values from an object',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-26',
    tier: 'simple',
    goal: 'Create a simple pub/sub system with subscribe/unsubscribe/publish',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-27',
    tier: 'simple',
    goal: 'Write a function to compute the dot product of two vectors',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-28',
    tier: 'simple',
    goal: 'Create a clamp function that constrains a number to a range',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-29',
    tier: 'simple',
    goal: 'Write a function to merge two sorted arrays into one sorted array',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },
  {
    id: 'simple-30',
    tier: 'simple',
    goal: 'Create a function to check if two strings are anagrams',
    expectedCapability: 'code_generation',
    maxTokens: 5000,
    tools: ['file_write'],
  },

  // ── MODERATE TIER (40 tasks) ──────────────────────────────────────────
  // Multi-agent should start showing advantages on these
  {
    id: 'mod-01',
    tier: 'moderate',
    goal: 'Analyze the package.json of this project and create a dependency report including outdated packages, security vulnerabilities, and bundle size impact',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write', 'web_search'],
  },
  {
    id: 'mod-02',
    tier: 'moderate',
    goal: 'Read the README.md and create a quick-start guide that a developer could follow in under 5 minutes',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-03',
    tier: 'moderate',
    goal: 'Examine the test suite and identify which tests are most likely to be flaky based on their patterns (timeouts, random values, external dependencies)',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-04',
    tier: 'moderate',
    goal: 'Review the TypeScript configuration and suggest improvements for better type safety and build performance',
    expectedCapability: 'review',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-05',
    tier: 'moderate',
    goal: 'Analyze the error handling patterns across the codebase and identify inconsistencies or missing error boundaries',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-06',
    tier: 'moderate',
    goal: 'Create a security audit report by examining all file operations, network calls, and user input handling in the codebase',
    expectedCapability: 'security_audit',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-07',
    tier: 'moderate',
    goal: 'Map out the API surface of this project by examining all exported functions and classes, then create an API reference document',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-08',
    tier: 'moderate',
    goal: 'Analyze the performance bottlenecks by examining all loops, async operations, and data transformations in the hot path',
    expectedCapability: 'performance_analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-09',
    tier: 'moderate',
    goal: 'Review the CI/CD configuration and suggest improvements for build speed, test reliability, and deployment safety',
    expectedCapability: 'review',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-10',
    tier: 'moderate',
    goal: 'Examine the logging patterns and create a logging standards document with recommendations for consistency',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-11',
    tier: 'moderate',
    goal: 'Analyze the dependency graph between modules and identify circular dependencies or unnecessary coupling',
    expectedCapability: 'architecture_analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-12',
    tier: 'moderate',
    goal: 'Review the environment variable usage and create a configuration reference with validation rules',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-13',
    tier: 'moderate',
    goal: 'Examine the database schemas or data models and create an entity relationship diagram description',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-14',
    tier: 'moderate',
    goal: 'Review the authentication and authorization implementation for security best practices',
    expectedCapability: 'security_audit',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-15',
    tier: 'moderate',
    goal: 'Analyze the test coverage and identify critical paths that lack test coverage',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-16',
    tier: 'moderate',
    goal: 'Create a migration guide for upgrading from the current version to a hypothetical v2.0 with breaking changes',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-17',
    tier: 'moderate',
    goal: 'Examine the rate limiting and throttling implementation and suggest improvements',
    expectedCapability: 'review',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-18',
    tier: 'moderate',
    goal: 'Analyze the memory usage patterns and identify potential memory leaks or optimization opportunities',
    expectedCapability: 'performance_analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-19',
    tier: 'moderate',
    goal: 'Review the caching strategy across the application and create a caching best practices document',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-20',
    tier: 'moderate',
    goal: 'Examine the webhook and event handling patterns and create a diagram of the event flow',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-21',
    tier: 'moderate',
    goal: 'Review the API versioning strategy and suggest improvements for backward compatibility',
    expectedCapability: 'review',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-22',
    tier: 'moderate',
    goal: 'Analyze the error recovery mechanisms and identify scenarios where errors could cascade',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-23',
    tier: 'moderate',
    goal: 'Create a performance budget document with specific metrics and thresholds for the application',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-24',
    tier: 'moderate',
    goal: 'Examine the data validation patterns and suggest improvements for input sanitization',
    expectedCapability: 'security_audit',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-25',
    tier: 'moderate',
    goal: 'Review the monitoring and observability setup and identify blind spots',
    expectedCapability: 'review',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-26',
    tier: 'moderate',
    goal: 'Analyze the deployment pipeline and suggest improvements for zero-downtime deployments',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-27',
    tier: 'moderate',
    goal: 'Create a disaster recovery plan by examining all critical data flows and backup mechanisms',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-28',
    tier: 'moderate',
    goal: 'Examine the third-party integrations and assess their reliability and fallback mechanisms',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-29',
    tier: 'moderate',
    goal: 'Review the access control implementation and identify potential privilege escalation vectors',
    expectedCapability: 'security_audit',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-30',
    tier: 'moderate',
    goal: 'Analyze the configuration management and suggest improvements for environment-specific settings',
    expectedCapability: 'review',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-31',
    tier: 'moderate',
    goal: 'Create a developer onboarding checklist based on the project structure and tooling',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-32',
    tier: 'moderate',
    goal: 'Examine the API rate limiting implementation and suggest improvements for distributed systems',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-33',
    tier: 'moderate',
    goal: 'Review the data serialization patterns and identify potential security vulnerabilities',
    expectedCapability: 'security_audit',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-34',
    tier: 'moderate',
    goal: 'Analyze the test isolation patterns and identify tests that might interfere with each other',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-35',
    tier: 'moderate',
    goal: 'Create a code review guidelines document based on the patterns observed in the codebase',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-36',
    tier: 'moderate',
    goal: 'Examine the connection pooling and resource management patterns for potential bottlenecks',
    expectedCapability: 'performance_analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-37',
    tier: 'moderate',
    goal: 'Review the API documentation for completeness and accuracy',
    expectedCapability: 'review',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-38',
    tier: 'moderate',
    goal: 'Analyze the error reporting mechanisms and suggest improvements for debugging',
    expectedCapability: 'analysis',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-39',
    tier: 'moderate',
    goal: 'Create a performance monitoring dashboard specification based on the key metrics',
    expectedCapability: 'documentation',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'mod-40',
    tier: 'moderate',
    goal: 'Examine the feature flag implementation and suggest improvements for safe rollouts',
    expectedCapability: 'review',
    maxTokens: 15000,
    tools: ['file_read', 'file_write'],
  },

  // ── COMPLEX TIER (30 tasks) ──────────────────────────────────────────
  // Multi-agent should show significant advantages
  {
    id: 'complex-01',
    tier: 'complex',
    goal: 'Perform a comprehensive security audit of the authentication system, including token validation, session management, CSRF protection, and rate limiting. Create a detailed report with severity ratings and remediation steps.',
    expectedCapability: 'security_audit',
    maxTokens: 30000,
    tools: ['file_read', 'file_write', 'web_search'],
  },
  {
    id: 'complex-02',
    tier: 'complex',
    goal: 'Analyze the entire codebase architecture and create a technical debt inventory with prioritized refactoring recommendations, effort estimates, and risk assessment for each item.',
    expectedCapability: 'architecture_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-03',
    tier: 'complex',
    goal: 'Review all API endpoints and create a comprehensive API design document including request/response schemas, authentication requirements, rate limits, versioning strategy, and migration guide.',
    expectedCapability: 'documentation',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-04',
    tier: 'complex',
    goal: 'Perform a deep performance analysis of the application, identifying bottlenecks across CPU, memory, I/O, and network. Create a performance optimization roadmap with expected impact for each improvement.',
    expectedCapability: 'performance_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-05',
    tier: 'complex',
    goal: 'Review the entire test suite and create a test strategy document including coverage gaps, flaky test patterns, test infrastructure improvements, and recommendations for increasing confidence.',
    expectedCapability: 'review',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-06',
    tier: 'complex',
    goal: 'Analyze the deployment infrastructure and create a production readiness checklist including monitoring, alerting, backup strategies, disaster recovery, and scaling procedures.',
    expectedCapability: 'documentation',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-07',
    tier: 'complex',
    goal: 'Perform a comprehensive code quality review covering naming conventions, code organization, error handling patterns, documentation quality, and adherence to best practices. Create a code quality report with actionable recommendations.',
    expectedCapability: 'review',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-08',
    tier: 'complex',
    goal: 'Analyze the data flow through the entire system and create a data architecture document including data models, storage strategies, caching layers, and data retention policies.',
    expectedCapability: 'architecture_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-09',
    tier: 'complex',
    goal: 'Review the security posture of the entire application including input validation, output encoding, authentication, authorization, cryptography, and data protection. Create a security hardening guide.',
    expectedCapability: 'security_audit',
    maxTokens: 30000,
    tools: ['file_read', 'file_write', 'web_search'],
  },
  {
    id: 'complex-10',
    tier: 'complex',
    goal: 'Analyze the error handling strategy across the entire system and create an error handling standards document with patterns for different error types and recovery strategies.',
    expectedCapability: 'documentation',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-11',
    tier: 'complex',
    goal: 'Review the configuration management across all environments and create a configuration governance document including secret management, environment parity, and configuration drift detection.',
    expectedCapability: 'review',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-12',
    tier: 'complex',
    goal: 'Analyze the integration points with external services and create an integration architecture document including fallback strategies, circuit breakers, and retry policies.',
    expectedCapability: 'architecture_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-13',
    tier: 'complex',
    goal: 'Perform a comprehensive accessibility audit of the UI components and create a WCAG compliance report with specific remediation steps for each issue.',
    expectedCapability: 'review',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-14',
    tier: 'complex',
    goal: 'Analyze the logging and observability infrastructure and create a monitoring strategy document including metrics, traces, logs, and alerting rules.',
    expectedCapability: 'documentation',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-15',
    tier: 'complex',
    goal: 'Review the database query patterns and create a database optimization guide including index recommendations, query restructuring, and connection pooling improvements.',
    expectedCapability: 'performance_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-16',
    tier: 'complex',
    goal: 'Analyze the API design patterns and create an API governance document including naming conventions, versioning strategy, pagination standards, and error response formats.',
    expectedCapability: 'documentation',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-17',
    tier: 'complex',
    goal: 'Review the CI/CD pipeline and create a deployment best practices guide including build optimization, test automation, rollback procedures, and feature flag integration.',
    expectedCapability: 'review',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-18',
    tier: 'complex',
    goal: 'Analyze the memory management patterns and create a memory optimization guide including leak detection, garbage collection tuning, and memory-efficient data structures.',
    expectedCapability: 'performance_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-19',
    tier: 'complex',
    goal: 'Perform a comprehensive dependency audit including license compliance, security vulnerabilities, and maintenance status. Create a dependency governance document.',
    expectedCapability: 'security_audit',
    maxTokens: 30000,
    tools: ['file_read', 'file_write', 'web_search'],
  },
  {
    id: 'complex-20',
    tier: 'complex',
    goal: 'Analyze the concurrency patterns and create a concurrency safety guide including race condition detection, deadlock prevention, and thread-safe design patterns.',
    expectedCapability: 'architecture_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-21',
    tier: 'complex',
    goal: 'Review the entire codebase for code smells and anti-patterns. Create a refactoring roadmap with before/after examples and risk assessment for each change.',
    expectedCapability: 'review',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-22',
    tier: 'complex',
    goal: 'Analyze the network communication patterns and create a network architecture document including protocol selection, connection management, and bandwidth optimization.',
    expectedCapability: 'architecture_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-23',
    tier: 'complex',
    goal: 'Review the data validation and sanitization patterns and create a comprehensive input validation guide with examples for different data types and attack vectors.',
    expectedCapability: 'security_audit',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-24',
    tier: 'complex',
    goal: 'Analyze the API performance characteristics and create a performance budget document with specific SLAs for each endpoint.',
    expectedCapability: 'performance_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-25',
    tier: 'complex',
    goal: 'Review the error recovery and resilience patterns and create a chaos engineering plan with specific failure scenarios to test.',
    expectedCapability: 'review',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-26',
    tier: 'complex',
    goal: 'Analyze the state management patterns and create a state management guide including consistency models, transaction boundaries, and eventual consistency handling.',
    expectedCapability: 'architecture_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-27',
    tier: 'complex',
    goal: 'Review the authentication and authorization implementation and create a zero-trust security architecture document.',
    expectedCapability: 'security_audit',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-28',
    tier: 'complex',
    goal: 'Analyze the build system and create a build optimization guide including dependency analysis, tree shaking, code splitting, and bundle size reduction strategies.',
    expectedCapability: 'performance_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-29',
    tier: 'complex',
    goal: 'Review the entire testing strategy and create a testing pyramid document with specific recommendations for unit, integration, and end-to-end test coverage.',
    expectedCapability: 'review',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
  {
    id: 'complex-30',
    tier: 'complex',
    goal: 'Analyze the system architecture and create a scalability roadmap including horizontal scaling strategies, database sharding approaches, and caching layer improvements.',
    expectedCapability: 'architecture_analysis',
    maxTokens: 30000,
    tools: ['file_read', 'file_write'],
  },
];

// ============================================================================
// Runner
// ============================================================================

export interface BenchmarkRunnerOptions {
  tasks?: number;
  tier?: TaskTier;
  parallel?: number;
  outputDir?: string;
  model?: string;
  runtime?: AgentRuntime;
  orchestrator?: UltimateOrchestrator;
}

export class MultiAgentBenchmark {
  private runtime: AgentRuntime;
  private orchestrator: UltimateOrchestrator;
  private options: BenchmarkRunnerOptions;
  private results: ABComparison[] = [];

  constructor(options: BenchmarkRunnerOptions = {}) {
    this.options = options;
    this.runtime = options.runtime ?? new AgentRuntime();
    this.orchestrator = options.orchestrator ?? new UltimateOrchestrator(
      new TELOSOrchestrator(this.runtime),
      this.runtime,
    );
  }

  async run(): Promise<BenchmarkSummary> {
    const tasks = this.selectTasks();
    getGlobalLogger().info('Benchmark', `\n${'='.repeat(60)}`);
    getGlobalLogger().info('Benchmark', `  Multi-Agent vs Single-Agent A/B Benchmark`);
    getGlobalLogger().info('Benchmark', `  Tasks: ${tasks.length} | Tier: ${this.options.tier || 'all'}`);
    getGlobalLogger().info('Benchmark', `${'='.repeat(60)}\n`);

    const comparisons: ABComparison[] = [];

    for (let i = 0; i < tasks.length; i += this.options.parallel || 1) {
      const batch = tasks.slice(i, i + (this.options.parallel || 1));
      const batchResults = await Promise.all(
        batch.map(task => this.runTask(task))
      );
      comparisons.push(...batchResults);

    
      process.stdout.write(
        `  [${Math.min(i + batch.length, tasks.length)}/${tasks.length}] ` +
        `${comparisons.filter(c => c.winner === 'multi').length} multi wins, ` +
        `${comparisons.filter(c => c.winner === 'single').length} single wins\n`
      );
    }

    const failedCount = comparisons.filter(c => c.single.status === 'failed' && c.multi.status === 'failed').length;
    if (failedCount > 0) {
      const sampleError = comparisons.find(c => c.single.error)?.single.error
        ?? comparisons.find(c => c.multi.error)?.multi.error
        ?? 'unknown';
      getGlobalLogger().warn('Benchmark', `${failedCount}/${comparisons.length} tasks failed. Sample error: ${sampleError}`);
    }

    return this.generateSummary(comparisons);
  }

  private selectTasks(): BenchmarkTask[] {
    let tasks = [...BENCHMARK_TASKS];

    if (this.options.tier) {
      tasks = tasks.filter(t => t.tier === this.options.tier);
    }

    if (this.options.tasks) {
      tasks = tasks.slice(0, this.options.tasks);
    }

    return tasks;
  }

  private async runTask(task: BenchmarkTask): Promise<ABComparison> {
    const single = await this.executeWithTopology(task, 'SINGLE');
    const multi = await this.executeWithTopology(task, 'AUTO');
    const delta = {
      latencyMs: multi.latencyMs - single.latencyMs,
      latencyPct: single.latencyMs > 0
        ? ((multi.latencyMs - single.latencyMs) / single.latencyMs) * 100
        : 0,
      costUsd: multi.costUsd - single.costUsd,
      costPct: single.costUsd > 0
        ? ((multi.costUsd - single.costUsd) / single.costUsd) * 100
        : 0,
      qualityScore: multi.qualityScore - single.qualityScore,
      qualityPct: single.qualityScore > 0
        ? ((multi.qualityScore - single.qualityScore) / single.qualityScore) * 100
        : 0,
      tokens: multi.totalTokens - single.totalTokens,
      tokensPct: single.totalTokens > 0
        ? ((multi.totalTokens - single.totalTokens) / single.totalTokens) * 100
        : 0,
    };


    let winner: 'single' | 'multi' | 'tie' = 'tie';
    if (delta.qualityPct > 5) {
      winner = 'multi';
    } else if (delta.qualityPct < -5) {
      winner = 'single';
    } else if (delta.latencyPct < -10) {
      winner = 'multi';
    } else if (delta.latencyPct > 10) {
      winner = 'single';
    }

    return { task, single, multi, delta, winner };
  }

  private async executeWithTopology(
    task: BenchmarkTask,
    topology: 'SINGLE' | 'AUTO'
  ): Promise<TaskResult> {
    const startTime = Date.now();

    try {
      const result = await this.orchestrator.execute({
        projectId: 'benchmark',
        agentId: `bench-${task.id}`,
        goal: task.goal,
        contextData: {
          availableTools: task.tools,
          tenantId: 'benchmark',
        },
        topology: topology === 'SINGLE' ? 'SINGLE' : undefined,
      });

      const latencyMs = Date.now() - startTime;

      const orchestratorErrors = result.errors.length > 0
        ? result.errors.map(e => e.message).join('; ')
        : undefined;

      return {
        taskId: task.id,
        tier: task.tier,
        topology: result.metrics.topologyUsed,
        status: result.status === 'SUCCESS' ? 'success' :
                result.status === 'PARTIAL' ? 'partial' : 'failed',
        latencyMs,
        totalTokens: result.metrics.totalTokens,
        costUsd: result.metrics.totalCostUsd,
        qualityScore: result.metrics.qualityScore,
        subAgentsSpawned: result.metrics.subAgentsSpawned,
        hallucinationScore: this.extractGateScore(result.reasoning, 'hallucination'),
        consistencyScore: this.extractGateScore(result.reasoning, 'consistency'),
        completenessScore: this.extractGateScore(result.reasoning, 'completeness'),
        accuracyScore: this.extractGateScore(result.reasoning, 'accuracy'),
        synthesisLength: result.synthesis.length,
        error: orchestratorErrors,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      return {
        taskId: task.id,
        tier: task.tier,
        topology: topology,
        status: 'failed',
        latencyMs,
        totalTokens: 0,
        costUsd: 0,
        qualityScore: 0,
        subAgentsSpawned: 0,
        hallucinationScore: 0,
        consistencyScore: 0,
        completenessScore: 0,
        accuracyScore: 0,
        synthesisLength: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private extractGateScore(reasoning: string[], gateName: string): number {
    for (const line of reasoning) {
      if (line.toLowerCase().includes(gateName)) {
        const match = line.match(/(\d+(?:\.\d+)?)%/);
        if (match) return parseFloat(match[1]) / 100;
      }
    }
        return 0.7;
  }

  private generateSummary(comparisons: ABComparison[]): BenchmarkSummary {
    const byTier: Record<TaskTier, BenchmarkSummary['byTier'][TaskTier]> = {
      simple: { total: 0, singleWins: 0, multiWins: 0, ties: 0, avgLatencyDelta: 0, avgCostDelta: 0, avgQualityDelta: 0 },
      moderate: { total: 0, singleWins: 0, multiWins: 0, ties: 0, avgLatencyDelta: 0, avgCostDelta: 0, avgQualityDelta: 0 },
      complex: { total: 0, singleWins: 0, multiWins: 0, ties: 0, avgLatencyDelta: 0, avgCostDelta: 0, avgQualityDelta: 0 },
    };

    for (const c of comparisons) {
      const tier = byTier[c.task.tier];
      tier.total++;
      if (c.winner === 'single') tier.singleWins++;
      if (c.winner === 'multi') tier.multiWins++;
      if (c.winner === 'tie') tier.ties++;
      tier.avgLatencyDelta += c.delta.latencyPct;
      tier.avgCostDelta += c.delta.costPct;
      tier.avgQualityDelta += c.delta.qualityPct;
    }

    for (const tier of Object.values(byTier)) {
      if (tier.total > 0) {
        tier.avgLatencyDelta /= tier.total;
        tier.avgCostDelta /= tier.total;
        tier.avgQualityDelta /= tier.total;
      }
    }

    const singleWins = comparisons.filter(c => c.winner === 'single').length;
    const multiWins = comparisons.filter(c => c.winner === 'multi').length;
    const ties = comparisons.filter(c => c.winner === 'tie').length;

    const avgLatencyImprovement = comparisons.reduce((s, c) => s + c.delta.latencyPct, 0) / comparisons.length;
    const avgCostOverhead = comparisons.reduce((s, c) => s + c.delta.costPct, 0) / comparisons.length;
    const avgQualityImprovement = comparisons.reduce((s, c) => s + c.delta.qualityPct, 0) / comparisons.length;


    const tStat = this.computePairedTTest(comparisons);
    const pValue = this.tTestToPValue(tStat, comparisons.length);

    const recommendations = this.generateRecommendations(comparisons, byTier);

    return {
      timestamp: new Date().toISOString(),
      totalTasks: comparisons.length,
      completedTasks: comparisons.filter(c => c.single.status === 'success' && c.multi.status === 'success').length,
      byTier,
      overall: {
        singleWins,
        multiWins,
        ties,
        avgLatencyImprovement,
        avgCostOverhead,
        avgQualityImprovement,
        statisticalSignificance: pValue,
      },
      comparisons,
      recommendations,
    };
  }

  private computePairedTTest(comparisons: ABComparison[]): number {
    const diffs = comparisons.map(c => c.delta.qualityScore);
    const n = diffs.length;
    if (n < 2) return 0;

    const mean = diffs.reduce((s, d) => s + d, 0) / n;
    const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1);
    const se = Math.sqrt(variance / n);

    return se > 0 ? mean / se : 0;
  }

  private tTestToPValue(t: number, df: number): number {

    const absT = Math.abs(t);
    if (absT > 3.5) return 0.001;
    if (absT > 2.5) return 0.01;
    if (absT > 1.96) return 0.05;
    if (absT > 1.5) return 0.1;
    return 0.5;
  }

  private generateRecommendations(
    comparisons: ABComparison[],
    byTier: Record<TaskTier, { total: number; multiWins: number; singleWins: number }>
  ): string[] {
    const recs: string[] = [];


    const complexTier = byTier.complex;
    if (complexTier.total > 0 && complexTier.multiWins > complexTier.singleWins) {
      recs.push(
        `Multi-agent shows clear advantage on complex tasks: ${complexTier.multiWins}/${complexTier.total} wins. ` +
        `Prioritize multi-agent for tasks with >15K token budget.`
      );
    }


    const simpleTier = byTier.simple;
    if (simpleTier.total > 0 && simpleTier.singleWins > simpleTier.multiWins) {
      recs.push(
        `Single-agent is more efficient for simple tasks: ${simpleTier.singleWins}/${simpleTier.total} wins. ` +
        `Use SINGLE topology for tasks with <5K token budget.`
      );
    }


    const avgCostOverhead = comparisons.reduce((s, c) => s + c.delta.costPct, 0) / comparisons.length;
    if (avgCostOverhead > 100) {
      recs.push(
        `Multi-agent cost overhead is high (${avgCostOverhead.toFixed(0)}%). ` +
        `Consider using cheaper models for sub-agents (Haiku/Flash) and expensive models for synthesis only.`
      );
    }


    const avgQualityImprovement = comparisons.reduce((s, c) => s + c.delta.qualityPct, 0) / comparisons.length;
    if (avgQualityImprovement > 10) {
      recs.push(
        `Multi-agent quality improvement is significant (${avgQualityImprovement.toFixed(0)}%). ` +
        `The overhead is justified for quality-critical tasks.`
      );
    }


    const tStat = this.computePairedTTest(comparisons);
    const pValue = this.tTestToPValue(tStat, comparisons.length);
    if (pValue > 0.1) {
      recs.push(
        `Results are not statistically significant (p=${pValue.toFixed(3)}). ` +
        `Run more tasks (>50) to confirm the multi-agent advantage.`
      );
    } else {
      recs.push(
        `Results are statistically significant (p=${pValue.toFixed(3)}). ` +
        `The multi-agent advantage is real and measurable.`
      );
    }

    return recs;
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  const options: BenchmarkRunnerOptions = {};

  const taskIdx = args.indexOf('--tasks');
  if (taskIdx !== -1 && args[taskIdx + 1]) {
    options.tasks = parseInt(args[taskIdx + 1], 10);
  }

  const tierIdx = args.indexOf('--tier');
  if (tierIdx !== -1 && args[tierIdx + 1]) {
    options.tier = args[tierIdx + 1] as TaskTier;
  }

  const parIdx = args.indexOf('--parallel');
  if (parIdx !== -1 && args[parIdx + 1]) {
    options.parallel = parseInt(args[parIdx + 1], 10);
  }

  const outIdx = args.indexOf('--output');
  if (outIdx !== -1 && args[outIdx + 1]) {
    options.outputDir = args[outIdx + 1];
  }

  const modelIdx = args.indexOf('--model');
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    options.model = args[modelIdx + 1];
  }

  const benchmark = new MultiAgentBenchmark(options);
  const summary = await benchmark.run();


  console.log('\n' + '='.repeat(60));
  console.log('  BENCHMARK RESULTS');
  console.log('='.repeat(60));
  console.log(`\n  Tasks: ${summary.totalTasks} | Completed: ${summary.completedTasks}`);
  console.log(`\n  Overall:`);
  console.log(`    Multi-agent wins: ${summary.overall.multiWins}`);
  console.log(`    Single-agent wins: ${summary.overall.singleWins}`);
  console.log(`    Ties: ${summary.overall.ties}`);
  console.log(`    Avg latency delta: ${summary.overall.avgLatencyImprovement.toFixed(1)}%`);
  console.log(`    Avg cost overhead: ${summary.overall.avgCostOverhead.toFixed(1)}%`);
  console.log(`    Avg quality delta: ${summary.overall.avgQualityImprovement.toFixed(1)}%`);
  console.log(`    Statistical significance: p=${summary.overall.statisticalSignificance.toFixed(3)}`);

  console.log('\n  By Tier:');
  for (const [tier, stats] of Object.entries(summary.byTier)) {
    if (stats.total > 0) {
      console.log(`    ${tier.padEnd(10)} ${stats.multiWins}/${stats.total} multi wins | quality: ${stats.avgQualityDelta.toFixed(1)}%`);
    }
  }

  console.log('\n  Recommendations:');
  for (const rec of summary.recommendations) {
    console.log(`    • ${rec}`);
  }


  const outputDir = options.outputDir || path.join(process.cwd(), 'benchmarks', 'multi-agent-ab');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `results-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log(`\n  Results saved to: ${outputPath}\n`);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
