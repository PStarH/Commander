import { describe, it, expect } from 'vitest';
import {
  LocalEmbeddingFunction,
  cosineSimilarity,
  MockEmbeddingFunction,
} from '../../src/runtime/embedding';

describe('LocalEmbeddingFunction', () => {
  const embedder = new LocalEmbeddingFunction();

  it('has correct dimension', () => {
    expect(embedder.dimension).toBe(256);
  });

  it('generates vectors of correct length', () => {
    const vec = embedder.generate('hello world');
    expect(vec).toHaveLength(256);
  });

  it('generates deterministic output for same input', () => {
    const vec1 = embedder.generate('test input');
    const vec2 = embedder.generate('test input');
    expect(vec1).toEqual(vec2);
  });

  it('generates different vectors for different inputs', () => {
    const vec1 = embedder.generate('hello world');
    const vec2 = embedder.generate('goodbye universe');
    const sim = cosineSimilarity(vec1, vec2);
    expect(sim).toBeLessThan(0.9);
  });

  it('produces unit-length vectors (L2 normalized)', () => {
    const vec = embedder.generate('normalize me');
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it('similar texts have higher cosine similarity than dissimilar', () => {
    const vec1 = embedder.generate('How do I read a file in Python?');
    const vec2 = embedder.generate('Reading files with Python code');
    const vec3 = embedder.generate('The weather in Tokyo is sunny today');

    const simSimilar = cosineSimilarity(vec1, vec2);
    const simDissimilar = cosineSimilarity(vec1, vec3);
    expect(simSimilar).toBeGreaterThan(simDissimilar);
  });

  it('handles short text gracefully', () => {
    const vec = embedder.generate('hi');
    expect(vec).toHaveLength(256);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it('handles empty string', () => {
    const vec = embedder.generate('');
    expect(vec).toHaveLength(256);
  });

  it('handles very long text', () => {
    const longText = 'word '.repeat(10000);
    const vec = embedder.generate(longText);
    expect(vec).toHaveLength(256);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it('handles CJK characters', () => {
    const vec = embedder.generate('你好世界这是一个测试');
    expect(vec).toHaveLength(256);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const vec = [1, 0, 0, 0];
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 6);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 6);
  });

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 6);
  });

  it('handles zero vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

describe('MockEmbeddingFunction', () => {
  const mock = new MockEmbeddingFunction();

  it('has dimension 64', () => {
    expect(mock.dimension).toBe(64);
  });

  it('generates deterministic output', () => {
    const vec1 = mock.generate('test');
    const vec2 = mock.generate('test');
    expect(vec1).toEqual(vec2);
  });
});
