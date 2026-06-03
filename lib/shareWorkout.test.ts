/**
 * lib/shareWorkout.test.ts — locks the shared share-payload builder used by both
 * the group feed and the post-commit share prompt.
 */
import { describe, it, expect } from 'vitest';
import { summarizeDay, toPostPayload } from '@/lib/shareWorkout';
import type { DayRecord } from '@/lib/AppContext';

const liftDay = {
  exercises: JSON.stringify([
    { k: 'lift', n: 'Bench Press', g: 'chest', sets: [{ r: '5', w: '185' }, { r: '5', w: '185' }] },
  ]),
} as DayRecord;

describe('summarizeDay', () => {
  it('summarizes a lift day (title, lines, volume, counts)', () => {
    const s = summarizeDay(liftDay);
    expect(s.hasContent).toBe(true);
    expect(s.title.toLowerCase()).toContain('chest');
    expect(s.liftCount).toBe(1);
    expect(s.setCount).toBe(2);
    expect(s.volume).toBe(2 * 5 * 185); // 1850
    expect(s.lines[0]).toContain('Bench Press');
  });

  it('summarizes cardio from the top-level fields', () => {
    const s = summarizeDay({ runDist: 5, runTime: 40 } as DayRecord);
    expect(s.hasContent).toBe(true);
    expect(s.cardio).toEqual([{ kind: 'run', dist: 5, time: 40 }]);
    expect(s.lines.join(' ')).toContain('Ran 5 mi');
  });

  it('an empty / missing day has no content (so the prompt skips it)', () => {
    expect(summarizeDay(undefined).hasContent).toBe(false);
    expect(summarizeDay({ exercises: '[]' } as DayRecord).hasContent).toBe(false);
  });
});

describe('toPostPayload', () => {
  it('is the subset of the summary that gets posted (no hasContent flag)', () => {
    const p = toPostPayload(summarizeDay(liftDay));
    expect(p).toHaveProperty('exercises');
    expect(p).toHaveProperty('volume', 1850);
    expect(p).not.toHaveProperty('hasContent');
  });
});
