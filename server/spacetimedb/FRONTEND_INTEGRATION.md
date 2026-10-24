# Frontend Integration Guide: SLA Deadlines & Event-Sourced Playback

This document describes how to consume the SpacetimeDB module's SLA deadline management and event-sourced playback features from the frontend.

## Overview

The system provides:
1. **SLA Deadline Management** - Automatic scheduling and enforcement of dispute response deadlines
2. **Event-Sourced Playback** - Append-only event log for timeline reconstruction at any past time
3. **Financial Ledger** - All credits/debits tracked with running balances

**Important: All monetary values are stored in cents. Convert to dollars for display: `cents / 100`**

## Tables to Subscribe To

### Core Playback Tables

```typescript
// Subscribe to the event log for timeline/playback
spacetimedb.subscribe("SELECT * FROM EventLog ORDER BY sim_timestamp_micros ASC");

// Subscribe to disputes for dispute panel
spacetimedb.subscribe("SELECT * FROM Dispute");

// Subscribe to ledger for financial history
spacetimedb.subscribe("SELECT * FROM LedgerEntry ORDER BY created_at ASC");

// Subscribe to audit log for compliance/history view
spacetimedb.subscribe("SELECT * FROM AuditLog ORDER BY timestamp ASC");
```

## Event Log Schema

```typescript
interface EventLog {
  id: bigint;
  recorded_at: Timestamp;           // Wall-clock when recorded
  sim_timestamp: Timestamp;         // Simulation time (for playback)
  sim_timestamp_micros: bigint;     // Easier filtering (micros since epoch)
  event_type: EventType;            // See below
  dispute_id?: bigint;              // Related dispute
  pass_id?: bigint;                 // Related pass
  station_id?: string;              // Related station
  amount_cents: bigint;             // Amount in CENTS (divide by 100 for dollars)
  description: string;              // Human-readable
  state_snapshot: string;           // Optional serialized state
}

type EventType = 
  | 'PassScheduled' | 'PassStarted' | 'PassCompleted' | 'PassDropped' | 'PassRecovered'
  | 'DisputeFiled' | 'DisputeResolved' | 'DeadlineExpired'
  | 'CreditIssued' | 'RevenueRecorded'
  | 'WeatherAlert' | 'StationStatusChange';
```

## Dispute Schema

```typescript
interface Dispute {
  id: bigint;
  pass_id: bigint;
  station_id: string;
  filed_at: Timestamp;
  deadline_at: Timestamp;           // Auto-calculated based on SLA tier
  status: DisputeStatus;
  sla_tier: SlaTier;
  claim_amount_cents: bigint;       // Original claim in CENTS
  credit_amount_cents: bigint;      // Actual credit issued in CENTS
  reason: string;
  resolution_notes: string;
  resolved_at?: Timestamp;
}

type DisputeStatus = 'Filed' | 'UnderReview' | 'Approved' | 'Denied' | 'Escalated' | 'CreditApplied' | 'Expired';
type SlaTier = 'Standard' | 'Premium' | 'Enterprise';
```

## Playback Bar Integration

### 1. Get Timeline Bounds

```typescript
// On component mount, get the min/max event times
const events = EventLog.all();
const bounds = {
  start: Math.min(...events.map(e => e.sim_timestamp_micros)),
  end: Math.max(...events.map(e => e.sim_timestamp_micros))
};
```

### 2. Get Dispute Markers for Timeline

```typescript
// Filter events that should appear as markers on the playback bar
const disputeMarkers = EventLog.all()
  .filter(e => ['DisputeFiled', 'DisputeResolved', 'DeadlineExpired'].includes(e.event_type))
  .map(e => ({
    time: e.sim_timestamp_micros,
    disputeId: e.dispute_id,
    type: e.event_type,
    amountDollars: Number(e.amount_cents) / 100,  // Convert cents to dollars
    description: e.description
  }));

// Render markers on timeline
disputeMarkers.forEach(marker => {
  const position = (marker.time - bounds.start) / (bounds.end - bounds.start);
  renderMarker(position, marker.type, marker.amountDollars);
});
```

### 3. Reconstruct State at Time T (Client-Side)

