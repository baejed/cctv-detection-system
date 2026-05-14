import { useState } from 'react';
import { type RecommendationResponse } from '@/services/recommendations';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface Props {
  rows: RecommendationResponse[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}

export function HistoryTab({ rows, loading, error, onRetry }: Props) {
  if (loading) return <div className="flex flex-col gap-2"><Skeleton className="h-40" /><Skeleton className="h-20" /></div>;
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 text-xs">
        <p className="text-rose-600">Failed to load history</p>
        <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (!rows || rows.length === 0) return <p className="text-xs text-muted-foreground">No history yet.</p>;

  // recharts wants ascending order
  const chartData = [...rows].reverse().map(r => ({
    ts: new Date(r.generated_at).getTime(),
    W1: r.warrant_1_confidence,
    W2: r.warrant_2_confidence,
    W4: r.warrant_4_confidence,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="h-44 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              fontSize={9}
            />
            <YAxis domain={[0, 1]} fontSize={9} />
            <Tooltip
              labelFormatter={t => new Date(t as number).toLocaleString()}
              formatter={(v) => typeof v === 'number' ? v.toFixed(2) : '—'}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Line type="monotone" dataKey="W1" stroke="#0ea5e9" dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="W2" stroke="#10b981" dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="W4" stroke="#f59e0b" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-col divide-y divide-border border border-border rounded-md">
        {rows.map(r => <HistoryRow key={r.id} rec={r} />)}
      </div>
    </div>
  );
}

function HistoryRow({ rec }: { rec: RecommendationResponse }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button
        type="button"
        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-muted/40"
        onClick={() => setOpen(o => !o)}
      >
        <span className="flex items-center gap-1.5">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <span className="font-medium">{new Date(rec.generated_at).toLocaleString()}</span>
        </span>
        <span className="tabular-nums text-muted-foreground">
          W1 {rec.warrant_1_confidence.toFixed(2)} · W2 {rec.warrant_2_confidence.toFixed(2)} · W4 {rec.warrant_4_confidence.toFixed(2)}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 grid grid-cols-5 gap-2 text-[11px]">
          <Cell label="Major" v={rec.major_volume} />
          <Cell label="Minor" v={rec.minor_volume} />
          <Cell label="Peds"  v={rec.peds} />
          <Cell label="VPM"   v={rec.vpm} />
          <Cell label="PHF"   v={rec.phf !== null ? rec.phf.toFixed(2) : null} />
          {rec.notes && (
            <div className="col-span-5 mt-1 text-muted-foreground italic">"{rec.notes}"</div>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ label, v }: { label: string; v: number | string | null }) {
  return (
    <div>
      <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
      <div className="tabular-nums">{v ?? '—'}</div>
    </div>
  );
}
