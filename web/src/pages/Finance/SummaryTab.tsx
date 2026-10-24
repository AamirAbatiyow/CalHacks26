interface SummaryTabProps {
  leakageAvoided: string;
  reviewCostSaved: string;
  creditsIssued: string;
}

export function SummaryTab({ leakageAvoided, reviewCostSaved, creditsIssued }: SummaryTabProps) {
  const width = 760;
  const height = 280;
  const margin = { top: 20, right: 80, bottom: 40, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  const maxClaimValue = 2000;
  const maxCost = 1000;

  const humanReviewCost = 300;
  const groundTruthCost = 15;
  const breakEvenX = humanReviewCost;

  const xScale = (val: number) => (val / maxClaimValue) * chartWidth;
  const yScale = (val: number) => chartHeight - (val / maxCost) * chartHeight;

  const xTicks = [0, 500, 1000, 1500, 2000];
  const yTicks = [0, 250, 500, 750, 1000];

  return (
    <div className="summary-section">
      <div className="chart-container">
        <div className="chart-title">Cost per claim</div>
        <div className="chart-subtitle">Break-even</div>
        
        <div className="chart-legend">
          <div className="legend-item">
            <div className="legend-line payout" style={{ borderTop: '1px solid var(--color-primary)', background: 'none' }} />
            <span>Pay out</span>
          </div>
          <div className="legend-item">
            <div className="legend-line human" style={{ borderTop: '1px dashed var(--color-secondary)', background: 'none' }} />
            <span>Human review</span>
          </div>
          <div className="legend-item">
            <div className="legend-line groundtruth" />
            <span>Ground Truth</span>
          </div>
        </div>

        <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`}>
          <g transform={`translate(${margin.left}, ${margin.top})`}>
            {/* Grid lines */}
            {yTicks.map(tick => (
              <line
                key={`y-grid-${tick}`}
                x1={0}
                y1={yScale(tick)}
                x2={chartWidth}
                y2={yScale(tick)}
                stroke="var(--color-muted)"
                strokeWidth={0.5}
              />
            ))}

            {/* Break-even vertical line */}
            <line
              x1={xScale(breakEvenX)}
              y1={0}
              x2={xScale(breakEvenX)}
              y2={chartHeight}
              stroke="var(--color-muted)"
              strokeWidth={1}
              strokeDasharray="4,4"
            />

            {/* Pay out line (diagonal from 0,0 to 2000,2000 but capped at y=1000) */}
            <line
              x1={xScale(0)}
              y1={yScale(0)}
              x2={xScale(maxCost)}
              y2={yScale(maxCost)}
              stroke="var(--color-primary)"
              strokeWidth={1.5}
            />
            <line
              x1={xScale(maxCost)}
              y1={yScale(maxCost)}
              x2={xScale(maxClaimValue)}
              y2={yScale(maxCost)}
              stroke="var(--color-primary)"
              strokeWidth={1.5}
            />

            {/* Human review line (flat at $300) */}
            <line
              x1={xScale(0)}
              y1={yScale(humanReviewCost)}
              x2={xScale(maxClaimValue)}
              y2={yScale(humanReviewCost)}
              stroke="var(--color-secondary)"
              strokeWidth={1}
              strokeDasharray="6,3"
            />

            {/* Ground Truth line (flat at ~$15) */}
            <line
              x1={xScale(0)}
              y1={yScale(groundTruthCost)}
              x2={xScale(maxClaimValue)}
              y2={yScale(groundTruthCost)}
              stroke="var(--color-primary)"
              strokeWidth={2.5}
            />

            {/* Break-even marker */}
            <circle
              cx={xScale(breakEvenX)}
              cy={yScale(humanReviewCost)}
              r={4}
              fill="var(--color-bg)"
              stroke="var(--color-primary)"
              strokeWidth={2}
            />

            {/* Y axis labels */}
            {yTicks.map(tick => (
              <text
                key={`y-label-${tick}`}
                x={-12}
                y={yScale(tick) + 4}
                textAnchor="end"
                fill="var(--color-secondary)"
                fontSize="12"
              >
                ${tick.toLocaleString()}
              </text>
            ))}

            {/* X axis labels */}
            {xTicks.map(tick => (
              <text
                key={`x-label-${tick}`}
                x={xScale(tick)}
                y={chartHeight + 24}
                textAnchor="middle"
                fill="var(--color-secondary)"
                fontSize="12"
              >
                ${tick.toLocaleString()}
              </text>
            ))}

            {/* Axis label */}
            <text
              x={chartWidth / 2}
              y={chartHeight + 38}
              textAnchor="middle"
              fill="var(--color-secondary)"
              fontSize="12"
            >
              Claim value
            </text>
          </g>
        </svg>
      </div>

      <div className="summary-figures">
        <div className="summary-figure">
          <span className="figure-label">Leakage avoided</span>
          <span className="figure-value">{leakageAvoided}</span>
        </div>
        <div className="summary-figure">
          <span className="figure-label">Review cost saved</span>
          <span className="figure-value">{reviewCostSaved}</span>
        </div>
        <div className="summary-figure">
          <span className="figure-label">Credits issued</span>
          <span className="figure-value">{creditsIssued}</span>
        </div>
      </div>
    </div>
  );
}
