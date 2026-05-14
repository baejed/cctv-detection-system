import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { SetupGuide } from '@/components/SetupGuide';
import { useAuth } from '@/hooks/useAuth';
import { useSSE, type SSEStatus } from '@/hooks/useSSE';
import type { AggregationRow } from '@/types';
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
  LayoutDashboard, BarChart3, Camera, MapPin,
  Video, Lightbulb, Users, LogOut,
  Wifi, WifiOff, Loader2, BookOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/',                label: 'Dashboard',       icon: LayoutDashboard, end: true },
  { to: '/reports',         label: 'Reports',          icon: BarChart3 },
  { to: '/cameras',         label: 'Cameras',          icon: Camera },
  { to: '/intersections',   label: 'Intersections',    icon: MapPin },
  { to: '/videos',          label: 'Videos',           icon: Video },
  { to: '/recommendations', label: 'Recommendations',  icon: Lightbulb },
  { to: '/users',           label: 'Users',            icon: Users },
  { to: '/manual',          label: 'Manual',           icon: BookOpen },
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
  // Bypass Vite proxy for SSE — proxy buffers chunked responses, events arrive late.
  // Token passed as query param because EventSource can't send custom headers.
  const SSE_URL = token
    ? (import.meta.env.DEV
        ? `http://${window.location.hostname}:8000/aggregation/stream?token=${token}`
        : `/api/aggregation/stream?token=${token}`)
    : null;
  const { data: sseData, status: sseStatus } = useSSE<AggregationRow[]>(SSE_URL ?? '', !!SSE_URL);

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
            </SidebarMenu>
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
            <Outlet context={{ sseData, sseStatus }} />
          </main>
        </div>
      </div>
      <SetupGuide />
    </SidebarProvider>
  );
}
