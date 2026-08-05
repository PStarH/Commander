import { tryComposeCellDown } from './l4-b-cell-compose.js';

const result = tryComposeCellDown();
if (!result.ok) {
  console.error(result.error ?? 'Cell compose teardown failed');
  process.exit(1);
}
