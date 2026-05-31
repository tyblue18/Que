'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { retrySync } from '@/lib/syncEngine';

type SyncState = 'idle' | 'syncing' | 'ok' | 'error';

export function SyncStatus() {
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [isOnline,  setIsOnline]  = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of syncState for use inside stable event listeners (online handler).
  const stateRef = useRef<SyncState>('idle');
  stateRef.current = syncState;

  // Only the transient "Synced" toast auto-hides. A failure stays put until the
  // retry succeeds — a user who logged a PR must SEE that it didn't save.
  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setSyncState('idle'), 2000);
  }, []);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    // Coming back online — if a sync had failed, transparently re-attempt it.
    const goOnline  = () => { setIsOnline(true); if (stateRef.current === 'error') retrySync(); };
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online',  goOnline);
    window.addEventListener('offline', goOffline);

    const onSync = (e: Event) => {
      const status = (e as CustomEvent<string>).detail as SyncState;
      setSyncState(status);
      if (status === 'ok') scheduleHide();           // success auto-dismisses
      else if (hideTimerRef.current) clearTimeout(hideTimerRef.current); // keep errors up
    };
    window.addEventListener('que-sync', onSync);

    return () => {
      window.removeEventListener('online',    goOnline);
      window.removeEventListener('offline',   goOffline);
      window.removeEventListener('que-sync',  onSync);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [scheduleHide]);

  const showToast = syncState === 'ok' || syncState === 'syncing';

  return (
    <>
      {/* Offline banner — persistent */}
      <AnimatePresence>
        {!isOnline && (
          <motion.div
            initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed top-0 left-0 right-0 z-[600] flex items-center justify-center gap-2 px-4 py-2"
            style={{ background: 'rgba(255,181,71,0.95)', backdropFilter: 'blur(8px)' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#07080A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.56 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>
            </svg>
            <span className="font-mono text-[10px] font-bold tracking-[1px] uppercase text-[#07080A]">
              Offline — changes will sync when reconnected
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Persistent sync-failure banner — recoverable. Stays until a retry lands. */}
      <AnimatePresence>
        {syncState === 'error' && (
          <motion.div
            initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.2 }}
            role="alert"
            className="fixed bottom-[calc(env(safe-area-inset-bottom)+80px)] left-1/2 -translate-x-1/2 z-[600] flex items-center gap-3 rounded-lg px-4 py-2.5 shadow-lg max-w-[calc(100vw-24px)]"
            style={{
              background:     'rgba(255,77,94,0.15)',
              border:         '1px solid rgba(255,77,94,0.45)',
              backdropFilter: 'blur(12px)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FF4D5E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="flex-shrink-0">
              <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            </svg>
            <span className="font-mono text-[10px] font-bold tracking-[0.5px] uppercase text-[#FF4D5E] leading-tight">
              Couldn&apos;t save — your changes are only on this device
            </span>
            <button
              type="button"
              onClick={() => retrySync()}
              className="flex-shrink-0 rounded-full px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#07080A] transition-transform active:scale-95"
              style={{ background: '#FF4D5E' }}
            >
              Retry
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Transient toast — syncing / synced */}
      <AnimatePresence>
        {showToast && (
          <motion.div
            key={syncState}
            initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-[calc(env(safe-area-inset-bottom)+80px)] left-1/2 -translate-x-1/2 z-[600] flex items-center gap-2 rounded-full px-4 py-2 shadow-lg"
            style={{
              background:     syncState === 'ok' ? 'rgba(109,255,153,0.15)' : 'rgba(79,195,247,0.12)',
              border:         `1px solid ${syncState === 'ok' ? 'rgba(109,255,153,0.4)' : 'rgba(79,195,247,0.3)'}`,
              backdropFilter: 'blur(12px)',
            }}
          >
            {syncState === 'syncing' && (
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
            )}
            {syncState === 'ok' && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6DFF99" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            )}
            <span
              className="font-mono text-[10px] font-bold tracking-[1px] uppercase whitespace-nowrap"
              style={{ color: syncState === 'ok' ? '#6DFF99' : 'var(--accent)' }}
            >
              {syncState === 'syncing' ? 'Syncing…' : 'Synced'}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
