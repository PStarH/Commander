import type { IsoComplianceSummary, NistRmfAlignmentSummary } from '../types';

interface Props {
  iso: IsoComplianceSummary;
  nist: NistRmfAlignmentSummary;
}

const ISO_DESC: Record<string, string> = {
  '6.1': 'Risks and opportunities',
  '6.2': 'AI objectives and planning',
  '7.1': 'Resources',
  '7.2': 'Competence',
  '7.3': 'Awareness',
  '7.4': 'Communication',
  '7.5': 'Documented information',
  '8.1': 'Operational control',
  '8.2': 'Design and dev controls',
  '8.3': 'Deployment controls',
  '9.1': 'Monitoring and measurement',
  '9.2': 'Internal audit',
  '9.3': 'Management review',
  '10.1': 'Corrective action',
  '10.2': 'Continual improvement',
};

const ALL_CLAUSES = Object.keys(ISO_DESC);

const NIST_FUNC_LABELS: Record<string, string> = {
  GOVERN: 'Govern',
  MAP: 'Map',
  MEASURE: 'Measure',
  MANAGE: 'Manage',
};

export function ComplianceHeatmap({ iso, nist }: Props) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
      {/* ISO 42001 */}
      <div className="card" style={{ padding: '16px 18px' }}>
        <div className="section-head" style={{ marginBottom: '12px' }}>
          <div>
            <span className="section-label">ISO 42001:2023</span>
            <h2 style={{ fontSize: '1.1rem' }}>Clause Coverage</h2>
          </div>
          <span className="section-tag">{iso.compliancePercentage}%</span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {ALL_CLAUSES.map((clause) => {
            const entry = iso.clauseCoverage[clause];
            const covered = entry?.covered;
            return (
              <div
                key={clause}
                title={`${clause}: ${ISO_DESC[clause]}\n${covered ? `Score: ${entry.score}/100` : 'Not covered'}`}
                style={{
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${covered ? 'var(--accent-green-border)' : 'var(--accent-red-border)'}`,
                  background: covered ? 'var(--accent-green-bg)' : 'var(--accent-red-bg)',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  color: covered ? 'var(--accent-green)' : 'var(--accent-red)',
                  cursor: 'default',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em',
                }}
              >
                {clause}
                {covered && entry.score > 0 && (
                  <span style={{ marginLeft: '4px', opacity: 0.7, fontSize: '0.62rem' }}>
                    {entry.score}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {iso.gaps.length > 0 && (
          <div
            style={{
              marginTop: '10px',
              borderTop: '1px solid var(--border-subtle)',
              paddingTop: '10px',
            }}
          >
            {iso.gaps.slice(0, 3).map((gap) => (
              <div
                key={gap.clause}
                style={{
                  fontSize: '0.68rem',
                  color: gap.severity === 'critical' ? 'var(--accent-red)' : 'var(--accent-amber)',
                  marginBottom: '4px',
                }}
              >
                <strong>{gap.clause}</strong> {gap.description}
              </div>
            ))}
            {iso.gaps.length > 3 && (
              <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)' }}>
                +{iso.gaps.length - 3} more gaps
              </div>
            )}
          </div>
        )}
      </div>

      {/* NIST AI RMF */}
      <div className="card" style={{ padding: '16px 18px' }}>
        <div className="section-head" style={{ marginBottom: '12px' }}>
          <div>
            <span className="section-label">NIST AI RMF 1.0</span>
            <h2 style={{ fontSize: '1.1rem' }}>Function Alignment</h2>
          </div>
          <span className="section-tag">{nist.alignmentPercentage}%</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {(
            Object.entries(nist.functionCoverage) as [
              string,
              (typeof nist.functionCoverage)['GOVERN'],
            ][]
          ).map(([func, entry]) => {
            const pct = entry.coveragePercentage;
            const color =
              pct >= 90
                ? 'var(--accent-green)'
                : pct >= 70
                  ? 'var(--accent-blue)'
                  : 'var(--accent-amber)';
            return (
              <div key={func}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    marginBottom: '4px',
                  }}
                >
                  <span
                    style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}
                  >
                    {NIST_FUNC_LABELS[func] || func}
                  </span>
                  <span
                    style={{
                      fontSize: '0.68rem',
                      color: 'var(--text-tertiary)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {entry.coveredSubcategories}/{entry.totalSubcategories} subcats
                  </span>
                </div>
                <div
                  style={{
                    position: 'relative',
                    height: '6px',
                    borderRadius: '3px',
                    background: 'var(--border-subtle)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: '3px',
                      background: color,
                      width: `${pct}%`,
                      transition: 'width 0.5s ease',
                    }}
                  />
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {entry.controls.length} controls: {entry.controls.join(', ')}
                </div>
              </div>
            );
          })}
        </div>

        {nist.gaps.length > 0 && (
          <div
            style={{
              marginTop: '10px',
              borderTop: '1px solid var(--border-subtle)',
              paddingTop: '8px',
            }}
          >
            {nist.gaps.slice(0, 3).map((gap) => (
              <div
                key={gap.subcategory}
                style={{
                  fontSize: '0.68rem',
                  color: gap.severity === 'high' ? 'var(--accent-red)' : 'var(--accent-amber)',
                  marginBottom: '4px',
                }}
              >
                <strong>{gap.subcategory}</strong> {gap.description}
              </div>
            ))}
            {nist.gaps.length > 3 && (
              <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)' }}>
                +{nist.gaps.length - 3} more gaps
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
