#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const bfclDatasets = [
  {
    key: '35_scenario_subset',
    label: 'BFCL 35-scenario general subset',
    file: 'benchmarks/bfcl/results_full.json',
    totalField: 'total',
    toolScoreField: 'tool_selection',
    parameterScoreField: 'parameter_accuracy',
    deriveCounts(data) {
      const categories = Object.values(data.by_category ?? {});
      return {
        toolCorrect: categories.reduce((sum, row) => sum + Number(row.t ?? 0), 0),
        parameterCorrect: categories.reduce((sum, row) => sum + Number(row.p ?? 0), 0),
      };
    },
  },
  {
    key: '30_task_subset',
    label: 'BFCL 30-task Commander rerun',
    file: 'docs/benchmark-results/bfcl/results.json',
    totalField: 'total',
    toolScoreField: 'tool_selection_accuracy',
    parameterScoreField: 'parameter_accuracy',
    deriveCounts(data) {
      return {
        toolCorrect: Number(data.tool_correct),
        parameterCorrect: Number(data.param_correct),
      };
    },
  },
  {
    key: '12_core_subset',
    label: 'BFCL 12-core subset',
    file: 'benchmarks/bfcl/results.json',
    totalField: 'total',
    toolScoreField: 'tool_selection',
    parameterScoreField: 'parameter_accuracy',
    deriveCounts(data) {
      return {
        toolCorrect: Number(data.tool_correct),
        parameterCorrect: Number(data.param_correct),
      };
    },
  },
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function formatPercent(correct, total) {
  if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) {
    throw new Error(`Invalid score counts: correct=${correct}, total=${total}`);
  }
  return `${((correct / total) * 100).toFixed(1)}%`;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function verifyBfcl() {
  const summary = readJson('docs/benchmark-results/bfcl/summary.json');
  const rows = [];

  for (const dataset of bfclDatasets) {
    const data = readJson(dataset.file);
    const total = Number(data[dataset.totalField]);
    const counts = dataset.deriveCounts(data);
    const computedTool = formatPercent(counts.toolCorrect, total);
    const computedParameter = formatPercent(counts.parameterCorrect, total);

    assertEqual(data[dataset.toolScoreField], computedTool, `${dataset.file} tool score`);
    assertEqual(data[dataset.parameterScoreField], computedParameter, `${dataset.file} parameter score`);

    const summaryDataset = summary.datasets?.[dataset.key];
    if (!summaryDataset) {
      throw new Error(`docs/benchmark-results/bfcl/summary.json missing ${dataset.key}`);
    }
    assertEqual(summaryDataset.tool_selection_accuracy, computedTool, `${dataset.key} summary tool score`);
    assertEqual(summaryDataset.parameter_accuracy, computedParameter, `${dataset.key} summary parameter score`);

    rows.push({
      label: dataset.label,
      total,
      tool: computedTool,
      parameter: computedParameter,
      file: dataset.file,
    });
  }

  return rows;
}

function main() {
  const rows = verifyBfcl();
  console.log('Benchmark result verification passed');
  for (const row of rows) {
    console.log(`- ${row.label}: ${row.total} cases, tool=${row.tool}, parameter=${row.parameter} (${row.file})`);
  }
}

main();
