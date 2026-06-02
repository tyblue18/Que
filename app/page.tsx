import Link from 'next/link';
import Image from 'next/image';
import {
  Calendar, Utensils, BarChart2, Users, Zap,
  TrendingUp, Award, Dumbbell,
} from 'lucide-react';
import queLogo from '@/public/Que_logo.png';
import calendarPreview from '@/public/Calendar_preview.png';
import caloriesPreview from '@/public/Calories_preview.png';
import metricsPreview from '@/public/Metrics_preview.png';
import protocolPreview from '@/public/Protocol_preview.png';
import socialPreview from '@/public/Social_preview.png';
import { InstallCTA } from '@/components/landing/InstallCTA';
import { InviteBanner } from '@/components/landing/InviteBanner';

const FEATURES = [
  {
    icon: Zap,
    title: 'Coaching for lift AND run',
    body: 'Evidence-based lifting progression (volume, RIR, deloads) and a Jack Daniels VDOT running engine — in one plan, not two apps.',
  },
  {
    icon: Utensils,
    title: 'Nutrition that knows your training',
    body: 'Search foods, scan barcodes, hit macros — and your budget eats back the calories your training actually burned. Your food knows your workouts.',
  },
  {
    icon: BarChart2,
    title: 'Metrics & Trends',
    body: 'Body weight trends, calorie history, PRs, and a cut/bulk plan with progress tracking — adapting to what you actually log.',
  },
  {
    icon: Calendar,
    title: 'Workout Calendar',
    body: 'Log every lift, set, and rep. Visual month view shows your training density at a glance.',
  },
  {
    icon: Users,
    title: 'Social & Challenges',
    body: 'Follow friends, compare stats, and wager coins on head-to-head fitness challenges.',
  },
  {
    icon: Award,
    title: 'Badges & Coins',
    body: 'Earn badges for PRs, streaks, and milestones. Win coins in challenges and spend them on bets.',
  },
] as const;

const STATS = [
  { value: '3→1', label: 'lift · run · fuel, connected' },
  { value: 'PWA', label: 'works offline' },
  { value: '1', label: 'plan for lift + run + food' },
] as const;

const PREVIEWS = [
  { img: calendarPreview, label: 'Calendar', body: 'Log every set, rep, and weight in a clean week view.' },
  { img: caloriesPreview, label: 'Calories', body: 'Search foods, scan barcodes, hit your macros daily.' },
  { img: metricsPreview,  label: 'Metrics',  body: 'Weight trends, PRs, and cut/bulk progress at a glance.' },
  { img: protocolPreview, label: 'Protocol', body: 'Plan workouts and build running training plans.' },
  { img: socialPreview,   label: 'Social',   body: 'Add friends, compare stats, and battle for coins.' },
] as const;

export default function LandingPage() {
  return (
    <div className="lp-shell">
      {/* ── Invite banner (only renders for ?invite=… visitors) ── */}
      <InviteBanner />

      {/* ── Ambient background ── */}
      <div className="lp-bg-glow" aria-hidden="true" />

      {/* ── Nav ── */}
      <header className="lp-nav">
        <div className="lp-nav-inner">
          <div className="lp-nav-brand">
            <Image src={queLogo} alt="Que" width={28} height={28} className="lp-nav-logo" priority />
            <span className="lp-nav-name">Que</span>
          </div>
          <Link href="/auth/signin" className="lp-nav-cta">
            Sign in
          </Link>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="lp-hero">
        <div className="lp-hero-inner">
          <div className="lp-hero-badge">
            <Dumbbell size={12} aria-hidden="true" />
            <span>Lift · Run · Fuel</span>
          </div>

          <div className="lp-hero-titlerow">
            <Image src={queLogo} alt="" width={150} height={150} className="lp-hero-logo" priority aria-hidden="true" />
            <h1 className="lp-hero-title">
              One body.<br />One app.
            </h1>
          </div>

          <p className="lp-hero-sub">
            You lift, you run, you track your macros — in three apps that don&apos;t
            talk to each other. Que is the one that does: it coaches your lifting
            and your running, and adapts your nutrition to both. Because it&apos;s
            all the same body.
          </p>

          <div className="lp-hero-actions">
            <InstallCTA className="lp-btn-primary" />
            <Link href="/app" className="lp-btn-ghost">
              Try without account
            </Link>
          </div>
          <p className="lp-hero-no-account">
            No sign-up needed. Your data saves locally, and you can sign in later to sync across devices.
          </p>

          <div className="lp-stats">
            {STATS.map(({ value, label }) => (
              <div key={label} className="lp-stat">
                <span className="lp-stat-value">{value}</span>
                <span className="lp-stat-label">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="lp-features">
        <div className="lp-features-inner">
          <p className="lp-section-label">What the others can&apos;t do</p>
          <h2 className="lp-section-title">Your training and your nutrition, finally connected</h2>

          <div className="lp-feature-grid">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="lp-feature-card">
                <div className="lp-feature-icon">
                  <Icon size={18} aria-hidden="true" />
                </div>
                <h3 className="lp-feature-title">{title}</h3>
                <p className="lp-feature-body">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Product previews ── */}
      <section className="lp-previews">
        <div className="lp-previews-inner">
          <p className="lp-section-label">See it in action</p>
          <h2 className="lp-section-title">Every tab, dialed in</h2>
        </div>
        <div className="lp-preview-strip">
          {PREVIEWS.map(({ img, label, body }) => (
            <figure key={label} className="lp-preview-card">
              <div className="lp-preview-frame">
                <Image
                  src={img}
                  alt={`${label} screen in the Que app`}
                  placeholder="blur"
                  sizes="(max-width: 640px) 66vw, 240px"
                  className="lp-preview-img"
                />
              </div>
              <figcaption className="lp-preview-cap">
                <span className="lp-preview-label">{label}</span>
                <span className="lp-preview-body">{body}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* ── CTA band ── */}
      <section className="lp-cta-band">
        <div className="lp-cta-inner">
          <TrendingUp size={32} className="lp-cta-icon" aria-hidden="true" />
          <h2 className="lp-cta-title">Stop juggling three apps.</h2>
          <p className="lp-cta-sub">One app for your lifting, your running, and your nutrition. Free, offline-first, your data stays yours.</p>
          <InstallCTA className="lp-btn-primary lp-btn-lg" label="Start tracking" />
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="lp-footer">
        <span>© {new Date().getFullYear()} Que</span>
        <Link href="/about" className="lp-footer-link">About</Link>
        <Link href="/privacy" className="lp-footer-link">Privacy</Link>
        <Link href="/terms" className="lp-footer-link">Terms</Link>
        <Link href="/app" className="lp-footer-link">Open app</Link>
      </footer>
    </div>
  );
}