```typescript
function reconstructStateAtTime(targetMicros: bigint) {
  let state = {
    totalCreditsDollars: 0,
    activeDisputes: 0,
    resolvedDisputes: 0,
    passesCompleted: 0,
    passesDropped: 0,
    revenueDollars: 0
  };

  for (const event of EventLog.all()) {
    if (event.sim_timestamp_micros > targetMicros) continue;
    
    switch (event.event_type) {
      case 'DisputeFiled':
        state.activeDisputes++;
        break;
      case 'DisputeResolved':
      case 'DeadlineExpired':
        state.activeDisputes = Math.max(0, state.activeDisputes - 1);
        state.resolvedDisputes++;
        break;
      case 'CreditIssued':
        state.totalCreditsDollars += Number(event.amount_cents) / 100;
        break;
      case 'PassCompleted':
        state.passesCompleted++;
        break;
      case 'PassDropped':
        state.passesDropped++;
        break;
      case 'RevenueRecorded':
        state.revenueDollars += Number(event.amount_cents) / 100;
        break;
    }
  }

  return state;
}
```

### 4. Playback Controls (Existing Reducers)

```typescript
// Set playback speed (0.0 to 16.0)
spacetimedb.call("set_playback_speed", [2.0]);

// Play/Pause
spacetimedb.call("set_playback_playing", [true]);   // Play
spacetimedb.call("set_playback_playing", [false]);  // Pause

// Seek to specific time (microseconds since epoch)
const targetMicros = new Date('2024-01-15T10:30:00Z').getTime() * 1000;
spacetimedb.call("seek_to_time", [targetMicros]);

// Go to live (current real time)
spacetimedb.call("go_live", []);
```

## Filing and Managing Disputes

### File a New Dispute

```typescript
// sla_tier: 0 = Standard (72h), 1 = Premium (48h), 2 = Enterprise (24h)
// claim_amount is in CENTS
spacetimedb.call("file_dispute", [
  passId,                    // u64: Related pass ID
  "station-123",             // String: Station ID
  0,                         // u8: SLA tier (0=Standard, 1=Premium, 2=Enterprise)
  50000,                     // i64: Claim amount in CENTS ($500.00)
  "Signal degradation"       // String: Reason
]);
```

### Approve a Dispute

```typescript
spacetimedb.call("approve_dispute", [
  disputeId,                 // u64: Dispute ID
  "Verified via telemetry"   // String: Resolution notes
]);
```

### Deny a Dispute

```typescript
spacetimedb.call("deny_dispute", [
  disputeId,                 // u64: Dispute ID
  "Pass completed successfully" // String: Denial reason
]);
```

### Issue Manual Credit

```typescript
// For credits outside the dispute process
spacetimedb.call("issue_manual_credit", [
  "station-123",             // String: Station ID
  passId,                    // Option<u64>: Related pass (or null)
  25000,                     // i64: Amount in CENTS ($250.00)
  "Customer goodwill credit" // String: Description
]);
```

## SLA Tier Details

| Tier | Response Deadline | Auto-Credit % |
|------|-------------------|---------------|
| Standard | 72 hours | 10% of claim |
| Premium | 48 hours | 15% of claim |
| Enterprise | 24 hours | 25% of claim |

When a deadline expires without resolution, the dispute is automatically escalated and the corresponding credit percentage is applied.

## Event Listening

```typescript
// Listen for new events (real-time updates)
EventLog.onInsert((event) => {
  console.log(`New event: ${event.event_type} at ${event.sim_timestamp_micros}`);
  
  // Update timeline markers
  if (['DisputeFiled', 'DisputeResolved'].includes(event.event_type)) {
    addDisputeMarker(event);
  }
  
  // Update totals
  if (event.event_type === 'CreditIssued') {
    updateTotalCredits(Number(event.amount_cents) / 100);
  }
});

// Listen for dispute updates
Dispute.onUpdate((oldDispute, newDispute) => {
  if (newDispute.status === 'Escalated') {
    showEscalationNotification(newDispute);
  }
});
```

## Financial Display

Always display monetary values in dollars:

