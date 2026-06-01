'use client';

import { useEffect, useState } from 'react';

/**
 * True when the user has the OS "Reduce Motion" accessibility setting on. Use it
 * to drop looping/decorative animation (e.g. Lottie loops) for users who get
 * motion sick. Framer Motion transitions are handled globally via
 * <MotionConfig reducedMotion="user">; this hook covers the cases Framer can't.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
