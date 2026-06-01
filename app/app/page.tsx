'use client';

import { useState, useEffect } from 'react';
import { MotionConfig } from 'framer-motion';
import dynamic from 'next/dynamic';
import { Calendar, BarChart2, Layers, Utensils, Users } from 'lucide-react';
import { AuthHeader }    from '@/components/header';
import CalendarScheduler from '@/components/CalendarScheduler';
import WorkoutLogger     from '@/components/WorkoutLogger';
import { Onboarding, needsOnboarding } from '@/components/Onboarding';
import { GettingStarted } from '@/components/GettingStarted';
import { MorningWeightPrompt } from '@/components/MorningWeightPrompt';
import { WeeklyRecapModal } from '@/components/WeeklyRecapModal';
import { InviteRedeemer } from '@/components/InviteRedeemer';
import { BadgeCelebration } from '@/components/BadgeCelebration';
import { FunnelTracker } from '@/components/FunnelTracker';
import { InvitePrompt } from '@/components/InvitePrompt';
import { SyncNudge } from '@/components/SyncNudge';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useApp } from '@/lib/AppContext';
import { RestTimerProvider } from '@/lib/RestTimerContext';
import { trackEvent } from '@/lib/telemetry';

// Lazy-load the non-default tabs so they (and their heavy deps — charts, Lottie,
// the barcode scanner) stay out of the initial bundle and only download when the
// user first opens that tab. The Calendar tab (CalendarScheduler + WorkoutLogger)
// stays eager since it's the landing tab. ssr:false because the whole dashboard
// is client-rendered behind auth — there's nothing to server-render.
const TabFallback = () => (
  <div className="flex items-center justify-center py-20" role="status" aria-label="Loading">
    <div className="w-6 h-6 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
  </div>
);
const CalorieTracker   = dynamic(() => import('@/components/CalorieTracker'),   { ssr: false, loading: TabFallback });
const MetricsDashboard = dynamic(() => import('@/components/MetricsDashboard'), { ssr: false, loading: TabFallback });
const SocialTab        = dynamic(() => import('@/components/SocialTab'),        { ssr: false, loading: TabFallback });

type Tab = 'calendar' | 'calories' | 'metrics' | 'protocol' | 'social';

const TABS = [
  { id: 'calendar' as Tab, label: 'Calendar', Icon: Calendar  },
  { id: 'calories' as Tab, label: 'Calories', Icon: Utensils  },
  { id: 'metrics'  as Tab, label: 'Metrics',  Icon: BarChart2 },
  { id: 'protocol' as Tab, label: 'Protocol', Icon: Layers    },
  { id: 'social'   as Tab, label: 'Social',   Icon: Users     },
] as const;

export default function WorkoutPage() {
  const [tab, setTab]                   = useState<Tab>('calendar');
  const [showOnboarding, setOnboarding] = useState(false);
  const { isLoaded }                    = useApp();

  useEffect(() => {
    if (!isLoaded) return;
    setOnboarding(needsOnboarding());
  }, [isLoaded]);

  // The header dropdown's "Athlete Profile" opens the profile, which lives on
  // the Metrics tab. Jump there and bump a signal MetricsDashboard reads as a
  // prop — robust even when this click is what lazy-mounts the Metrics tab.
  const [profileSignal, setProfileSignal] = useState(0);
  useEffect(() => {
    const open = () => { setTab('metrics'); setProfileSignal(n => n + 1); };
    window.addEventListener('que-open-athlete-profile', open);
    return () => window.removeEventListener('que-open-athlete-profile', open);
  }, []);

  return (
    /* reducedMotion="user" → every Framer Motion transition below respects the
       OS "Reduce Motion" setting (animations collapse to instant/opacity). */
    <MotionConfig reducedMotion="user">
    <RestTimerProvider>
    <div className="app-shell">
      <AuthHeader />
      <InviteRedeemer />
      <BadgeCelebration />
      <FunnelTracker />
      <InvitePrompt />

      <main className="app-content" role="tabpanel">
        {/* Each tab gets its own ErrorBoundary so a single component crash
            isolates to that tab — the bottom nav and other tabs stay live.
            The boundary itself reports to lib/errorReporter so failures
            show up in /api/log/error → Vercel logs. */}
        {tab === 'calendar' && (
          <ErrorBoundary label="Calendar">
            <GettingStarted onNavigate={setTab} />
            <div className="app-calendar-layout">
              <CalendarScheduler />
              <WorkoutLogger />
            </div>
          </ErrorBoundary>
        )}
        {tab === 'calories' && (
          <ErrorBoundary label="Calories">
            <CalorieTracker />
          </ErrorBoundary>
        )}
        {tab === 'metrics' && (
          <ErrorBoundary label="Metrics">
            <MetricsDashboard openProfileSignal={profileSignal} />
          </ErrorBoundary>
        )}
        {tab === 'protocol' && (
          <ErrorBoundary label="Protocol">
            <div className="app-protocol-layout">
              <WorkoutLogger />
            </div>
          </ErrorBoundary>
        )}
        {tab === 'social' && (
          <ErrorBoundary label="Social">
            <SocialTab />
          </ErrorBoundary>
        )}
      </main>

      <nav className="app-tabs" role="tablist" aria-label="App navigation">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            data-active={tab === id}
            onClick={() => setTab(id)}
            className="app-tab"
          >
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <SyncNudge />
      {showOnboarding && (
        <Onboarding onComplete={() => { trackEvent('onboarding_completed'); setOnboarding(false); }} />
      )}
      {!showOnboarding && isLoaded && <MorningWeightPrompt />}
      {!showOnboarding && isLoaded && <WeeklyRecapModal />}
    </div>
    </RestTimerProvider>
    </MotionConfig>
  );
}