```typescript
function formatCurrency(cents: bigint): string {
  const dollars = Number(cents) / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(dollars);
}

// Usage
const dispute = Dispute.findById(1);
console.log(`Claim: ${formatCurrency(dispute.claim_amount_cents)}`);  // "$500.00"
console.log(`Credit: ${formatCurrency(dispute.credit_amount_cents)}`); // "$50.00"
```

## Example: Complete Playback Bar Component

```typescript
function PlaybackBar() {
  const [events, setEvents] = useState<EventLog[]>([]);
  const [currentTime, setCurrentTime] = useState(0n);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1.0);

  useEffect(() => {
    // Subscribe to events
    EventLog.onInsert((e) => setEvents(prev => [...prev, e]));
    
    // Subscribe to clock
    SimClock.onUpdate((_, clock) => {
      setCurrentTime(BigInt(clock.current_time));
      setIsPlaying(clock.is_playing);
    });
  }, []);

  const bounds = useMemo(() => ({
    start: events.length ? Math.min(...events.map(e => Number(e.sim_timestamp_micros))) : 0,
    end: events.length ? Math.max(...events.map(e => Number(e.sim_timestamp_micros))) : 1
  }), [events]);

  const markers = useMemo(() => 
    events
      .filter(e => ['DisputeFiled', 'DisputeResolved', 'DeadlineExpired'].includes(e.event_type))
      .map(e => ({
        position: (Number(e.sim_timestamp_micros) - bounds.start) / (bounds.end - bounds.start),
        type: e.event_type,
        amountDollars: Number(e.amount_cents) / 100
      }))
  , [events, bounds]);

  const playheadPosition = (Number(currentTime) - bounds.start) / (bounds.end - bounds.start);

  return (
    <div className="playback-bar">
      <button onClick={() => spacetimedb.call("set_playback_playing", [!isPlaying])}>
        {isPlaying ? 'Pause' : 'Play'}
      </button>
      
      <select value={speed} onChange={e => {
        const newSpeed = parseFloat(e.target.value);
        setSpeed(newSpeed);
        spacetimedb.call("set_playback_speed", [newSpeed]);
      }}>
        <option value={0.5}>0.5x</option>
        <option value={1}>1x</option>
        <option value={2}>2x</option>
        <option value={4}>4x</option>
        <option value={8}>8x</option>
      </select>

      <div className="timeline" onClick={e => {
        const rect = e.currentTarget.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        const targetMicros = bounds.start + pos * (bounds.end - bounds.start);
        spacetimedb.call("seek_to_time", [BigInt(Math.floor(targetMicros))]);
      }}>
        {markers.map((m, i) => (
          <div 
            key={i}
            className={`marker ${m.type}`}
            style={{ left: `${m.position * 100}%` }}
            title={`${m.type}: $${m.amountDollars.toFixed(2)}`}
          />
        ))}
        <div 
          className="playhead" 
          style={{ left: `${playheadPosition * 100}%` }}
        />
      </div>

      <button onClick={() => spacetimedb.call("go_live", [])}>
        Live
      </button>
    </div>
  );
}
```

## Server-Side Reducers Reference

| Reducer | Parameters | Description |
|---------|------------|-------------|
| `file_dispute` | pass_id, station_id, sla_tier, claim_amount_cents, reason | File a new dispute |
| `approve_dispute` | dispute_id, notes | Approve and issue full credit |
| `deny_dispute` | dispute_id, notes | Deny the dispute |
| `issue_manual_credit` | station_id, pass_id?, amount_cents, description | Manual credit |
| `get_events_in_range` | start_micros, end_micros | Query events in range |
| `get_dispute_markers` | (none) | Log dispute events |
| `reconstruct_state_at` | timestamp_micros | Log reconstructed state |
| `get_timeline_bounds` | (none) | Log timeline min/max |
| `record_pass_event` | pass_id, station_id, event_type, revenue_cents, description | Record a pass event |

## Notes

1. **Append-Only Design**: All EventLog, LedgerEntry, and AuditLog entries are immutable once written
2. **Automatic Scheduling**: Filing a dispute automatically schedules its SLA deadline check
3. **Auto-Escalation**: Expired deadlines automatically escalate and issue credits
4. **Cents vs Dollars**: All amounts stored in cents; convert for display
5. **Real-Time Updates**: Use SpacetimeDB subscriptions for live updates
