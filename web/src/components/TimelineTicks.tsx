import { useMemo } from 'react';
import type { TimelineEvent } from '../types';
import { mockPasses } from '../data/mockPasses';

interface TimelineTicksProps {
  timeRangeStart: Date;
  timeRangeEnd: Date;
  events?: TimelineEvent[];
}

function generateEventsFromPasses(): TimelineEvent[] {
  return mockPasses
    .filter((pass) => pass.status === 'dropped')
    .map((pass) => ({
      time: pass.start,
      type: 'dropped' as const,
      description: `Dropped pass: ${pass.id}`,
    }));
}

export function TimelineTicks({
  timeRangeStart,
  timeRangeEnd,
  events,
}: TimelineTicksProps) {
  const timelineEvents = useMemo(() => {
    if (events) return events;
    return generateEventsFromPasses();
  }, [events]);

  const timeRange = timeRangeEnd.getTime() - timeRangeStart.getTime();

  const visibleEvents = useMemo(() => {
    return timelineEvents.filter((event) => {
      const eventTime = event.time.getTime();
      return eventTime >= timeRangeStart.getTime() && eventTime <= timeRangeEnd.getTime();
    });
  }, [timelineEvents, timeRangeStart, timeRangeEnd]);

  const getTickPosition = (time: Date): number => {
    const offset = time.getTime() - timeRangeStart.getTime();
    return (offset / timeRange) * 100;
  };

  const isAmberEvent = (type: TimelineEvent['type']): boolean => {
    return type === 'dispute' || type === 'dropped';
  };

  return (
    <div className="timeline-ticks" aria-hidden="true">
      {visibleEvents.map((event, index) => {
        const position = getTickPosition(event.time);
        const isAmber = isAmberEvent(event.type);
        
        return (
          <div
            key={`${event.type}-${event.time.getTime()}-${index}`}
            className={`timeline-tick ${isAmber ? 'timeline-tick--amber' : ''}`}
            style={{ left: `${position}%` }}
            title={event.description}
          />
        );
      })}
    </div>
  );
}

export type { TimelineTicksProps };
