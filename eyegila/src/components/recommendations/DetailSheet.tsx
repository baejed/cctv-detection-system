import { useState, useEffect } from 'react';
import { type RecommendationResponse } from '@/services/recommendations';
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
  const [historySeed, setHistorySeed] = useState<RecommendationResponse[] | undefined>(undefined);

  // Reset tab + seed whenever the user opens a different intersection
  useEffect(() => {
    if (rec) {
      setTab('latest');
      setHistorySeed(undefined);
    }
  }, [rec?.intersection_id]);

  async function handleRegenerate() {
    if (!rec) return;
    const fresh = await onRegenerate(rec.intersection_id);
    if (fresh) setHistorySeed(prev => (prev ? [fresh, ...prev] : undefined));
  }

  return (
    <Sheet open={rec !== null} onOpenChange={open => !open && onClose()}>
      <SheetContent side="right" className="w-[480px] sm:max-w-[520px] overflow-y-auto">
        {rec && (
          <>
            <SheetHeader>
              <SheetTitle>{rec.intersection_name}</SheetTitle>
              <SheetDescription>Warrant analysis details</SheetDescription>
            </SheetHeader>

            <Tabs value={tab} onValueChange={v => setTab(v as 'latest' | 'history')} className="mt-4">
              <TabsList className="grid grid-cols-2">
                <TabsTrigger value="latest">Latest</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
              <TabsContent value="latest" className="mt-4">
                <LatestTab
                  rec={rec}
                  onRegenerate={handleRegenerate}
                  regenerating={regenerating}
                  onNotesSaved={onNotesSaved}
                />
              </TabsContent>
              <TabsContent value="history" className="mt-4">
                <HistoryTab intersectionId={rec.intersection_id} seed={historySeed} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
