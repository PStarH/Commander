# State Management Comparison: Redux Toolkit vs Zustand vs Jotai

> A comprehensive comparison for React + TypeScript applications

## Table of Contents

1. [Overview](#overview)
2. [Redux Toolkit](#1-redux-toolkit)
3. [Zustand](#2-zustand)
4. [Jotai](#3-jotai)
5. [Todo App Code Examples](#todo-app-code-examples)
6. [Bundle Size Analysis](#bundle-size-analysis)
7. [TypeScript Type Safety](#typescript-type-safety)
8. [Testing Approach](#testing-approach)
9. [Decision Matrix](#decision-matrix)
10. [Recommendations](#recommendations)

---

## Overview

| Feature | Redux Toolkit | Zustand | Jotai |
|---------|---------------|---------|-------|
| **Philosophy** | Predictable state container with immutable updates | Minimal, hook-based state | Atomic state model (bottom-up) |
| **Author** | Redux team (Mark Erikson) | Poimandres collective (Daishi Kato) | Poimandres collective (Daishi Kato) |
| **First Release** | 2019 (RTK) | 2020 | 2021 |
| **GitHub Stars** | ~20k+ | ~45k+ | ~16k+ |
| **Core Bundle Size** | ~11-12 kB minzipped | ~1.2 kB minzipped | ~3.1 kB minzipped |
| **Dependencies** | Redux, Immer, Redux-Thunk | None (zero deps) | None (zero deps) |
| **Provider Required** | Yes (`<Provider>`) | No | Yes (`<Provider>`) |

---

## 1. Redux Toolkit

### Architecture & Concepts

Redux Toolkit (RTK) is the official, opinionated toolset for Redux. It wraps Redux core with Immer (for immutable updates), Redux-Thunk (for async), and a rich API for slices, selectors, and middleware.

**Core concepts:**
- **Store**: Single centralized store holding the entire app state
- **Slices**: Grouped reducers + actions using `createSlice`
- **Selectors**: Memoized derived data via `createSelector` / RTK Query
- **Middleware**: Redux-Thunk by default; extensible via `configureStore`
- **Immer Integration**: Write "mutating" logic that produces immutable updates

### Pros

- ✅ **Battle-tested at scale**: Used by Fortune 500 companies, massive ecosystem
- ✅ **Exceptional DevTools**: Redux DevTools with time-travel debugging, action replay, state diff, and remote debugging
- ✅ **RTK Query**: Built-in data fetching & caching layer (eliminates need for React Query in many cases)
- ✅ **Predictable patterns**: Strict unidirectional data flow makes state changes traceable
- ✅ **Rich middleware ecosystem**: Reselect, Redux-Saga, Redux-Observable, etc.
- ✅ **Excellent TypeScript support**: `createSlice`, `createAsyncThunk` have strong type inference
- ✅ **Testing is straightforward**: Pure reducer functions + selector testing
- ✅ **Official Redux documentation**: Among the best in the React ecosystem

### Cons

- ❌ **Verbose boilerplate**: Even with RTK, requires store setup, slice definitions, provider wrapping
- ❌ **Largest bundle size**: ~11-12 kB minzipped (Redux + Immer + RTK)
- ❌ **Steep learning curve**: Concepts like reducers, actions, dispatch, selectors, middleware
- ❌ **Overkill for small apps**: The architecture benefits only emerge at scale
- ❌ **Immer dependency**: Adds ~5 kB; unnecessary overhead if you prefer structural sharing
- ❌ **Provider nesting**: Must wrap entire app in `<Provider store={store}>`
- ❌ **Over-architecture risk**: Teams may over-engineer state that belongs in component state

### Boilerplate Level

**Medium-High** — RTK has significantly reduced traditional Redux boilerplate, but still requires:
- Store configuration
- Slice definitions with reducers
- Provider setup
- Selector definitions
- Dispatch calls via hooks

---

## 2. Zustand

### Architecture & Concepts

Zustand is a minimalist state management library built on React hooks. It uses a flux-like pattern but with an extremely simplified API — no providers, no boilerplate, no context.

**Core concepts:**
- **Store**: Created via `create()` with a function that returns state + actions
- **Hook**: Each store is a React hook (`useStore`)
- **Selectors**: Pass a selector function to `useStore(selector)` for granular subscriptions
- **Middleware**: Composable via `temporal`, `persist`, `immer`, `devtools`, `subscribeWithSelector`
- **No Provider**: Works without wrapping your app (though optional provider exists)

### Pros

- ✅ **Minimal boilerplate**: A complete store in ~10 lines of code
- ✅ **Tiny bundle size**: ~1.2 kB minzipped (zero dependencies!)
- ✅ **Zero provider required**: Can use stores anywhere (outside React components)
- ✅ **Excellent TypeScript support**: Full type inference without manual annotations
- ✅ **Composable middleware**: `devtools()`, `persist()`, `immer()`, `temporal()` — all plug-and-play
- ✅ **Flexible architecture**: Works with flux, MVVM, or any pattern you prefer
- ✅ **Outside-React usage**: `useStore.getState()`, `useStore.setState()` work outside components
- ✅ **Easy learning curve**: Most developers productive in under an hour

### Cons

- ❌ **DevTools not as rich as Redux**: Has devtools middleware, but no time-travel debugging
- ❌ **No built-in data fetching**: Need to pair with React Query/SWR/TanStack Query
- ❌ **No selector memoization built-in**: Must use `useShallow` or custom equality for object selectors
- ❌ **Simpler patterns can blur at scale**: Without conventions, large stores can become disorganized
- ❌ **Community smaller than Redux**: Fewer tutorials, Stack Overflow answers, enterprise examples
- ❌ **Re-render optimization requires care**: Selectors must be stable references or you'll get extra renders

### Boilerplate Level

**Low** — The simplest of all three. A typical store:

```typescript
const useStore = create((set) => ({
  items: [],
  addItem: (item) => set((state) => ({ items: [...state.items, item] })),
}))
```

---

## 3. Jotai

### Architecture & Concepts

Jotai is an atomic state management library inspired by Recoil. It takes a bottom-up approach: state is composed of individual atoms that can be composed, derived, and updated independently.

**Core concepts:**
- **Atoms**: Primitive units of state (`atom(initialValue)`)
- **Derived Atoms**: Computed state from other atoms (`atom((get) => ...)`)
- **Write Atoms**: Atoms that can both read and write (`atom(read, write)`)
- **Provider**: `<Provider>` enables scoped atom state (useful for testing)
- **No boilerplate**: Just define atoms where you need them

### Pros

- ✅ **Atomic model**: Fine-grained reactivity — components only re-render when their specific atoms change
- ✅ **Tiny bundle size**: ~3.1 kB minzipped (zero dependencies)
- ✅ **Derived state is first-class**: `atom((get) => get(countAtom) * 2)` — incredibly powerful
- ✅ **Composable**: Atoms can be composed like LEGO blocks
- ✅ **Excellent TypeScript support**: Full type inference, especially with derived atoms
- ✅ **Scoped state via Provider**: Perfect for testing and multi-instance components
- ✅ **Flexible updates**: `useSetAtom`, `useAtom` — granular hook API
- ✅ **Great for UI-heavy apps**: Natural fit for complex forms, dashboards, editors

### Cons

- ❌ **Atomic sprawl**: Without discipline, atoms can proliferate and become hard to track
- ❌ **No DevTools**: No official devtools integration (community solutions exist but limited)
- ❌ **Learning curve for atoms**: The mental model differs from traditional state management
- ❌ **Less suitable for server state**: No built-in caching/fetching (pair with React Query)
- ❌ **Performance overhead for fine atoms**: Very large atom graphs can have coordination costs
- ❌ **Ecosystem smaller**: Fewer middleware, extensions, and community resources
- ❌ **Provider required**: Must wrap app in `<Provider>` for full functionality

### Boilerplate Level

**Lowest** — Just define atoms inline:

```typescript
const todosAtom = atom<Todo[]>([])
const filterAtom = atom<'all' | 'done' | 'pending'>('all')
const filteredTodosAtom = atom((get) => {
  const todos = get(todosAtom)
  const filter = get(filterAtom)
  // filter logic
})
```

---

## Todo App Code Examples

### Redux Toolkit — Todo App

```typescript
// ==================== store/todosSlice.ts ====================
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export interface Todo {
  id: string
  text: string
  completed: boolean
}

export type FilterType = 'all' | 'active' | 'completed'

interface TodosState {
  items: Todo[]
  filter: FilterType
}

const initialState: TodosState = {
  items: [],
  filter: 'all',
}

const todosSlice = createSlice({
  name: 'todos',
  initialState,
  reducers: {
    addTodo: {
      reducer(state, action: PayloadAction<Todo>) {
        state.items.push(action.payload)
      },
      prepare(text: string) {
        return {
          payload: {
            id: crypto.randomUUID(),
            text,
            completed: false,
          },
        }
      },
    },
    toggleTodo(state, action: PayloadAction<string>) {
      const todo = state.items.find((t) => t.id === action.payload)
      if (todo) {
        todo.completed = !todo.completed
      }
    },
    setFilter(state, action: PayloadAction<FilterType>) {
      state.filter = action.payload
    },
  },
})

export const { addTodo, toggleTodo, setFilter } = todosSlice.actions
export default todosSlice.reducer

// ==================== store/selectors.ts ====================
import { createSelector } from '@reduxjs/toolkit'
import { RootState } from './store'

const selectTodosState = (state: RootState) => state.todos

export const selectAllTodos = createSelector(
  [selectTodosState],
  (todosState) => todosState.items
)

export const selectFilter = createSelector(
  [selectTodosState],
  (todosState) => todosState.filter
)

export const selectFilteredTodos = createSelector(
  [selectAllTodos, selectFilter],
  (todos, filter) => {
    switch (filter) {
      case 'active':
        return todos.filter((t) => !t.completed)
      case 'completed':
        return todos.filter((t) => t.completed)
      default:
        return todos
    }
  }
)

export const selectTodoStats = createSelector([selectAllTodos], (todos) => ({
  total: todos.length,
  active: todos.filter((t) => !t.completed).length,
  completed: todos.filter((t) => t.completed).length,
}))

// ==================== store/store.ts ====================
import { configureStore } from '@reduxjs/toolkit'
import todosReducer from './todosSlice'

export const store = configureStore({
  reducer: {
    todos: todosReducer,
  },
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch

// ==================== store/hooks.ts ====================
import { useDispatch, useSelector } from 'react-redux'
import type { RootState, AppDispatch } from './store'

export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppSelector = useSelector.withTypes<RootState>()

// ==================== index.tsx ====================
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { store } from './store/store'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <App />
  </Provider>
)

// ==================== components/TodoApp.tsx ====================
import React, { useState } from 'react'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { addTodo, toggleTodo, setFilter } from '../store/todosSlice'
import { selectFilteredTodos, selectFilter, selectTodoStats } from '../store/selectors'

export function TodoApp() {
  const [text, setText] = useState('')
  const dispatch = useAppDispatch()
  const todos = useAppSelector(selectFilteredTodos)
  const filter = useAppSelector(selectFilter)
  const stats = useAppSelector(selectTodoStats)

  const handleAdd = () => {
    if (text.trim()) {
      dispatch(addTodo(text.trim()))
      setText('')
    }
  }

  return (
    <div>
      <h1>Todo App (Redux Toolkit)</h1>

      {/* Add Todo */}
      <div>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="What needs to be done?"
        />
        <button onClick={handleAdd}>Add</button>
      </div>

      {/* Filter Tabs */}
      <div>
        {(['all', 'active', 'completed'] as const).map((f) => (
          <button
            key={f}
            style={{ fontWeight: filter === f ? 'bold' : 'normal' }}
            onClick={() => dispatch(setFilter(f))}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Stats */}
      <p>
        {stats.active} items left | {stats.completed} completed | {stats.total} total
      </p>

      {/* Todo List */}
      <ul>
        {todos.map((todo) => (
          <li
            key={todo.id}
            style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}
          >
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => dispatch(toggleTodo(todo.id))}
            />
            {todo.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ==================== __tests__/todosSlice.test.ts ====================
import todosReducer, { addTodo, toggleTodo, setFilter } from '../store/todosSlice'

describe('todosSlice', () => {
  const initialState = { items: [], filter: 'all' as const }

  it('should add a todo', () => {
    const action = addTodo('Buy groceries')
    const newState = todosReducer(initialState, action)
    expect(newState.items).toHaveLength(1)
    expect(newState.items[0].text).toBe('Buy groceries')
    expect(newState.items[0].completed).toBe(false)
  })

  it('should toggle a todo', () => {
    const stateWithTodo = {
      items: [{ id: '1', text: 'Test', completed: false }],
      filter: 'all' as const,
    }
    const newState = todosReducer(stateWithTodo, toggleTodo('1'))
    expect(newState.items[0].completed).toBe(true)
  })

  it('should set filter', () => {
    const newState = todosReducer(initialState, setFilter('completed'))
    expect(newState.filter).toBe('completed')
  })
})

// ==================== __tests__/selectors.test.ts ====================
import { selectFilteredTodos } from '../store/selectors'

describe('selectors', () => {
  it('should filter todos by active', () => {
    const state = {
      todos: {
        items: [
          { id: '1', text: 'Done', completed: true },
          { id: '2', text: 'Active', completed: false },
        ],
        filter: 'active' as const,
      },
    }
    const result = selectFilteredTodos(state)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('2')
  })
})
```

### Zustand — Todo App

```typescript
// ==================== store/todoStore.ts ====================
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

export interface Todo {
  id: string
  text: string
  completed: boolean
}

export type FilterType = 'all' | 'active' | 'completed'

interface TodoState {
  // State
  todos: Todo[]
  filter: FilterType

  // Actions
  addTodo: (text: string) => void
  toggleTodo: (id: string) => void
  setFilter: (filter: FilterType) => void

  // Derived (via selectors, not stored)
  getFilteredTodos: () => Todo[]
  getStats: () => { total: number; active: number; completed: number }
}

export const useTodoStore = create<TodoState>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial state
        todos: [],
        filter: 'all',

        // Actions
        addTodo: (text) =>
          set(
            (state) => ({
              todos: [
                ...state.todos,
                {
                  id: crypto.randomUUID(),
                  text,
                  completed: false,
                },
              ],
            }),
            false,
            'addTodo'
          ),

        toggleTodo: (id) =>
          set(
            (state) => ({
              todos: state.todos.map((todo) =>
                todo.id === id ? { ...todo, completed: !todo.completed } : todo
              ),
            }),
            false,
            'toggleTodo'
          ),

        setFilter: (filter) =>
          set({ filter }, false, 'setFilter'),

        // Derived selectors (in-store for convenience)
        getFilteredTodos: () => {
          const { todos, filter } = get()
          switch (filter) {
            case 'active':
              return todos.filter((t) => !t.completed)
            case 'completed':
              return todos.filter((t) => t.completed)
            default:
              return todos
          }
        },

        getStats: () => {
          const { todos } = get()
          return {
            total: todos.length,
            active: todos.filter((t) => !t.completed).length,
            completed: todos.filter((t) => t.completed).length,
          }
        },
      }),
      {
        name: 'todo-storage', // localStorage key
        partialize: (state) => ({ todos: state.todos }), // Only persist todos, not filter
      }
    ),
    { name: 'TodoStore' } // DevTools label
  )
)

// ==================== components/TodoApp.tsx ====================
import React, { useState } from 'react'
import { useTodoStore } from '../store/todoStore'
import { useShallow } from 'zustand/shallow'

export function TodoApp() {
  const [text, setText] = useState('')

  // Using useShallow for object selectors to avoid unnecessary re-renders
  const { addTodo, toggleTodo, setFilter } = useTodoStore(
    useShallow((state) => ({
      addTodo: state.addTodo,
      toggleTodo: state.toggleTodo,
      setFilter: state.setFilter,
    }))
  )

  const filter = useTodoStore((state) => state.filter)
  const filteredTodos = useTodoStore((state) => state.getFilteredTodos())
  const stats = useTodoStore((state) => state.getStats())

  const handleAdd = () => {
    if (text.trim()) {
      addTodo(text.trim())
      setText('')
    }
  }

  return (
    <div>
      <h1>Todo App (Zustand)</h1>

      {/* Add Todo */}
      <div>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="What needs to be done?"
        />
        <button onClick={handleAdd}>Add</button>
      </div>

      {/* Filter Tabs */}
      <div>
        {(['all', 'active', 'completed'] as const).map((f) => (
          <button
            key={f}
            style={{ fontWeight: filter === f ? 'bold' : 'normal' }}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Stats */}
      <p>
        {stats.active} items left | {stats.completed} completed | {stats.total} total
      </p>

      {/* Todo List */}
      <ul>
        {filteredTodos.map((todo) => (
          <li
            key={todo.id}
            style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}
          >
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => toggleTodo(todo.id)}
            />
            {todo.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ==================== __tests__/todoStore.test.ts ====================
import { renderHook, act } from '@testing-library/react'
import { useTodoStore } from '../store/todoStore'

// Reset store between tests
beforeEach(() => {
  useTodoStore.setState({ todos: [], filter: 'all' })
})

describe('useTodoStore', () => {
  it('should add a todo', () => {
    const { result } = renderHook(() => useTodoStore())

    act(() => {
      result.current.addTodo('Buy groceries')
    })

    expect(result.current.todos).toHaveLength(1)
    expect(result.current.todos[0].text).toBe('Buy groceries')
    expect(result.current.todos[0].completed).toBe(false)
  })

  it('should toggle a todo', () => {
    const { result } = renderHook(() => useTodoStore())

    act(() => {
      result.current.addTodo('Test todo')
    })

    const todoId = result.current.todos[0].id

    act(() => {
      result.current.toggleTodo(todoId)
    })

    expect(result.current.todos[0].completed).toBe(true)
  })

  it('should set filter', () => {
    const { result } = renderHook(() => useTodoStore())

    act(() => {
      result.current.setFilter('completed')
    })

    expect(result.current.filter).toBe('completed')
  })

  it('should filter todos correctly', () => {
    const { result } = renderHook(() => useTodoStore())

    act(() => {
      result.current.addTodo('Done task')
      result.current.addTodo('Active task')
      result.current.toggleTodo(result.current.todos[0].id) // Mark first as done
    })

    act(() => {
      result.current.setFilter('active')
    })

    expect(result.current.getFilteredTodos()).toHaveLength(1)
    expect(result.current.getFilteredTodos()[0].text).toBe('Active task')
  })

  it('should compute stats correctly', () => {
    const { result } = renderHook(() => useTodoStore())

    act(() => {
      result.current.addTodo('Task 1')
      result.current.addTodo('Task 2')
      result.current.addTodo('Task 3')
      result.current.toggleTodo(result.current.todos[0].id)
    })

    const stats = result.current.getStats()
    expect(stats.total).toBe(3)
    expect(stats.active).toBe(2)
    expect(stats.completed).toBe(1)
  })
})

// ==================== Direct state testing (no hooks) ====================
describe('todoStore direct state', () => {
  it('should reset to initial state', () => {
    useTodoStore.setState({ todos: [{ id: '1', text: 'x', completed: true }], filter: 'completed' })
    useTodoStore.setState({ todos: [], filter: 'all' })

    expect(useTodoStore.getState().todos).toHaveLength(0)
    expect(useTodoStore.getState().filter).toBe('all')
  })

  it('should support setState directly', () => {
    useTodoStore.setState({
      todos: [
        { id: '1', text: 'Test', completed: false },
        { id: '2', text: 'Done', completed: true },
      ],
    })

    const stats = useTodoStore.getState().getStats()
    expect(stats.total).toBe(2)
  })
})
```

### Jotai — Todo App

```typescript
// ==================== atoms/todoAtoms.ts ====================
import { atom } from 'jotai'

export interface Todo {
  id: string
  text: string
  completed: boolean
}

export type FilterType = 'all' | 'active' | 'completed'

// ---- Primitive Atoms ----
export const todosAtom = atom<Todo[]>([])
export const filterAtom = atom<FilterType>('all')

// ---- Derived Atoms (read-only) ----
export const filteredTodosAtom = atom((get) => {
  const todos = get(todosAtom)
  const filter = get(filterAtom)

  switch (filter) {
    case 'active':
      return todos.filter((t) => !t.completed)
    case 'completed':
      return todos.filter((t) => t.completed)
    default:
      return todos
  }
})

export const todoStatsAtom = atom((get) => {
  const todos = get(todosAtom)
  return {
    total: todos.length,
    active: todos.filter((t) => !t.completed).length,
    completed: todos.filter((t) => t.completed).length,
  }
})

// ---- Write Atoms (actions) ----
export const addTodoAtom = atom(null, (get, set, text: string) => {
  const newTodo: Todo = {
    id: crypto.randomUUID(),
    text,
    completed: false,
  }
  set(todosAtom, (prev) => [...prev, newTodo])
})

export const toggleTodoAtom = atom(null, (get, set, id: string) => {
  set(todosAtom, (prev) =>
    prev.map((todo) =>
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    )
  )
})

// ---- Alternative: Action Atoms using a pattern ----
// You can also use useSetAtom directly for simple mutations:
// const setTodos = useSetAtom(todosAtom)
// setTodos(prev => [...prev, newTodo])

// ==================== components/TodoApp.tsx ====================
import React, { useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  filterAtom,
  filteredTodosAtom,
  todoStatsAtom,
  addTodoAtom,
  toggleTodoAtom,
} from '../atoms/todoAtoms'

export function TodoApp() {
  const [text, setText] = useState('')

  // Read atoms (components re-render only when these atoms change)
  const filter = useAtomValue(filterAtom)
  const filteredTodos = useAtomValue(filteredTodosAtom)
  const stats = useAtomValue(todoStatsAtom)

  // Write atoms
  const addTodo = useSetAtom(addTodoAtom)
  const toggleTodo = useSetAtom(toggleTodoAtom)
  const setFilter = useSetAtom(filterAtom)

  const handleAdd = () => {
    if (text.trim()) {
      addTodo(text.trim())
      setText('')
    }
  }

  return (
    <div>
      <h1>Todo App (Jotai)</h1>

      {/* Add Todo */}
      <div>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="What needs to be done?"
        />
        <button onClick={handleAdd}>Add</button>
      </div>

      {/* Filter Tabs */}
      <div>
        {(['all', 'active', 'completed'] as const).map((f) => (
          <button
            key={f}
            style={{ fontWeight: filter === f ? 'bold' : 'normal' }}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Stats */}
      <p>
        {stats.active} items left | {stats.completed} completed | {stats.total} total
      </p>

      {/* Todo List */}
      <ul>
        {filteredTodos.map((todo) => (
          <li
            key={todo.id}
            style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}
          >
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => toggleTodo(todo.id)}
            />
            {todo.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ==================== __tests__/todoAtoms.test.ts ====================
import { getDefaultStore } from 'jotai'
import {
  todosAtom,
  filterAtom,
  filteredTodosAtom,
  todoStatsAtom,
  addTodoAtom,
  toggleTodoAtom,
} from '../atoms/todoAtoms'

// For Jotai v2+, use getDefaultStore() or create a test store
const store = getDefaultStore()

beforeEach(() => {
  store.set(todosAtom, [])
  store.set(filterAtom, 'all')
})

describe('todoAtoms', () => {
  it('should add a todo via addTodoAtom', () => {
    store.set(addTodoAtom, 'Buy groceries')

    const todos = store.get(todosAtom)
    expect(todos).toHaveLength(1)
    expect(todos[0].text).toBe('Buy groceries')
    expect(todos[0].completed).toBe(false)
  })

  it('should toggle a todo', () => {
    store.set(addTodoAtom, 'Test todo')
    const todoId = store.get(todosAtom)[0].id

    store.set(toggleTodoAtom, todoId)

    expect(store.get(todosAtom)[0].completed).toBe(true)
  })

  it('should filter todos correctly', () => {
    store.set(addTodoAtom, 'Done task')
    store.set(addTodoAtom, 'Active task')

    // Toggle first todo to completed
    const firstId = store.get(todosAtom)[0].id
    store.set(toggleTodoAtom, firstId)

    // Set filter to 'active'
    store.set(filterAtom, 'active')

    const filtered = store.get(filteredTodosAtom)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].text).toBe('Active task')
  })

  it('should compute stats correctly', () => {
    store.set(addTodoAtom, 'Task 1')
    store.set(addTodoAtom, 'Task 2')
    store.set(addTodoAtom, 'Task 3')

    // Complete first task
    const firstId = store.get(todosAtom)[0].id
    store.set(toggleTodoAtom, firstId)

    const stats = store.get(todoStatsAtom)
    expect(stats.total).toBe(3)
    expect(stats.active).toBe(2)
    expect(stats.completed).toBe(1)
  })

  it('should set filter', () => {
    store.set(filterAtom, 'completed')
    expect(store.get(filterAtom)).toBe('completed')
  })
})

// ==================== React Testing with Provider ====================
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'jotai'
import { TodoApp } from '../components/TodoApp'

describe('TodoApp', () => {
  it('renders and adds a todo', () => {
    render(
      <Provider>
        <TodoApp />
      </Provider>
    )

    const input = screen.getByPlaceholderText('What needs to be done?')
    fireEvent.change(input, { target: { value: 'New task' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByText('New task')).toBeInTheDocument()
    expect(screen.getByText('1 items left')).toBeInTheDocument()
  })
})
```

---

## Bundle Size Analysis

### Minified + Gzipped Sizes (approximate, 2024 versions)

| Package | Min Size | Gzipped | Dependencies | Total Gzipped |
|---------|----------|---------|--------------|---------------|
| **@reduxjs/toolkit** | ~22 kB | ~11.2 kB | redux (~5.7 kB), immer (~5.1 kB), reselect | **~11.2 kB** |
| **zustand** | ~3.4 kB | ~1.2 kB | None | **~1.2 kB** |
| **jotai** | ~8.5 kB | ~3.1 kB | None | **3.1 kB** |
| **react-redux** (required for RTK) | ~7 kB | ~3.2 kB | React, use-sync-external-store | **~3.2 kB** |

### Effective Bundle Impact

| Approach | Core Library | Required Extras | Total Effective |
|----------|-------------|-----------------|-----------------|
| **Redux Toolkit** | ~11.2 kB | react-redux ~3.2 kB | **~14.4 kB** |
| **Zustand** | ~1.2 kB | None (persist optional) | **~1.2 kB** |
| **Jotai** | ~3.1 kB | None | **3.1 kB** |

### Size Comparison (Visual)

```
Redux Toolkit: ████████████████████████████ (~14.4 kB)
Jotai:         ██████ (~3.1 kB)
Zustand:       ██ (~1.2 kB)

Redux is ~12x larger than Zustand
Redux is ~4.6x larger than Jotai
Jotai is ~2.6x larger than Zustand
```

### When Size Matters

- **Mobile-first apps / PWA**: Every kB counts. Zustand's 1.2 kB is ideal.
- **Enterprise apps**: Size rarely matters as much; RTK's ecosystem value may outweigh size.
- **Micro-frontends**: Smaller bundles reduce initial load. Zustand/Jotai are better.
- **Server-side rendering**: All three work with SSR; bundle size affects client hydration.

---

## TypeScript Type Safety

### Redux Toolkit

```typescript
// ✅ Strongest type inference with createSlice
const todosSlice = createSlice({
  name: 'todos',
  initialState,
  reducers: {
    addTodo: { /* prepare + reducer */ },
    toggleTodo: (state, action: PayloadAction<string>) => { /* ... */ },
  },
})

// ✅ Types are inferred for actions
dispatch(addTodo('text'))      // ✅ text is string
dispatch(toggleTodo('id'))     // ✅ id is string
dispatch(addTodo(123))         // ❌ TypeScript error!

// ✅ Selector types are inferred
const selectTodos = createSelector(
  [(state: RootState) => state.todos],
  (todos) => todos.items
)
// Return type is Todo[] — fully inferred

// ✅ RTK Query generates typed hooks automatically
const { data } = useGetTodosQuery()
// data is Todo[] — fully typed from endpoint definition
```

**Rating: 9/10** — Excellent inference with `createSlice`, `createAsyncThunk`, and RTK Query. Manual type annotation rarely needed.

### Zustand

```typescript
// ✅ Full type inference from create<T>()
interface TodoState {
  todos: Todo[]
  filter: FilterType
  addTodo: (text: string) => void
  toggleTodo: (id: string) => void
  setFilter: (filter: FilterType) => void
}

const useTodoStore = create<TodoState>()((set) => ({
  todos: [],
  filter: 'all',
  addTodo: (text) => set((state) => ({ /* ... */ })),
  // ...
}))

// ✅ Store is fully typed
useTodoStore((state) => state.todos)           // Todo[]
useTodoStore((state) => state.addTodo)         // (text: string) => void
useTodoStore.getState().toggleTodo('id')       // ✅ typed

// ✅ Middleware preserves types
const useStore = create<MyState>()(
  devtools(
    persist(
      (set) => ({ /* ... */ }),
      { name: 'test' }
    )
  )
)
// All types preserved through middleware chain
```

**Rating: 9/10** — Excellent type inference. Minor friction with complex middleware composition, but overwhelmingly strong.

### Jotai

```typescript
// ✅ Primitive atoms infer types automatically
const todosAtom = atom<Todo[]>([])           // atom<Todo[]>
const filterAtom = atom<FilterType>('all')   // atom<FilterType>

// ✅ Derived atoms infer return types
const filteredTodosAtom = atom((get) => {
  const todos = get(todosAtom)    // Todo[]
  const filter = get(filterAtom)  // FilterType
  return todos.filter(/* ... */)  // Return type: Todo[]
})
// filteredTodosAtom type is WritableAtom<Todo[], [], Todo[]>
// useAtomValue returns Todo[] ✅

// ✅ Write atoms with parameters
const addTodoAtom = atom(null, (get, set, text: string) => {
  // text is typed as string ✅
  set(todosAtom, (prev) => [...prev, { id: crypto.randomUUID(), text, completed: false }])
})

// ✅ Hook types are inferred
const [todos, setTodos] = useAtom(todosAtom)
// todos: Todo[]
// setTodos: (update: Todo[] | ((prev: Todo[]) => Todo[])) => void

const addTodo = useSetAtom(addTodoAtom)
addTodo('Buy groceries')  // ✅
addTodo(123)              // ❌ TypeScript error!
```

**Rating: 8/10** — Very good type inference for atoms and derived atoms. Complex atom compositions (atom with getter + setter overloads) can require explicit typing. Read-only vs writable atom distinction sometimes requires attention.

### Summary

| Aspect | Redux Toolkit | Zustand | Jotai |
|--------|:------------:|:-------:|:-----:|
| **Action type inference** | ✅ Automatic | ✅ Automatic | ✅ Automatic |
| **Selector return types** | ✅ Inferred | ✅ Inferred | ✅ Inferred |
| **Middleware type preservation** | ✅ Good | ✅ Good | ✅ Good |
| **Reducer type safety** | ✅ Immer + TypeScript | N/A (set-based) | N/A (set-based) |
| **Async action types** | ✅ createAsyncThunk | Manual (usually fine) | Manual (usually fine) |
| **Overall Type Safety** | **9/10** | **9/10** | **8/10** |

---

## Testing Approach

### Redux Toolkit Testing

**Strategy: Pure function testing (reducers + selectors) + integration testing**

```typescript
// Unit Test: Reducer (pure function, no store needed)
import todosReducer, { addTodo, toggleTodo } from '../store/todosSlice'

test('addTodo reducer', () => {
  const state = { items: [], filter: 'all' }
  const result = todosReducer(state, addTodo('Test'))
  expect(result.items).toHaveLength(1)
})

// Unit Test: Selectors (pure functions)
test('selectFilteredTodos', () => {
  const state = {
    todos: {
      items: [
        { id: '1', text: 'Done', completed: true },
        { id: '2', text: 'Active', completed: false },
      ],
      filter: 'active',
    },
  }
  expect(selectFilteredTodos(state)).toHaveLength(1)
})

// Integration Test: Full component with Provider
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { TodoApp } from '../components/TodoApp'
import todosReducer from '../store/todosSlice'

function renderWithProviders(ui: React.ReactElement, preloadedState?: any) {
  const store = configureStore({
    reducer: { todos: todosReducer },
    preloadedState,
  })
  return { store, ...render(<Provider store={store}>{ui}</Provider>) }
}

test('renders and adds todos', async () => {
  renderWithProviders(<TodoApp />)
  // ... interaction tests
})
```

**Pros:**
- Reducers are pure functions → trivially testable
- Selectors are pure functions → trivially testable
- `configureStore` with `preloadedState` enables clean integration tests
- Mock store is available for middleware testing

### Zustand Testing

**Strategy: Direct state manipulation + renderHook for component integration**

```typescript
// Unit Test: Direct state manipulation (NO React needed!)
import { useTodoStore } from '../store/todoStore'

beforeEach(() => {
  useTodoStore.setState({ todos: [], filter: 'all' })
})

test('addTodo', () => {
  useTodoStore.getState().addTodo('Test')
  expect(useTodoStore.getState().todos).toHaveLength(1)
})

test('toggleTodo', () => {
  useTodoStore.getState().addTodo('Test')
  const id = useTodoStore.getState().todos[0].id
  useTodoStore.getState().toggleTodo(id)
  expect(useTodoStore.getState().todos[0].completed).toBe(true)
})

// Integration Test: renderHook
import { renderHook, act } from '@testing-library/react'

test('hook integration', () => {
  const { result } = renderHook(() => useTodoStore())
  act(() => result.current.addTodo('Test'))
  expect(result.current.todos).toHaveLength(1)
})

// Component Test
import { render, screen } from '@testing-library/react'

test('TodoApp renders and adds todos', () => {
  render(<TodoApp />)
  // ... interaction tests
})
```

**Pros:**
- `setState` makes test setup trivially simple
- No Provider wrapper needed in tests
- Store can be tested without React (pure JS testing)
- `reset` or manual setState for isolation

**Cons:**
- `useShallow` in selectors makes snapshot testing slightly harder

### Jotai Testing

**Strategy: Store-level atom testing + Provider-scoped component testing**

```typescript
// Unit Test: Atom logic via store
import { getDefaultStore } from 'jotai'
import { todosAtom, filterAtom, filteredTodosAtom, addTodoAtom, toggleTodoAtom } from '../atoms/todoAtoms'

const store = getDefaultStore()

beforeEach(() => {
  store.set(todosAtom, [])
  store.set(filterAtom, 'all')
})

test('addTodoAtom', () => {
  store.set(addTodoAtom, 'Test')
  expect(store.get(todosAtom)).toHaveLength(1)
})

test('filteredTodosAtom', () => {
  store.set(addTodoAtom, 'Done')
  store.set(addTodoAtom, 'Active')
  store.set(toggleTodoAtom, store.get(todosAtom)[0].id)
  store.set(filterAtom, 'active')
  expect(store.get(filteredTodosAtom)).toHaveLength(1)
})

// Component Test: Provider-scoped (isolation!)
import { Provider } from 'jotai'

test('TodoApp in isolated scope', () => {
  const store = getDefaultStore()
  render(
    <Provider store={store}>
      <TodoApp />
    </Provider>
  )
  // ... interaction tests
  // Each test gets atomically isolated state
})
```

**Pros:**
- Provider scope enables perfect test isolation
- `getDefaultStore()` for quick atom-level testing
- Derived atoms test as pure functions via `store.get()`
- Each test can have its own Provider with fresh atoms

**Cons:**
- More setup for Provider-scoped tests
- Less documentation/community examples than Redux

### Testing Comparison

| Aspect | Redux Toolkit | Zustand | Jotai |
|--------|:------------:|:-------:|:-----:|
| **Unit testing ease** | ✅ Excellent | ✅ Excellent | ✅ Good |
| **No-provider testing** | ❌ Need Provider | ✅ Direct | ✅ Via store |
| **Test isolation** | ✅ configureStore | ✅ setState reset | ✅ Provider scope |
| **Component integration** | ✅ renderWithProviders | ✅ renderHook | ✅ Provider wrapper |
| **Mock setup** | ⚠️ Moderate | ✅ Minimal | ✅ Minimal |
| **Async testing** | ✅ Thunk testing utils | ⚠️ Manual | ⚠️ Manual |
| **Overall Testing Score** | **9/10** | **9/10** | **7/10** |

---

## Decision Matrix

### Scoring (1-10, higher is better)

| Dimension | Redux Toolkit | Zustand | Jotai | Notes |
|-----------|:------------:|:-------:|:-----:|-------|
| **Bundle Size** | 3 | **10** | 8 | RTK: ~14.4 kB, Zustand: ~1.2 kB, Jotai: ~3.1 kB |
| **Type Safety** | **9** | **9** | 8 | RTK & Zustand tied; Jotai's atom composition can be complex |
| **Learning Curve** | 5 | **9** | 7 | RTK has many concepts; Zustand is minimal; Jotai's atom model is new |
| **DevTools** | **10** | 8 | 4 | RTK has best-in-class DevTools; Zustand has devtools middleware; Jotai lacks official DevTools |
| **Performance** | 7 | 8 | **9** | Jotai's atomic model provides finest-grained re-renders; Zustand's selectors help; RTK relies on memoization |
| **Testing** | **9** | **9** | 7 | RTK & Zustand have excellent testing patterns; Jotai requires Provider setup |
| **Community** | **10** | 7 | 6 | Redux has largest community; Zustand growing fast; Jotai smaller |
| **Maintenance** | **10** | 8 | 7 | Redux backed by Redux team; Zustand/Jotai maintained by Poimandres |

### Totals

| Library | Score | Rank |
|---------|:-----:|:----:|
| **Zustand** | **68** | 🥇 |
| **Redux Toolkit** | **63** | 🥈 |
| **Jotai** | **56** | 🥉 |

### Visual Radar Chart (Text)

```
            Bundle  TypeSafe  LearnCurve  DevTools  Perf   Test  Comm  Maint
Redux TK:   ███░░░  █████░░   ███░░░░     ██████░   ███░   ████  █████ █████
Zustand:    ██████  █████░    █████░░     ████░░░   ████   ████  ███░  ████░
Jotai:      ████░░  ████░     ████░░░     ██░░░░░   █████  ███░  ███░  ███░░
```

---

## Recommendations

### Choose Redux Toolkit when:

- 🏢 **Building a large-scale enterprise application** with multiple teams
- 🔍 **Debugging is critical** — you need time-travel debugging and full action history
- 📊 **Complex async workflows** — RTK Query or Redux-Saga for orchestration
- 📚 **Team has Redux experience** — leverage existing knowledge
- 🔒 **Strict architectural patterns** are required by organizational standards
- 📈 **Long-term maintenance** by large teams with high turnover

### Choose Zustand when:

- ⚡ **Bundle size is critical** — smallest of all three (1.2 kB!)
- 🚀 **Rapid prototyping** — get started in minutes with minimal boilerplate
- 🧩 **Mixed client/server state** — perfect complement to React Query
- 📱 **Mobile/SSR apps** — minimal overhead, no provider needed
- 👨‍💻 **Small-to-medium teams** — less ceremony, more productivity
- 🔄 **Flexible architecture** — works with any pattern (flux, MVVM, etc.)

### Choose Jotai when:

- 🎯 **Complex derived state** — atoms compose beautifully for computed values
- 🖼️ **UI-heavy applications** — dashboards, editors, form-heavy apps
- ⚛️ **Fine-grained reactivity matters** — components only re-render when their atoms change
- 🧪 **Test isolation is important** — Provider-scoped atoms
- 📐 **Bottom-up state design** — state modeled close to where it's used
- 🔄 **Multiple independent state regions** — atoms don't affect each other

### Decision Flowchart

```
Do you need time-travel debugging?
├── YES → Redux Toolkit
└── NO →
    Is bundle size critical? (< 2 kB)
    ├── YES → Zustand
    └── NO →
        Do you have complex derived/computed state?
        ├── YES → Jotai
        └── NO →
            How large is your team?
            ├── Large (10+) → Redux Toolkit
            ├── Medium (3-10) → Zustand
            └── Small (1-3) → Zustand (or Jotai for UI-heavy)
```

---

## Migration Effort Estimate

| From → To | Effort | Notes |
|-----------|--------|-------|
| Redux → Zustand | Medium | Replace slices with stores; simplify actions; update tests |
| Redux → Jotai | High | Fundamental paradigm shift from store to atoms |
| Zustand → Redux | High | Add boilerplate, Provider, slices, selectors |
| Zustand → Jotai | Medium | Replace stores with atoms; different mental model |
| Jotai → Zustand | Medium | Replace atoms with store(s); centralized vs decentralized |
| Jotai → Redux | High | Major architectural change |

---

## Final Verdict

| Criteria | Winner |
|----------|--------|
| **Overall Best (balanced)** | 🏆 **Zustand** — best balance of simplicity, performance, DX, and size |
| **Enterprise / Large Scale** | 🏆 **Redux Toolkit** — unmatched ecosystem, DevTools, and patterns |
| **UI Performance** | 🏆 **Jotai** — atomic model provides finest-grained reactivity |
| **Smallest Bundle** | 🏆 **Zustand** — 1.2 kB, zero dependencies |
| **Best DevTools** | 🏆 **Redux Toolkit** — time-travel, action replay, state diff |
| **Easiest to Learn** | 🏆 **Zustand** — productive in under an hour |

---

*Document generated: 2025 | All bundle sizes are approximate and may vary by version*
