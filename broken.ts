// broken.ts - A file with multiple TypeScript bugs to be fixed
// Categories: syntax errors, type errors, logic errors, runtime errors

interface User {
  id: number;
  name: string;
  email: string;
  age?: number;
  role: 'admin' | 'user' | 'guest';
}

interface Product {
  id: number;
  title: string;
  price: number;
  inStock: boolean;
  tags: string[];
}

interface Order {
  id: number;
  userId: number;
  products: { productId: number; quantity: number }[];
  status: 'pending' | 'completed' | 'cancelled';
  createdAt: Date;
}

// Bug 1: Missing closing brace, incorrect generic syntax
function findById<T extends { id: number }>(items: T[], id: number): T | undefined {
  return items.find(item => item.id === id);

// Bug 2: Wrong comparison operator (assignment instead of comparison)
function isAdmin(user: User): boolean {
  return user.role = 'admin';
}

// Bug 3: Off-by-one error in loop
function sumPrices(products: Product[]): number {
  let total = 0;
  for (let i = 0; i <= products.length; i++) {
    total += products[i].price;
  }
  return total;
}

// Bug 4: Missing return statement, incorrect array method
function getExpensiveProducts(products: Product[], threshold: number): Product[] {
  const result: Product[] = [];
  products.forEach(product => {
    if (product.price > threshold) {
      result.push(product);
    }
  });
}

// Bug 5: Incorrect null handling, wrong property access
function getUserDisplayName(user: User | null): string {
  return user.name || 'Anonymous';
}

// Bug 6: Type mismatch in return type, incorrect string concatenation
function formatPrice(price: number): string {
  return '$' + price;
}

// Bug 7: Incorrect array destructuring and spread usage
function mergeArrays<T>(arr1: T[], arr2: T[]): T[] {
  return [...arr1, arr2];
}

// Bug 8: Wrong type assertion and missing await
async function fetchUser(id: number): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json() as User;
}

// Bug 9: Incorrect Promise handling, missing async
function processUsers(users: User[]): Promise<string[]> {
  return users.map(async (user) => {
    const processed = await someAsyncOperation(user);
    return processed.name;
  });
}

// Bug 10: Missing type annotation and incorrect enum-like behavior
const StatusCodes = {
  OK: 200,
  NOT_FOUND: 404,
  SERVER_ERROR: 500,
} as const;

type StatusCode = typeof StatusCodes[keyof typeof StatusCodes];

// Bug 11: Incorrect conditional logic (always true)
function filterActiveUsers(users: User[]): User[] {
  return users.filter(user => {
    if (user.age >= 0 || user.age === undefined) {
      return true;
    }
    return false;
  });
}

// Bug 12: Memory leak - closure capturing wrong variable
function createCounterFunctions(count: number): (() => number)[] {
  const counters: (() => number)[] = [];
  for (var i = 0; i < count; i++) {
    counters.push(() => i);
  }
  return counters;
}

// Bug 13: Incorrect generic constraint
function getProperty<T, K>(obj: T, key: K): T[K] {
  return obj[key];
}

// Bug 14: Missing error handling and incorrect type narrowing
function parseJSON<T>(jsonString: string): T {
  return JSON.parse(jsonString);
}

// Bug 15: Race condition with shared mutable state
let globalCounter = 0;
async function incrementCounter(): Promise<number> {
  const current = globalCounter;
  await new Promise(resolve => setTimeout(resolve, 10));
  globalCounter = current + 1;
  return globalCounter;
}

// Bug 16: Incorrect event handler typing
function setupEventHandler(element: HTMLElement | null): void {
  element.addEventListener('click', (event) => {
    console.log(event.target.innerHTML);
  });
}

// Bug 17: Incorrect map transformation losing type safety
function extractIds(items: { id: number; name: string }[]): number[] {
  return items.map(item => item.id.toString());
}

