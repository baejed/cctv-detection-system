import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { simulationApi, type SimulationChunk, type SimulationResponse } from '@/services/simulation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { ArrowLeft, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';

const APPROACH_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4'];

function fmt(n: number | null | undefined, unit = 's'): string {
  if (n == null) return '—';
  return `${n.toFixed(1)}${unit}`;
}

function deltaClass(before: number, after: number): string {
  return after < before ? 'text-emerald-600' : after > before ? 'text-rose-600' : '';
}

function buildQueueData(
  series: Record<string, number[]> | null,
  label: 'Before' | 'After',
): { minute: number; [key: string]: number }[] {
  if (!series) return [];
  const streetIds = Object.keys(series);
  const len = Math.max(...streetIds.map(k => series[k].length), 0);
  return Array.from({ length: len }, (_, i) => {
    const row: { minute: number; [key: string]: number } = { minute: i + 1 };
    for (const sid of streetIds) {
      row[`${label}_${sid}`] = series[sid][i] ?? 0;
    }
    return row;
  });
}

function mergeQueueData(
  before: Record<string, number[]> | null,
  after: Record<string, number[]> | null,
): { minute: number; [key: string]: number }[] {
  const beforeRows = buildQueueData(before, 'Before');
  const afterRows  = buildQueueData(after,  'After');
  const len = Math.max(beforeRows.length, afterRows.length);
  return Array.from({ length: len }, (_, i) => ({
    ...beforeRows[i],
    ...afterRows[i],
    minute: i + 1,
  }));
}

