import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { onboardingApi } from '@/services/onboarding';
import { intersectionsApi } from '@/services/intersections';
import { useAuth } from '@/hooks/useAuth';
import { useSSE, type SSEStatus } from '@/hooks/useSSE';
import type { AggregationRow, Intersection } from '@/types';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader,
  SidebarMenu, SidebarMenuItem, SidebarMenuButton,
  SidebarProvider, SidebarTrigger,
} from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  BarChart3, MapPin, Users, LogOut,
  Wifi, WifiOff, Loader2, BookOpen, Rocket,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/',        label: 'Intersections', icon: MapPin,    end: true },
  { to: '/reports', label: 'Reports',       icon: BarChart3           },
  { to: '/users',   label: 'Users',         icon: Users               },
  { to: '/manual',  label: 'Manual',        icon: BookOpen            },
];

function SSEIndicator({ status }: { status: SSEStatus }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground">
          {status === 'connected' ? (
            <Wifi className="size-3 text-emerald-500 sse-pulse" />
          ) : status === 'connecting' ? (
            <Loader2 className="size-3 text-amber-500 animate-spin" />
          ) : (
            <WifiOff className="size-3 text-destructive" />
          )}
          <span className={cn(
            status === 'connected'  && 'text-emerald-500',
            status === 'connecting' && 'text-amber-500',
            status === 'disconnected' && 'text-destructive',
          )}>
            {status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline'}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        SSE stream: {status}
      </TooltipContent>
    </Tooltip>
  );
}

export function Layout() {
  const { username, logout, token } = useAuth();
  const navigate = useNavigate();
  const SSE_URL = token ? `/api/aggregation/stream?token=${token}` : null;
  const { data: sseData, status: sseStatus } = useSSE<AggregationRow[]>(SSE_URL ?? '', !!SSE_URL);

  const [wizardOpen,       setWizardOpen]       = useState(false);
  const [savedStep,        setSavedStep]        = useState<string | null>(null);
  const [intersectionList, setIntersectionList] = useState<Intersection[]>([]);

  function fetchIntersections() {
    intersectionsApi.list().then(setIntersectionList).catch(() => {});
  }

  useEffect(() => {
    if (!token) return;
    onboardingApi.getProgress()
      .then(p => setSavedStep(p.step))
      .catch(() => {});
    fetchIntersections();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function openWizard() { setWizardOpen(true); }

  function handleWizardClose(currentStep: string | null) {
    setSavedStep(currentStep);
    setWizardOpen(false);
    fetchIntersections();
  }

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <SidebarProvider>
      <div className="flex h-screen w-full overflow-hidden bg-background">
        <Sidebar variant="sidebar" collapsible="icon">
          <SidebarHeader className="border-b border-sidebar-border px-4 py-3">
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="EyeGila" className="size-7 rounded-md object-contain" />
              <span className="font-bold tracking-tight text-sidebar-foreground group-data-[collapsible=icon]:hidden">
                EyeGila
              </span>
              <Badge className="ml-auto text-[10px] bg-green-500/20 text-green-300 border-green-500/30 hover:bg-green-500/20 group-data-[collapsible=icon]:hidden">
                TMO
              </Badge>
            </div>
          </SidebarHeader>

          <SidebarContent className="py-2">
            <SidebarMenu>
              {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
                <SidebarMenuItem key={to}>
                  <NavLink to={to} end={end} className="w-full">
                    {({ isActive }) => (
                      <SidebarMenuButton isActive={isActive} tooltip={label}>
                        <Icon />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    )}
                  </NavLink>
                </SidebarMenuItem>
              ))}

              <SidebarMenuItem>
                <SidebarMenuButton onClick={openWizard} tooltip="Get Started">
                  <Rocket />
                  <span>Get Started</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>

            {/* Setup progress indicator */}
            {intersectionList.length > 0 && (() => {
              const configured = intersectionList.filter(i => i.existing_cycle_length != null).length;
              const total      = intersectionList.length;
              const pct        = Math.round((configured / total) * 100);
              return (
                <div className="mx-3 mt-1 mb-2 rounded-md border border-border bg-muted/30 px-3 py-2.5 group-data-[collapsible=icon]:hidden">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                      Setup Progress
                    </span>
                    <span className="text-[10px] font-semibold text-foreground">
                      {configured}/{total}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all duration-500',
                        pct === 100 ? 'bg-emerald-500' : 'bg-primary',
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {configured === total
                      ? 'All intersections configured'
                      : `${total - configured} pending timing setup`}
                  </p>
                </div>
              );
            })()}
          </SidebarContent>

          <SidebarFooter className="border-t border-sidebar-border p-3">
            <div className="flex items-center justify-between group-data-[collapsible=icon]:justify-center">
              <span className="truncate text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                {username}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={handleLogout}
              >
                <LogOut className="size-4" />
                <span className="sr-only">Logout</span>
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex h-12 shrink-0 items-center border-b border-border bg-card px-4 gap-3">
            <SidebarTrigger className="size-7" />
            <Separator orientation="vertical" className="h-4" />
            <div className="flex-1" />
            <SSEIndicator status={sseStatus} />
          </header>

          <main className="flex-1 overflow-y-auto p-6">
            <Outlet context={{ sseData, sseStatus, onOpenWizard: openWizard }} />
          </main>
        </div>
      </div>

      <OnboardingWizard
        open={wizardOpen}
        initialStep={savedStep}
        onClose={handleWizardClose}
      />
    </SidebarProvider>
  );
}
