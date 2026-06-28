/**
 * CostPage — Dedicated page for the enterprise cost dashboard.
 *
 * Wraps the CostDashboard component in the standard page layout.
 * Accessible via the /cost route in the sidebar.
 */
import { DollarSign } from 'lucide-react';
import { CostDashboard } from '../components/CostDashboard';

export function CostPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Cost Transparency</div>
          <h1>Cost Dashboard</h1>
        </div>
        <p className="page-desc">
          Granular cost analytics aggregated by model, tool, user, and time period.
          Track spending trends, identify expensive operations, and monitor cache savings
          to optimize your LLM API costs.
        </p>
      </div>

      <CostDashboard />
    </div>
  );
}
