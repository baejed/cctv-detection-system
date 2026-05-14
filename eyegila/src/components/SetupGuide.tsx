import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { intersectionsApi } from '@/services/intersections';
import { streetsApi } from '@/services/streets';
import { cctvsApi } from '@/services/cctvs';
import { request } from '@/services/api';
import type { Region } from '@/types';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import {
  CheckCircle2, Circle, ChevronDown, ChevronUp,
  MapPin, Camera, Layers, BarChart3, GitBranch,
  ArrowRight, X, Rocket,
} from 'lucide-react';

const DISMISS_KEY = 'eyegila_setup_v1';

interface SetupData {
  intersections: number;
  streets: number;
  cctvs: number;
  regions: number;
}

const STEPS = [
  {
    id: 'intersection',
    title: 'Create an intersection',
    subtitle: 'Define a location and pin it on the map',
    detail:
      'Go to Intersections and click "Add Intersection". Name it after the real location (e.g. "City Hall Junction") and pin its GPS coordinates by clicking the map or entering them manually.',
    href: '/intersections',
    action: 'Open Intersections',
    Icon: MapPin,
    done: (d: SetupData) => d.intersections > 0,
    blocked: () => false,
  },
  {
    id: 'streets',
    title: 'Add approach streets',
    subtitle: 'Name each traffic direction entering the intersection',
    detail:
      'Expand an intersection row and click "+ Street". Add one entry per approach (e.g. "Northbound", "Rizal Ave"). Streets become the detection zones you draw on the camera frame.',
    href: '/intersections',
    action: 'Open Intersections',
    Icon: GitBranch,
    done: (d: SetupData) => d.streets > 0,
    blocked: (d: SetupData) => d.intersections === 0,
  },
  {
    id: 'camera',
    title: 'Add a CCTV camera',
    subtitle: 'Connect a camera via its RTSP stream URL',
    detail:
      'Go to Cameras and click "Add Camera". Enter the RTSP stream URL (e.g. rtsp://192.168.1.10:554/ch01), select the intersection it covers, and save. A detection worker will automatically claim and start processing the stream.',
    href: '/cameras',
    action: 'Open Cameras',
    Icon: Camera,
    done: (d: SetupData) => d.cctvs > 0,
    blocked: (d: SetupData) => d.intersections === 0,
  },
  {
    id: 'regions',
    title: 'Draw detection regions',
    subtitle: 'Mark polygon zones on the video for each approach street',
    detail:
      'Open a camera and scroll to the Region Editor. Click "New Region", choose a street approach and direction (inbound or outbound), then click on the live video to place vertices. Click the first vertex again to close the polygon.',
    href: '/cameras',
    action: 'Open Cameras',
    Icon: Layers,
    done: (d: SetupData) => d.regions > 0,
    blocked: (d: SetupData) => d.cctvs === 0 || d.streets === 0,
  },
  {
    id: 'monitor',
    title: 'Start monitoring traffic',
    subtitle: 'View live counts, reports, and warrant recommendations',
    detail:
      'The Dashboard shows real-time vehicle and pedestrian counts as workers process frames. Use Reports to view hourly and daily trends. Visit Recommendations to run MUTCD warrant analysis.',
    href: '/',
    action: 'View Dashboard',
    Icon: BarChart3,
    done: (d: SetupData) => d.regions > 0,
    blocked: (d: SetupData) => d.regions === 0,
  },
] as const;

export function SetupGuide() {
  const [data, setData] = useState<SetupData | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === '1',
  );
  const autoDismissedRef = useRef(false);

  useEffect(() => {
    if (dismissed) return;
    Promise.allSettled([
      intersectionsApi.list(),
      streetsApi.list(),
      cctvsApi.list(),
      request<Region[]>('/regions/'),
    ]).then(([ints, strs, cams, regs]) => {
      const d: SetupData = {
        intersections: ints.status === 'fulfilled' ? ints.value.length : 0,
        streets:       strs.status === 'fulfilled' ? strs.value.length : 0,
        cctvs:         cams.status === 'fulfilled' ? cams.value.length : 0,
        regions:       regs.status === 'fulfilled' ? regs.value.length : 0,
      };
      setData(d);
      const allDone = STEPS.every(s => s.done(d));
      if (allDone && !autoDismissedRef.current) {
        autoDismissedRef.current = true;
        localStorage.setItem(DISMISS_KEY, '1');
        setDismissed(true);
        return;
      }
      const first = STEPS.find(s => !s.done(d) && !s.blocked(d));
      if (first) setExpanded(first.id);
    });
  }, [dismissed]);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
    setOpen(false);
  }

  if (dismissed || !data) return null;

  const completedCount = STEPS.filter(s => s.done(data)).length;
  const progress = Math.round((completedCount / STEPS.length) * 100);

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {/* Floating panel */}
      {open && (
        <div className="w-80 rounded-xl border border-border bg-card shadow-2xl shadow-black/20 overflow-hidden flex flex-col max-h-[calc(100vh-120px)]">
          {/* Panel header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card shrink-0">
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">Get started with EyeGila</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {completedCount} of {STEPS.length} steps completed
              </p>
            </div>
            <button
              type="button"
              onClick={dismiss}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Dismiss setup guide"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {/* Progress bar */}
          <div className="px-4 py-2 border-b border-border shrink-0">
            <Progress value={progress} className="h-1.5" />
          </div>

          {/* Steps — scrollable */}
          <div className="divide-y divide-border overflow-y-auto">
            {STEPS.map(step => {
              const done    = step.done(data);
              const blocked = step.blocked(data);
              const isOpen  = expanded === step.id;

              return (
                <div key={step.id} className={cn(blocked && 'opacity-40 pointer-events-none')}>
                  <button
                    type="button"
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
                    onClick={() => setExpanded(isOpen ? null : step.id)}
                    aria-expanded={isOpen}
                  >
                    <span className="shrink-0">
                      {done
                        ? <CheckCircle2 className="size-4 text-emerald-500" />
                        : <Circle className="size-4 text-muted-foreground/40" />}
                    </span>

                    <span className={cn(
                      'shrink-0 flex items-center justify-center size-6 rounded-md',
                      done
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'bg-primary/10 text-primary',
                    )}>
                      <step.Icon className="size-3" />
                    </span>

                    <div className="flex-1 min-w-0">
                      <p className={cn(
                        'text-xs font-medium leading-none mb-0.5',
                        done && 'text-muted-foreground line-through',
                      )}>
                        {step.title}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">{step.subtitle}</p>
                    </div>

                    <span className="shrink-0 text-muted-foreground">
                      {isOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-3 pl-[52px]">
                      <p className="text-xs text-muted-foreground leading-relaxed mb-2.5">
                        {step.detail}
                      </p>
                      {!done && (
                        <Button size="sm" className="h-7 text-xs" asChild onClick={() => setOpen(false)}>
                          <Link to={step.href}>
                            {step.action}
                            <ArrowRight className="size-3 ml-1" />
                          </Link>
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* FAB trigger */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex items-center gap-2.5 rounded-full px-4 py-2.5 shadow-lg shadow-black/20',
          'bg-primary text-primary-foreground hover:bg-primary/90 transition-all',
          'text-sm font-medium',
        )}
        aria-label="Toggle setup guide"
      >
        <Rocket className="size-4 shrink-0" />
        <span>Get started</span>
        <span className={cn(
          'flex items-center justify-center size-5 rounded-full text-[11px] font-semibold',
          'bg-primary-foreground/20',
        )}>
          {completedCount}/{STEPS.length}
        </span>
      </button>
    </div>
  );
}