function ChunkQueueChart({ chunk, showBefore, showAfter }: {
  chunk: SimulationChunk;
  showBefore: boolean;
  showAfter: boolean;
}) {
  const data = mergeQueueData(chunk.queue_series_before, chunk.queue_series_after);
  if (!data.length) {
    return <p className="text-xs text-muted-foreground py-4 text-center">No queue data available</p>;
  }

  const beforeKeys = showBefore && chunk.queue_series_before
    ? Object.keys(chunk.queue_series_before).map(sid => `Before_${sid}`)
    : [];
  const afterKeys = showAfter && chunk.queue_series_after
    ? Object.keys(chunk.queue_series_after).map(sid => `After_${sid}`)
    : [];
  const allKeys = [...beforeKeys, ...afterKeys];

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis
          dataKey="minute"
          tick={{ fontSize: 11 }}
          tickFormatter={v => `${v}m`}
          label={{ value: 'Minute', position: 'insideBottomRight', offset: -4, fontSize: 11 }}
        />
        <YAxis tick={{ fontSize: 11 }} width={36} label={{ value: 'Queue', angle: -90, position: 'insideLeft', fontSize: 11 }} />
        <Tooltip
          contentStyle={{ fontSize: 11 }}
          formatter={(v: number, name: string) => [`${v.toFixed(1)} veh`, name.replace('_', ' Approach ')]}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {allKeys.map((key, idx) => {
          const isBefore = key.startsWith('Before_');
          return (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={APPROACH_COLORS[idx % APPROACH_COLORS.length]}
              strokeWidth={1.5}
              strokeDasharray={isBefore ? '4 2' : undefined}
              dot={false}
              name={key.replace('Before_', 'Before A').replace('After_', 'After A')}
            />
          );
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function SignalTimingPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const intersectionId = Number(id);

  const [data, setData] = useState<SimulationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null);
  const [showBefore, setShowBefore] = useState(true);
  const [showAfter, setShowAfter] = useState(true);

  useEffect(() => {
    if (!intersectionId) return;
    setLoading(true);
    simulationApi.get(intersectionId)
      .then(d => {
        setData(d);
        if (d.chunks.length > 0) setSelectedChunk(d.chunks[0].chunk_name);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [intersectionId]);

  const activeChunk = data?.chunks.find(c => c.chunk_name === selectedChunk) ?? null;

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {data ? data.intersection_name : 'Signal Timing'}
          </h1>
          {data && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Analytical delay simulation · {data.signal_status.replace('_', ' ')}
            </p>
          )}
        </div>
      </div>

      {loading && <Skeleton className="h-64" />}

      {error && (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-rose-600">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Daily summary strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Avg delay before', value: fmt(data.daily_summary.avg_delay_before), sub: 'per vehicle' },
              { label: 'Avg delay after',  value: fmt(data.daily_summary.avg_delay_after),  sub: 'per vehicle', good: true },
              {
                label: 'Vehicle-hours saved',
                value: `${data.daily_summary.total_vehicle_hours_saved.toFixed(1)} vh`,
                sub: 'per day',
                good: data.daily_summary.total_vehicle_hours_saved > 0,
              },
              { label: 'Total flow', value: `${data.daily_summary.total_volume_pcu_hr.toFixed(0)} PCU`, sub: 'across all chunks' },
            ].map(stat => (
              <div key={stat.label} className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">{stat.label}</p>
                <p className={cn('text-xl font-semibold mt-1', stat.good && 'text-emerald-600')}>
                  {stat.value}
                </p>
                <p className="text-xs text-muted-foreground">{stat.sub}</p>
              </div>
            ))}
          </div>

          {/* Per-chunk table */}
          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chunk</TableHead>
                  <TableHead className="text-right">Delay before</TableHead>
                  <TableHead className="text-right">Delay after</TableHead>
                  <TableHead className="text-right">Improvement</TableHead>
                  <TableHead className="text-right">Flow (PCU/hr)</TableHead>
                  <TableHead className="text-right">Veh-hrs saved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.chunks.map(chunk => {
                  const improvement = chunk.delay_before - chunk.delay_after;
                  const pct = chunk.delay_before > 0
                    ? Math.round((improvement / chunk.delay_before) * 100)
                    : 0;
                  return (
                    <TableRow
                      key={chunk.chunk_name}
                      className={cn(
                        'cursor-pointer',
                        selectedChunk === chunk.chunk_name && 'bg-muted/50',
                      )}
                      onClick={() => setSelectedChunk(chunk.chunk_name)}
                    >
                      <TableCell className="font-medium">{chunk.chunk_name}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(chunk.delay_before)}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', deltaClass(chunk.delay_before, chunk.delay_after))}>
                        {fmt(chunk.delay_after)}
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', improvement > 0 ? 'text-emerald-600' : 'text-muted-foreground')}>
                        {improvement > 0 ? `−${improvement.toFixed(1)}s (${pct}%)` : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{chunk.volume_pcu_hr.toFixed(0)}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', chunk.vehicle_hours_saved > 0 && 'text-emerald-600')}>
                        {chunk.vehicle_hours_saved > 0 ? chunk.vehicle_hours_saved.toFixed(2) : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {/* Daily summary row */}
                <TableRow className="bg-muted/30 font-semibold border-t-2 border-border">
                  <TableCell>Daily total</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(data.daily_summary.avg_delay_before)}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', deltaClass(data.daily_summary.avg_delay_before, data.daily_summary.avg_delay_after))}>
                    {fmt(data.daily_summary.avg_delay_after)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">avg</TableCell>
                  <TableCell className="text-right tabular-nums">{data.daily_summary.total_volume_pcu_hr.toFixed(0)}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', data.daily_summary.total_vehicle_hours_saved > 0 && 'text-emerald-600')}>
                    {data.daily_summary.total_vehicle_hours_saved.toFixed(2)} vh
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {/* Queue time-series chart */}
          {activeChunk && (
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-semibold">Queue length — {activeChunk.chunk_name}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Vehicles queued per approach over a simulated 60-minute window</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={showBefore ? 'default' : 'outline'}
                    className="h-7 text-xs"
                    onClick={() => setShowBefore(v => !v)}
                  >
                    Before
                  </Button>
                  <Button
                    size="sm"
                    variant={showAfter ? 'default' : 'outline'}
                    className="h-7 text-xs"
                    onClick={() => setShowAfter(v => !v)}
                  >
                    After
                  </Button>
                </div>
              </div>

              {/* Chunk selector tabs */}
              <div className="flex flex-wrap gap-1.5 mb-4">
                {data.chunks.map(c => (
                  <button
                    key={c.chunk_name}
                    onClick={() => setSelectedChunk(c.chunk_name)}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-md border transition-colors',
                      selectedChunk === c.chunk_name
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground',
                    )}
                  >
                    {c.chunk_name}
                  </button>
                ))}
              </div>

              <ChunkQueueChart chunk={activeChunk} showBefore={showBefore} showAfter={showAfter} />

              <p className="text-xs text-muted-foreground mt-2">
                Dashed lines = before timing · Solid lines = proposed timing · Each color = one approach
              </p>
            </div>
          )}

          {data.chunks.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <TrendingDown className="size-10 opacity-30" />
              <p className="text-sm">No simulation data — regenerate the recommendation to compute delay estimates.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
