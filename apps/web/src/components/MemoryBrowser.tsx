import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input, Select, Button, Card } from './ui';
import type { ProjectMemoryItem, MemoryOverview, MemoryKindFilter } from '../types';
import { MEMORY_KIND_OPTIONS, formatTimestamp } from '../types';

interface MemoryBrowserProps {
  items: ProjectMemoryItem[];
  overview: MemoryOverview | null;
  onSearch: (filters?: { query?: string; kind?: MemoryKindFilter; tags?: string }) => void;
}

const kindColors: Record<string, string> = {
  DECISION: '#4de98c',
  ISSUE: '#ffcc66',
  LESSON: '#9cc4df',
  SUMMARY: '#9cc4df',
};

const PAGE_SIZE = 12;

export function MemoryBrowser({ items, overview, onSearch }: MemoryBrowserProps) {
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<MemoryKindFilter>('ALL');
  const [tagFilter, setTagFilter] = useState('');
  const [displayLimit, setDisplayLimit] = useState(PAGE_SIZE);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setDisplayLimit(PAGE_SIZE);
    onSearch({ query, kind: kindFilter, tags: tagFilter });
  };

  const handleClear = () => {
    setQuery('');
    setKindFilter('ALL');
    setTagFilter('');
    setDisplayLimit(PAGE_SIZE);
    onSearch({ query: '', kind: 'ALL', tags: '' });
  };

  const visibleItems = items.slice(0, displayLimit);
  const hasMore = displayLimit < items.length;

  return (
    <div className="memory-browser">
      <div className="section-head">
        <div>
          <div className="section-label">Knowledge Base</div>
          <h2>Project Memory</h2>
        </div>
        <span className="section-tag">{items.length} items</span>
      </div>

      {overview && (
        <div className="memory-overview">
          <div className="memory-stats">
            <div className="stat-card">
              <span>Total</span>
              <strong>{overview.totalItems}</strong>
            </div>
            <div className="stat-card">
              <span>Lessons</span>
              <strong>{overview.kindCounts.LESSON}</strong>
            </div>
            <div className="stat-card">
              <span>Decisions</span>
              <strong>{overview.kindCounts.DECISION}</strong>
            </div>
            <div className="stat-card">
              <span>Issues</span>
              <strong>{overview.kindCounts.ISSUE}</strong>
            </div>
            <div className="stat-card">
              <span>Summaries</span>
              <strong>{overview.kindCounts.SUMMARY}</strong>
            </div>
          </div>

          {overview.topTags.length > 0 && (
            <div className="tag-cloud">
              {overview.topTags.map((item) => (
                <button
                  key={item.tag}
                  type="button"
                  className={`tag-chip ${tagFilter === item.tag ? 'active' : ''}`}
                  onClick={() => {
                    setTagFilter(item.tag);
                    onSearch({ query, kind: kindFilter, tags: item.tag });
                  }}
                >
                  {item.tag}
                  <span className="tag-count">{item.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <form className="memory-search" onSubmit={handleSearch}>
        <div className="search-wrap">
          <Search size={14} className="search-icon" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory content..."
          />
        </div>
        <Select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as MemoryKindFilter)}
        >
          {MEMORY_KIND_OPTIONS.map((kind) => (
            <option key={kind} value={kind}>
              {kind === 'ALL' ? 'all kinds' : kind}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary">
          <Search size={14} />
          Search
        </Button>
        <Button type="button" variant="ghost" onClick={handleClear}>
          <X size={14} />
          Clear
        </Button>
      </form>

      <div className="memory-list">
        {items.length === 0 && <div className="empty">No distilled memories yet</div>}
        {visibleItems.map((item) => (
          <Card key={item.id} className="memory-item">
            <div className="memory-item-head">
              <span className="memory-item-title">{item.title}</span>
              <span
                className="memory-kind"
                style={{
                  borderColor: kindColors[item.kind] || '#1b242d',
                  color: kindColors[item.kind] || '#9cc4df',
                }}
              >
                {item.kind}
              </span>
            </div>
            <div className="memory-item-body">{item.content}</div>
            <div className="memory-item-meta">
              <span>{formatTimestamp(item.createdAt)}</span>
              {item.tags.length > 0 && (
                <>
                  <span>·</span>
                  <span>{item.tags.map((t) => `#${t}`).join(' ')}</span>
                </>
              )}
            </div>
          </Card>
        ))}
        {hasMore && (
          <div className="memory-load-more">
            <Button variant="ghost" onClick={() => setDisplayLimit((prev) => prev + PAGE_SIZE)}>
              Load more ({items.length - displayLimit} remaining)
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
