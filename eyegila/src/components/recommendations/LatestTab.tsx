import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type RecommendationResponse, recommendationsApi } from '@/services/recommendations';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Loader2, RefreshCw, Pencil, Check, X } from 'lucide-react';
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

  // Reset the notes editor when the underlying record changes (e.g. after regenerate)
  useEffect(() => {
    setEditing(false);
    setDraft(rec.notes ?? '');
  }, [rec.id]);

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
        </div>
        <Button size="sm" variant="outline" onClick={onRegenerate} disabled={regenerating}>
          {regenerating
            ? <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            : <RefreshCw className="size-3.5 mr-1.5" />}
          Regenerate
        </Button>
      </div>

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
