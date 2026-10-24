interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number;
  className?: string;
}

export function Skeleton({ width = '100%', height = 12, radius = 4, className = '' }: SkeletonProps) {
  return <span className={`ui-skeleton ${className}`} style={{ width, height, borderRadius: radius }} aria-hidden />;
}

/** Placeholder rows shaped like a list or table while the subscription fills in. */
export function SkeletonRows({ rows = 6, height = 36 }: { rows?: number; height?: number }) {
  return (
    <div className="ui-skeleton-rows" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ui-skeleton-row" style={{ height }}>
          <Skeleton width="18%" height={10} />
          <Skeleton width={`${38 - (i % 3) * 7}%`} height={10} />
          <Skeleton width="12%" height={10} />
        </div>
      ))}
    </div>
  );
}

/** A faint node graph that stands in for a flow while its data loads. */
export function SkeletonGraph({ columns = 4 }: { columns?: number }) {
  return (
    <div className="ui-skeleton-graph" role="status" aria-label="Loading">
      {Array.from({ length: columns }, (_, i) => (
        <div key={i} className="ui-skeleton-graph-col">
          {Array.from({ length: i === 0 ? 3 : 1 }, (_, j) => (
            <Skeleton key={j} width={132} height={52} radius={5} />
          ))}
        </div>
      ))}
    </div>
  );
}
