import { CostPanel } from '../components/CostPanel';
import { TokenTrendChart } from '../components/TokenTrendChart';

export function CostPage() {
  return (
    <div className="page cost-page">
      <CostPanel />
      <TokenTrendChart data={[]} series={[]} title="Token Cost Breakdown" />
    </div>
  );
}
