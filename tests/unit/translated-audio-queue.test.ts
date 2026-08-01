import { describe, expect, it } from 'vitest';
import { TranslatedAudioQueue, type AudioFrame } from '@/audio/translated-audio-queue';

const frame = (seq: number, sessionId = 's1'): AudioFrame => ({
  seq,
  pcm16_b64: `f${seq}`,
  sessionId,
});

describe('translated audio queue', () => {
  it('releases contiguous frames in order', () => {
    const q = new TranslatedAudioQueue('s1');
    expect(q.enqueue(frame(0)).ready.map((f) => f.seq)).toEqual([0]);
    expect(q.enqueue(frame(1)).ready.map((f) => f.seq)).toEqual([1]);
    expect(q.enqueue(frame(2)).ready.map((f) => f.seq)).toEqual([2]);
  });

  it('buffers an out-of-order frame and flushes once the gap fills', () => {
    const q = new TranslatedAudioQueue('s1');
    q.enqueue(frame(0));

    // 2 arrives before 1 — hold it rather than playing speech out of order.
    expect(q.enqueue(frame(2)).ready).toEqual([]);
    expect(q.bufferedCount).toBe(1);

    const filled = q.enqueue(frame(1));
    expect(filled.ready.map((f) => f.seq)).toEqual([1, 2]);
    expect(q.bufferedCount).toBe(0);
  });

  it('drops stale frames instead of playing old speech over new', () => {
    const q = new TranslatedAudioQueue('s1');
    q.enqueue(frame(0));
    q.enqueue(frame(1));

    const late = q.enqueue(frame(0));
    expect(late.ready).toEqual([]);
    expect(late.dropped).toBe('stale');
    expect(q.lastPlayedSeq).toBe(1);
  });

  it('drops duplicates', () => {
    const q = new TranslatedAudioQueue('s1');
    q.enqueue(frame(0));
    q.enqueue(frame(2));
    const dup = q.enqueue(frame(2));
    expect(dup.dropped).toBe('duplicate');
  });

  it('rejects frames from another session', () => {
    const q = new TranslatedAudioQueue('s1');
    const wrong = q.enqueue(frame(0, 's2'));
    expect(wrong.dropped).toBe('wrong-session');
    expect(wrong.ready).toEqual([]);
  });

  it('skips a permanently lost frame instead of stalling forever', () => {
    const q = new TranslatedAudioQueue('s1', { maxBuffered: 64, maxGapWait: 3 });
    q.enqueue(frame(0));

    // seq 1 never arrives. After maxGapWait arrivals we must move on.
    q.enqueue(frame(2));
    q.enqueue(frame(3));
    const released = q.enqueue(frame(4));

    expect(released.ready.map((f) => f.seq)).toEqual([2, 3, 4]);
    expect(q.lastPlayedSeq).toBe(4);
  });

  it('bounds memory by evicting the oldest held frame on overflow', () => {
    const q = new TranslatedAudioQueue('s1', { maxBuffered: 3, maxGapWait: 100 });
    // seq 0 never arrives, so nothing drains and the buffer fills.
    q.enqueue(frame(1));
    q.enqueue(frame(2));
    q.enqueue(frame(3));
    expect(q.bufferedCount).toBe(3);

    const overflow = q.enqueue(frame(4));
    expect(overflow.dropped).toBe('overflow');
    expect(q.bufferedCount).toBeLessThanOrEqual(3);
  });

  it('cancel clears pending audio so a stopped session plays nothing more', () => {
    const q = new TranslatedAudioQueue('s1');
    q.enqueue(frame(0));
    q.enqueue(frame(5));
    expect(q.bufferedCount).toBe(1);

    q.cancel();
    expect(q.bufferedCount).toBe(0);
  });
});
