import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Anton, Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { AuthProvider } from '@/components/auth-provider';
import { AppProvider }  from '@/lib/AppContext';
import { SWRegister }          from '@/components/sw-register';
import { ColorSchemeLoader }  from '@/components/color-scheme-loader';
import { SyncStatus }         from '@/components/SyncStatus';
import { ErrorBootstrap }     from '@/components/error-bootstrap';
import { ConflictToast }      from '@/components/ConflictToast';
import GlowMount       from '@/components/GlowMount';
import { THEME_KEY }   from '@/lib/constants';
import './globals.css';

// ── Type pairing: athletic condensed display + clean geometric sans + technical mono ──
const anton = Anton({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-display',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

const BASE_URL = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: 'Que — Athlete OS',
  description:
    'Personal training log and calorie tracker. Log workouts, hit macros, track your cut or bulk, and compete with friends.',
  manifest: '/manifest.json',
  icons: {
    icon:  '/Que_logo.png',
    apple: '/Que_logo.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Que',
  },
  openGraph: {
    type:        'website',
    url:         BASE_URL,
    siteName:    'Que',
    title:       'Que — Athlete OS',
    description: 'Personal training log and calorie tracker. Log workouts, hit macros, track your cut or bulk, and compete with friends.',
  },
  twitter: {
    card:        'summary_large_image',
    title:       'Que — Athlete OS',
    description: 'Personal training log and calorie tracker. Log workouts, hit macros, track your cut or bulk, and compete with friends.',
  },
};

export const viewport: Viewport = {
  themeColor: '#07080A',
  width: 'device-width',
  initialScale: 1,
  // Removed maximumScale:1 / userScalable:false — these were blocking pinch-zoom
  // for low-vision users without actually preventing zoom on iOS Safari (which
  // has ignored user-scalable=no since iOS 10). WCAG 1.4.4 requires zoom support.
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // CSP nonce minted per-request in middleware. Threading it onto the inline
  // theme script below is what lets a nonce-based policy allow that one script
  // without `'unsafe-inline'`.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang="en"
      className={`${anton.variable} ${spaceGrotesk.variable} ${jetBrainsMono.variable}`}
      suppressHydrationWarning
    >
      {/* Blocking script: sets data-theme before first paint to prevent flash */}
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: `(function(){try{if(localStorage.getItem('${THEME_KEY}')==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}})()` }} />
      </head>
      <body className="font-sans antialiased">
        <AuthProvider>
          <AppProvider>
            <GlowMount />
            {children}
          </AppProvider>
        </AuthProvider>

        <ColorSchemeLoader />
        <SyncStatus />
        <SWRegister />
        <ErrorBootstrap />
        <ConflictToast />

        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  );
}
