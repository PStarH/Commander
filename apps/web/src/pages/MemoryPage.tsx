import { MemoryBrowser } from '../components/MemoryBrowser';
import type { ProjectMemoryItem, MemoryOverview, MemoryKindFilter } from '../types';

interface MemoryPageProps {
  items: ProjectMemoryItem[];
  overview: MemoryOverview | null;
  onSearch: (filters?: { query?: string; kind?: MemoryKindFilter; tags?: string }) => void;
}

export function MemoryPage({ items, overview, onSearch }: MemoryPageProps) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Knowledge</div>
          <h1>Memory Browser</h1>
        </div>
        <p className="page-desc">
          Search and browse distilled lessons, decisions, issues, and summaries from past missions.
        </p>
      </div>
      <MemoryBrowser
        items={items}
        overview={overview}
        onSearch={onSearch}
      />
    </div>
  );
}
