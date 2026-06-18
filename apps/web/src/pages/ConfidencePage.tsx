import { ConfidencePanel } from '../components/ConfidencePanel';
import type { Mission, AgentWorkload } from '../types';

interface ConfidencePageProps {
  missions: Mission[];
  agents: AgentWorkload[];
}

export function ConfidencePage({ missions, agents }: ConfidencePageProps) {
  return (
    <div className="page confidence-page">
      <ConfidencePanel missions={missions} agents={agents} />
    </div>
  );
}