// Bug 18: Incorrect reduce accumulator type
function groupByRole(users: User[]): Record<string, User[]> {
  return users.reduce((acc, user) => {
    if (!acc[user.role]) {
      acc[user.role] = [];
    }
    acc[user.role].push(user);
    return acc;
  }, {});
}

// Bug 19: Incorrect switch statement (missing break)
function getStatusLabel(status: Order['status']): string {
  let label: string;
  switch (status) {
    case 'pending':
      label = 'Pending';
    case 'completed':
      label = 'Completed';
    case 'cancelled':
      label = 'Cancelled';
  }
  return label;
}

// Bug 20: Incorrect type widening in const assertion
function getConfig() {
  return {
    apiUrl: 'https://api.example.com',
    timeout: 5000,
    retries: 3,
    features: ['auth', 'logging', 'cache'],
  } as const;
}

// Bug 21: Incorrect Promise.all usage with mixed types
async function fetchAllData(userId: number): Promise<{ user: User; products: Product[]; orders: Order[] }> {
  const [user, products, orders] = await Promise.all([
    fetchUser(userId),
    fetchProducts(),
    fetchOrders(userId),
  ]);
  return { user, products: products as unknown, orders };
}

// Bug 22: Incorrect optional chaining with method calls
function processUserSafely(user: User | undefined): string {
  return user?.name?.toUpperCase()?.trim() ?? 'Unknown';
}

// Bug 23: Incorrect type guard
function isProduct(obj: unknown): obj is Product {
  return typeof obj === 'object' && obj !== null && 'title' in obj;
}

// Bug 24: Incorrect error class extension
class AppError extends Error {
  constructor(
    message: string,
    public code: number,
    public details?: string
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

// Bug 25: Incorrect template literal type
type EventName = 'click' | 'hover' | 'focus';
type EventHandlerName = `on${EventName}`;
// Should produce: 'onClick' | 'onHover' | 'onFocus'

// Helper functions (declared but referenced above)
function someAsyncOperation(user: User): Promise<User> {
  return Promise.resolve(user);
}

function fetchProducts(): Promise<Product[]> {
  return Promise.resolve([]);
}

function fetchOrders(userId: number): Promise<Order[]> {
  return Promise.resolve([]);
}

// Bug 26: Incorrect index signature usage
interface Dictionary {
  [key: string]: string;
}

function createDictionary(): Dictionary {
  return {
    hello: 'world',
    count: 42, // Bug: number assigned to string index
  };
}

// Bug 27: Incorrect tuple type
type Point3D = [number, number, number];

function createPoint(x: number, y: number, z: number): Point3D {
  return [x, y, z, 0]; // Bug: extra element
}

// Bug 28: Incorrect enum usage
enum Direction {
  Up = 'UP',
  Down = 'DOWN',
  Left = 'LEFT',
  Right = 'RIGHT',
}

function move(direction: Direction): string {
  switch (direction) {
    case Direction.Up:
      return 'Moving up';
    case Direction.Down:
      return 'Moving down';
    case Direction.Left:
      return 'Moving left';
    // Bug: missing Direction.Right case
  }
}

// Bug 29: Incorrect use of 'any' defeating type safety
function processValue(value: any): string {
  return value.nonExistentProperty.deepProperty;
}

// Bug 30: Incorrect callback typing
function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

export {
  User,
  Product,
  Order,
  findById,
  isAdmin,
  sumPrices,
  getExpensiveProducts,
  getUserDisplayName,
  formatPrice,
  mergeArrays,
  fetchUser,
  processUsers,
  StatusCodes,
  StatusCode,
  filterActiveUsers,
  createCounterFunctions,
  getProperty,
  parseJSON,
  incrementCounter,
  setupEventHandler,
  extractIds,
  groupByRole,
  getStatusLabel,
  getConfig,
  fetchAllData,
  processUserSafely,
  isProduct,
  AppError,
  EventName,
  EventHandlerName,
  Dictionary,
  createDictionary,
  Point3D,
  createPoint,
  Direction,
  move,
  processValue,
  debounce,
};
