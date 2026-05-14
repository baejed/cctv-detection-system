import { useEffect, useMemo, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { intersectionsApi } from '@/services/intersections';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import type { Intersection } from '@/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Loader2, RefreshCw, Lightbulb } from 'lucide-react';
import { SummaryStrip } from '@/components/recommendations/SummaryStrip';
import { FilterBar, type FilterState, ALL_STATUSES, ALL_WARRANTS } from '@/components/recommendations/FilterBar';
import { RecommendationsTable, sortRows, type SortState } from '@/components/recommendations/RecommendationsTable';
import { DetailSheet } from '@/components/recommendations/DetailSheet';
import { statusBucket, type StatusBucket } from '@/components/recommendations/statusBucket';

export function RecommendationsPage() {
  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [recs, setRecs] = useState<RecommendationResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [regeneratingIds, setRegeneratingIds] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [filter, setFilter] = useState<FilterState>({
    statuses: new Set(ALL_STATUSES),
    search: '',
    warrants: new Set(),
    minProb: 0,
  });
  const [sort, setSort] = useState<SortState>({ key: 'status', dir: 'asc' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ints, r] = await Promise.all([
        intersectionsApi.list(),
        recommendationsApi.list(),
      ]);
      setIntersections(ints);
      setRecs(r);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function regenerateOne(intersectionId: number): Promise<RecommendationResponse | null> {
    setRegeneratingIds(prev => new Set(prev).add(intersectionId));
    try {
      const fresh = await recommendationsApi.generate(intersectionId);
      setRecs(prev => {
        const without = prev.filter(r => r.intersection_id !== intersectionId);
        return [...without, fresh];
      });
      toast.success('Analysis complete');
      return fresh;
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
      return null;
    } finally {
      setRegeneratingIds(prev => {
        const s = new Set(prev);
        s.delete(intersectionId);
        return s;
      });
    }
  }

  async function regenerateAll() {
    setGeneratingAll(true);
    try {
      const results = await recommendationsApi.generateAll();
      setRecs(results);
      const warranted = results.filter(r => r.recommended).length;
      toast.success(`Analysis complete — ${warranted} warranted`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setGeneratingAll(false);
    }
  }

  function onNotesSaved(updated: RecommendationResponse) {
    setRecs(prev => prev.map(r => (r.id === updated.id ? updated : r)));
  }

  // Filtered + sorted rows for the table
  const visibleRows = useMemo(() => {
    const filtered = recs.filter(r => {
      // status
      if (!filter.statuses.has(statusBucket(r))) return false;
      // name search
      if (filter.search && !r.intersection_name.toLowerCase().includes(filter.search.toLowerCase())) return false;
      // warrant + minProb
      if (filter.warrants.size > 0) {
        const fields: Record<typeof ALL_WARRANTS[number], number> = {
          warrant_1: r.warrant_1_confidence,
          warrant_2: r.warrant_2_confidence,
          warrant_4: r.warrant_4_confidence,
        };
        const ok = [...filter.warrants].some(w => fields[w] >= filter.minProb);
        if (!ok) return false;
      }
      return true;
    });
    return sortRows(filtered, sort);
  }, [recs, filter, sort]);

  const counts = useMemo<Record<StatusBucket, number>>(() => {
    const c = { warranted: 0, borderline: 0, not_warranted: 0, no_data: 0 };
    for (const r of recs) c[statusBucket(r)] += 1;
    return c;
  }, [recs]);

  const selectedRec = selectedId !== null ? recs.find(r => r.intersection_id === selectedId) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Recommendations</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            MUTCD signal warrant analysis — last full hour of detections
          </p>
        </div>
        <Button onClick={regenerateAll} disabled={generatingAll || loading || intersections.length === 0} size="sm">
          {generatingAll ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="size-3.5 mr-1.5" />}
          Run all
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm flex items-center justify-between">
          <span className="text-rose-600">{error}</span>
          <Button size="sm" variant="outline" onClick={load}>Retry</Button>
        </div>
      ) : loading ? (
        <Skeleton className="h-64" />
      ) : intersections.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
          <Lightbulb className="size-10 opacity-30" />
          <p className="text-sm">No intersections configured</p>
        </div>
      ) : (
        <>
          <SummaryStrip counts={counts} totalIntersections={intersections.length} />
          <FilterBar value={filter} onChange={setFilter} />
          {visibleRows.length > 0 ? (
            <RecommendationsTable
              rows={visibleRows}
              sort={sort}
              onSortChange={setSort}
              onRowClick={r => setSelectedId(r.intersection_id)}
              onRegenerate={iid => { regenerateOne(iid); }}
              regeneratingIds={regeneratingIds}
            />
          ) : (
            <div className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
              No intersections match the current filters.
            </div>
          )}
        </>
      )}

      <DetailSheet
        rec={selectedRec}
        onClose={() => setSelectedId(null)}
        onRegenerate={regenerateOne}
        regenerating={selectedId !== null && regeneratingIds.has(selectedId)}
        onNotesSaved={onNotesSaved}
      />
    </div>
  );
}
