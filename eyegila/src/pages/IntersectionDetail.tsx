import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { intersectionsApi } from '@/services/intersections';
import { cctvsApi } from '@/services/cctvs';
import { streetsApi } from '@/services/streets';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import { simulationApi, type SimulationResponse } from '@/services/simulation';
import { IntersectionSummary } from '@/components/IntersectionSummary';
import { IntersectionTabs } from '@/components/IntersectionTabs';
import type { Intersection, CCTV, Street, AggregationRow } from '@/types';
import type { SSEStatus } from '@/hooks/useSSE';
import { SettingsSheet } from '@/components/IntersectionSettingsSheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  ArrowLeft, Settings2, RefreshCw, Loader2, Activity, TrendingUp, Clock,
  TrafficCone, Construction, CheckCircle2, Circle,
} from 'lucide-react';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from '@/components/recommendations/statusBucket';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export function IntersectionDetailPage() {
  const { id }      = useParams<{ id: string }>();
  const navigate    = useNavigate();
  const { sseData } = useOutletContext<{ sseData: AggregationRow[] | null; sseStatus: SSEStatus }>();

  const interId = Number(id);

  const [intersection, setIntersection] = useState<Intersection | null>(null);
  const [cameras,      setCameras]      = useState<CCTV[]>([]);
  const [streets,      setStreets]      = useState<Street[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [rec,          setRec]          = useState<RecommendationResponse | null>(null);
  const [sim,          setSim]          = useState<SimulationResponse | null>(null);
  const [generating,   setGenerating]   = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [inter, allCams, allStreets] = await Promise.all([
        intersectionsApi.get(interId),
        cctvsApi.list(),
        streetsApi.list().catch(() => [] as Street[]),
      ]);
      setIntersection(inter);
      setCameras(allCams.filter(c => c.intersection_id === interId));
      setStreets(allStreets.filter(s => s.intersection_id === interId));
      // latest() returns null when no recommendation exists yet. Any fetch
      // error (including network failures) is absorbed here so that a missing
      // badge never blocks the rest of the page from loading. Auth errors are
      // already handled inside request() before the error is thrown.
      const [r, s] = await Promise.all([
        recommendationsApi.latest(interId).catch(() => null),
        simulationApi.get(interId).catch(() => null),
      ]);
      setRec(r);
      setSim(s);
    } catch {
      toast.error('Failed to load intersection');
    } finally {
      setLoading(false);
    }
  }, [interId]);

  async function generate() {
    setGenerating(true);
    try {
      await recommendationsApi.generate(interId);
      toast.success('Analysis complete');
      load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => { load(); }, [load]);

  const liveCount = useMemo(() => {
    let total = 0;
    for (const row of sseData ?? []) {
      if (row.intersection_id === interId) total += row.count;
    }
    return total;
  }, [sseData, interId]);

  const peakCount = useMemo(() => {
    const major = rec?.major_volume ?? 0;
    const minor = rec?.minor_volume ?? 0;
    return major + minor;
  }, [rec]);

  const peakTimeLabel = useMemo(() => {
    if (!rec?.hour_start) return '—';
    const d = new Date(rec.hour_start);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric',
    });
  }, [rec]);

  const warrantChips = useMemo(() => {
    if (!rec) return [];
    type Chip = { key: string; label: string; met: boolean; conf: number | null };
    const chips: Chip[] = [
      { key: 'w1', label: 'W1 8-hour',     met: rec.warrant_1_met, conf: rec.warrant_1_confidence ?? null },
      { key: 'w2', label: 'W2 4-hour',     met: rec.warrant_2_met, conf: rec.warrant_2_confidence ?? null },
      { key: 'w4', label: 'W4 Pedestrian', met: rec.warrant_4_met, conf: rec.warrant_4_confidence ?? null },
    ];
    if (rec.w_local_1_met !== null) chips.push({ key: 'wl1', label: 'WL-1 Vehicle Mix',  met: !!rec.w_local_1_met, conf: rec.w_local_1_confidence ?? null });
    if (rec.w_local_2_met !== null) chips.push({ key: 'wl2', label: 'WL-2 Peak Concen.', met: !!rec.w_local_2_met, conf: rec.w_local_2_confidence ?? null });
    if (rec.w_local_3_met !== null) chips.push({ key: 'wl3', label: 'WL-3 Lights-off',   met: !!rec.w_local_3_met, conf: rec.w_local_3_confidence ?? null });
    return chips;
  }, [rec]);

  const action = useMemo(() => {
    if (!rec) {
      return {
        headline: 'No analysis yet',
        detail: 'Run a warrant analysis to populate this dashboard.',
        tone: 'muted' as const,
        Icon: Circle,
      };
    }
    if (rec.intervention?.class === 'road_widening') {
      return {
        headline: 'Widen approach lanes',
        detail: `Post-Webster v/c exceeds 0.90 — signal timing alone cannot clear demand. ${Math.round((rec.intervention.confidence ?? 0) * 100)}% confidence.`,
        tone: 'warn' as const,
        Icon: Construction,
      };
    }
    if (rec.intervention?.class === 'signalize' || (rec.recommended && rec.intervention == null)) {
      const conf = rec.intervention?.confidence ?? rec.recommended_confidence ?? 0;
      return {
        headline: 'Install traffic signal',
        detail: `Warrant met and intersection is unsignalized. ${Math.round(conf * 100)}% confidence.`,
        tone: 'good' as const,
        Icon: TrafficCone,
      };
    }
    if (rec.timing_cycle != null) {
      return {
        headline: `Re-time to ${rec.timing_cycle}s cycle`,
        detail: 'Existing signal stays — recompute green splits to match current demand.',
        tone: 'info' as const,
        Icon: Clock,
      };
    }
    return {
      headline: 'No action required',
      detail: 'Current timing absorbs the demand. Keep monitoring.',
      tone: 'muted' as const,
      Icon: CheckCircle2,
    };
  }, [rec]);

  const actionTone = {
    good:  'border-emerald-500/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
    warn:  'border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100',
    info:  'border-sky-500/40 bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-100',
    muted: 'border-border bg-muted/40 text-muted-foreground',
  }[action.tone];

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => navigate('/')}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <h1 className="text-xl font-semibold tracking-tight truncate">
            {loading ? '…' : (intersection?.name ?? 'Intersection')}
          </h1>
          {rec && (
            <Badge className={cn('shrink-0 text-[10px]', BUCKET_BADGE_CLASS[statusBucket(rec)])}>
              {BUCKET_LABEL[statusBucket(rec)]}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1.5"
            onClick={generate}
            disabled={generating}
            title="Run warrant analysis"
          >
            {generating ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {generating ? 'Analysing…' : 'Analyse'}
          </Button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Settings"
          >
            <Settings2 className="size-4" />
          </button>
          {id && <IntersectionTabs intersectionId={id} />}
        </div>
      </div>

      {/* Recommended action — single decision-level headline */}
      <div className={cn('flex items-start gap-3 rounded-xl border p-4', actionTone)}>
        <div className="rounded-lg bg-white/60 dark:bg-black/30 p-2 shrink-0">
          <action.Icon className="size-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-wide font-semibold opacity-70">Recommended action</p>
          <p className="mt-0.5 text-base font-semibold leading-tight truncate">{action.headline}</p>
          <p className="mt-1 text-xs opacity-80">{action.detail}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs shrink-0 bg-white/70 dark:bg-black/30"
          onClick={generate}
          disabled={generating}
        >
          {generating ? <Loader2 className="size-3 animate-spin mr-1" /> : <RefreshCw className="size-3 mr-1" />}
          Re-analyse
        </Button>
      </div>

      {/* Warrant status chips */}
      {warrantChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {warrantChips.map(chip => (
            <span
              key={chip.key}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]',
                chip.met
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-border bg-muted/40 text-muted-foreground',
              )}
              title={chip.conf != null ? `${Math.round(chip.conf * 100)}% confidence` : undefined}
            >
              {chip.met
                ? <CheckCircle2 className="size-3" />
                : <Circle className="size-3" />}
              <span className="font-medium">{chip.label}</span>
              {chip.conf != null && (
                <span className="font-mono tabular-nums opacity-70">{Math.round(chip.conf * 100)}%</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Headline metrics: live daily count + peak hour stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Daily count</p>
                <p className="mt-1 text-3xl font-black tabular-nums leading-none">
                  {sseData ? liveCount.toLocaleString() : '—'}
                </p>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  rolling total from live detections
                </p>
              </div>
              <div className="rounded-lg bg-emerald-100 p-2">
                <Activity className="size-4 text-emerald-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Peak count</p>
                <p className="mt-1 text-3xl font-black tabular-nums leading-none">
                  {rec ? peakCount.toLocaleString() : '—'}
                </p>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  major + minor approach volume (vph)
                </p>
              </div>
              <div className="rounded-lg bg-amber-100 p-2">
                <TrendingUp className="size-4 text-amber-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Peak time</p>
                <p className="mt-1 text-2xl font-black tabular-nums leading-tight">
                  {peakTimeLabel}
                </p>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  start of the busiest hour analysed
                </p>
              </div>
              <div className="rounded-lg bg-violet-100 p-2">
                <Clock className="size-4 text-violet-700" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {intersection && (
        <IntersectionSummary
          intersection={intersection}
          streets={streets}
          sim={sim}
          rec={rec}
        />
      )}

      <SettingsSheet
        inter={intersection}
        streets={streets}
        cameras={cameras}
        rec={rec}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onRefresh={load}
      />
    </div>
  );
}
