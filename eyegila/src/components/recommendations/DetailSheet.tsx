import { useState, useEffect } from 'react';
import { type RecommendationResponse, recommendationsApi } from '@/services/recommendations';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LatestTab } from './LatestTab';
import { HistoryTab } from './HistoryTab';

interface Props {
  rec: RecommendationResponse | null;
  onClose: () => void;
  onRegenerate: (intersectionId: number) => Promise<RecommendationResponse | null>;
  regenerating: boolean;
  onNotesSaved: (rec: RecommendationResponse) => void;
}

export function DetailSheet({ rec, onClose, onRegenerate, regenerating, onNotesSaved }: Props) {
  const [tab, setTab] = useState<'latest' | 'history'>('latest');
  const [historyRows, setHistoryRows] = useState<RecommendationResponse[] | undefined>(undefined);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);

  // Reset tab + history rows whenever the user opens a different intersection
  useEffect(() => {
    if (rec) {
      setTab('latest');
      setHistoryRows(undefined);
      setHistoryError(false);
    }
  }, [rec?.intersection_id]);

  // Fetch history when the History tab becomes active and rows are not yet loaded.
  // historyLoading is intentionally omitted from deps - including it would re-run the
  // cleanup when setHistoryLoading(true) fires, cancelling the in-flight request.
  useEffect(() => {
    if (tab !== 'history' || !rec || historyRows !== undefined) return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(false);
    recommendationsApi.history(rec.intersection_id, 50)
      .then(rows => { if (!cancelled) setHistoryRows(rows); })
      .catch(() => { if (!cancelled) setHistoryError(true); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, rec?.intersection_id, historyRows]);

  function retryHistory() {
    setHistoryRows(undefined);
    setHistoryError(false);
  }

  async function handleRegenerate() {
    if (!rec) return;
    const fresh = await onRegenerate(rec.intersection_id);
    if (fresh) setHistoryRows(prev => (prev ? [fresh, ...prev] : undefined));
  }

  return (
    <Sheet open={rec !== null} onOpenChange={open => !open && onClose()}>
      <SheetContent side="right" className="w-[480px] sm:max-w-[520px] flex flex-col gap-0 p-0">
        {rec && (
          <>
            <SheetHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
              <SheetTitle className="text-base">{rec.intersection_name}</SheetTitle>
              <SheetDescription className="text-xs">
                Last analyzed: {new Date(rec.generated_at).toLocaleString()}
              </SheetDescription>
            </SheetHeader>

            <Tabs
              value={tab}
              onValueChange={v => setTab(v as 'latest' | 'history')}
              className="flex flex-col flex-1 min-h-0"
            >
              <TabsList className="grid grid-cols-2 mx-6 mt-4 shrink-0">
                <TabsTrigger value="latest">Latest</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>

              <TabsContent value="latest" className="flex-1 overflow-y-auto px-6 pt-4 pb-8 mt-0">
                <LatestTab
                  rec={rec}
                  onRegenerate={handleRegenerate}
                  regenerating={regenerating}
                  onNotesSaved={onNotesSaved}
                />
              </TabsContent>
              <TabsContent value="history" className="flex-1 overflow-y-auto px-6 pt-4 pb-8 mt-0">
                <HistoryTab
                  rows={historyRows}
                  loading={historyLoading}
                  error={historyError}
                  onRetry={retryHistory}
                />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
