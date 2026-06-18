// File: broken.ts
// A TypeScript file with 3 intentional bugs that need fixing

/**
 * Calculates the intersection of two arrays.
 */
function intersection<T>(a: T[], b: T[]): T[] {
  const setB = new Set(b);
  return a.filter((item): boolean => {
    return setB.has(item);
  });
}

/**
 * Formats a user object into a display string.
 */
function formatUser(user: { name: string; age: number; email: string }): string {
  return `${user.name} (${user.age}) - ${user.email}`;
}

/**
 * Processes a batch of items using the transform function.
 * Bug 3: transform() is defined below, but processBatch calls it here.
 */
function processBatch<T>(items: T[]): T[] {
  return items.map((item) => transform(item));
}

/**
 * Transforms an item by applying a set of transformations.
 * This function should be defined BEFORE processBatch, since processBatch calls it directly.
 */
function transform<T>(item: T): T {
  console.log('Transforming:', item);
  return item;
}

// Usage examples
const numbers1 = [1, 2, 3, 4, 5];
const numbers2 = [3, 4, 5, 6, 7];
const common = intersection(numbers1, numbers2);
console.log('Intersection:', common);

const user = { name: 'Alice', age: 30, email: 'alice@example.com' };
const formatted = formatUser(user);
console.log('Formatted:', formatted);

const items = [1, 2, 3, 4, 5];
const processed = processBatch(items);
console.log('Processed:', processed);
