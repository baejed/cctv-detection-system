import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { type RecommendationResponse, type DataHealthResponse, recommendationsApi } from '@/services/recommendations';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Loader2, RefreshCw, Pencil, Check, X, BarChart2, Wifi, WifiOff, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  rec: RecommendationResponse;
  onRegenerate: () => void;
  regenerating: boolean;
  onNotesSaved: (rec: RecommendationResponse) => void;
}

const BARS: { key: 'warrant_1' | 'warrant_2' | 'warrant_4' | 'recommended'; label: string }[] = [
  { key: 'warrant_1',  label: 'W1 — Eight-Hour Vehicular Volume' },
  { key: 'warrant_2',  label: 'W2 — Four-Hour Vehicular Volume' },
  { key: 'warrant_4',  label: 'W4 — Pedestrian Volume' },
  { key: 'recommended',label: 'Overall recommended' },
];

export function LatestTab({ rec, onRegenerate, regenerating, onNotesSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(rec.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<DataHealthResponse | null>(null);

  useEffect(() => {
    setEditing(false);
    setDraft(rec.notes ?? '');
  }, [rec.id]);

  useEffect(() => {
    recommendationsApi.dataHealth(rec.intersection_id)
      .then(setHealth)
      .catch(() => null);
  }, [rec.intersection_id]);

  async function save() {
    setSaving(true);
    try {
      const updated = await recommendationsApi.updateNotes(rec.id, draft.trim() || null);
      onNotesSaved(updated);
      setEditing(false);
      toast.success('Notes saved');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Hour analyzed: <span className="text-foreground">
            {rec.hour_start ? new Date(rec.hour_start).toLocaleString() : 'unknown'}
          </span>
          {rec.data_age_hours != null && rec.data_age_hours > 2 && (
            <span className="ml-2 text-amber-600 font-medium">
              ({rec.data_age_hours.toFixed(0)}h ago — stale)
            </span>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={onRegenerate} disabled={regenerating} title="Analysis runs automatically every hour. Use this to force an immediate update.">
          {regenerating
            ? <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            : <RefreshCw className="size-3.5 mr-1.5" />}
          Run now
        </Button>
      </div>

      {/* Camera health */}
      {health && (
        <div className={cn(
          'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
          health.camera_ok
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/20 dark:border-emerald-900 dark:text-emerald-300'
            : 'border-rose-200 bg-rose-50 text-rose-800 dark:bg-rose-950/20 dark:border-rose-900 dark:text-rose-300',
        )}>
          {health.camera_ok
            ? <Wifi className="size-3.5 mt-0.5 shrink-0" />
            : <WifiOff className="size-3.5 mt-0.5 shrink-0" />}
          <span>
            {health.camera_ok
              ? `Camera live · last detection ${health.data_age_hours?.toFixed(1)}h ago`
              : health.last_detection_at
                ? `Camera offline · last detection ${health.data_age_hours?.toFixed(0)}h ago — counts may be unreliable`
                : 'No detections recorded — camera may not be configured'}
          </span>
        </div>
      )}

      {/* Market-day / recurring spike warning */}
      {health && health.high_volume_days.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          <span>{health.high_volume_days_note}</span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {BARS.map(b => {
          const value = b.key === 'recommended'
            ? (rec.recommended_confidence ?? 0)
            : rec[`${b.key}_confidence` as `warrant_1_confidence`];
          const met = b.key === 'recommended'
            ? rec.recommended
            : rec[`${b.key}_met` as `warrant_1_met`];
          return (
            <div key={b.key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className={cn(met && 'font-semibold')}>{b.label}</span>
                <span className="tabular-nums text-muted-foreground">{(value * 100).toFixed(0)}%</span>
              </div>
              <Progress
                value={value * 100}
                className={cn('h-2', met ? '[&>div]:bg-emerald-500' : '[&>div]:bg-muted-foreground/40')}
              />
            </div>
          );
        })}
      </div>

      <Separator />

      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Feature inputs (last hour)</div>
        <div className="grid grid-cols-5 gap-3 text-center">
          <Stat label="Major" value={rec.major_volume} suffix="veh/hr" />
          <Stat label="Minor" value={rec.minor_volume} suffix="veh/hr" />
          <Stat label="Peds"  value={rec.peds}         suffix="/hr" />
          <Stat label="VPM"   value={rec.vpm}          suffix="" />
          <Stat label="PHF"   value={rec.phf}          suffix="" digits={2} />
        </div>
      </div>

      <Separator />

      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Warrant evidence (DPWH thresholds)</div>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left pb-1 font-medium text-muted-foreground">Criterion</th>
              <th className="text-right pb-1 font-medium text-muted-foreground">Threshold</th>
              <th className="text-right pb-1 font-medium text-muted-foreground">Measured</th>
              <th className="text-right pb-1 font-medium text-muted-foreground">Met?</th>
            </tr>
          </thead>
          <tbody>
            <WarrantRow label="W1 — Major volume" threshold={400} measured={rec.major_volume} unit="veh/hr" />
            <WarrantRow label="W1 — Minor volume" threshold={150} measured={rec.minor_volume} unit="veh/hr" />
            <WarrantRow label="W4 — Pedestrians"  threshold={100} measured={rec.peds}         unit="/hr" />
          </tbody>
        </table>
        <p className="text-[10px] text-muted-foreground mt-1.5">
          DPWH Traffic Signal Manual Vol. 1 · Based on last-hour counts
        </p>
      </div>

      <Separator />

      {/* Signal timing link */}
      <Link to={`/timing/${rec.intersection_id}`} className="block">
        <div className="rounded-md border border-border bg-card px-4 py-3 flex items-center justify-between hover:bg-muted/40 transition-colors">
          <div>
            <div className="text-xs font-medium">Signal timing &amp; simulation</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {rec.timing_cycle != null
                ? `${rec.timing_cycle}s cycle · peak chunk: ${rec.timing_chunk ?? '—'}`
                : 'Run analysis to compute timing'}
            </div>
          </div>
          <BarChart2 className="size-4 text-muted-foreground shrink-0" />
        </div>
      </Link>

      <Separator />

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Engineer notes</div>
          {!editing && (
            <Button size="icon" variant="ghost" className="size-6" onClick={() => { setDraft(rec.notes ?? ''); setEditing(true); }} aria-label="Edit notes">
              <Pencil className="size-3" />
            </Button>
          )}
        </div>
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="Engineer notes…"
              className="text-xs min-h-[100px]"
              autoFocus
            />
            <div className="flex gap-1.5 justify-end">
              <Button size="icon" variant="ghost" className="size-6" onClick={() => setEditing(false)} disabled={saving} aria-label="Cancel">
                <X className="size-3" />
              </Button>
              <Button size="icon" variant="ghost" className="size-6 text-emerald-600" onClick={save} disabled={saving} aria-label="Save">
                {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              </Button>
            </div>
          </div>
        ) : (
          <p className={cn('text-xs leading-relaxed', rec.notes ? 'text-foreground' : 'text-muted-foreground/60 italic')}>
            {rec.notes ?? 'No notes'}
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, suffix, digits = 0 }: { label: string; value: number | null; suffix: string; digits?: number }) {
  return (
    <div className="rounded-md border border-border bg-card px-2 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">
        {value === null ? '—' : digits > 0 ? value.toFixed(digits) : value}
      </div>
      {suffix && <div className="text-[9px] text-muted-foreground">{suffix}</div>}
    </div>
  );
}

function WarrantRow({ label, threshold, measured, unit }: {
  label: string; threshold: number; measured: number | null; unit: string;
}) {
  const met = measured !== null && measured >= threshold;
  return (
    <tr className="border-b border-border/50">
      <td className="py-1.5">{label}</td>
      <td className="text-right tabular-nums text-muted-foreground">≥ {threshold} {unit}</td>
      <td className={cn('text-right tabular-nums', measured === null ? 'text-muted-foreground' : met ? 'text-emerald-600 font-semibold' : 'text-rose-500')}>
        {measured !== null ? `${measured} ${unit}` : '—'}
      </td>
      <td className={cn('text-right', measured === null ? 'text-muted-foreground' : met ? 'text-emerald-600' : 'text-rose-500')}>
        {measured !== null ? (met ? '✓' : '✗') : '—'}
      </td>
    </tr>
  );
}
