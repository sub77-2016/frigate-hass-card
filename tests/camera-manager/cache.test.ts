import add from 'date-fns/add';
import sub from 'date-fns/sub';
import sortBy from 'lodash-es/sortBy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryRequestCache,
  RecordingSegmentsCache,
} from '../../src/camera-manager/cache.js';
import { DateRange } from '../../src/camera-manager/range.js';
import { RecordingSegment } from '../../src/camera-manager/types.js';

describe('MemoryRequestCache', () => {
  const cache = new MemoryRequestCache();
  const request = { request: 'foo' };
  const response = { response: 'bar' };

  beforeEach(() => {
    cache.clear();
  });

  it('should get value when set', () => {
    cache.set(request, response);
    expect(cache.get(request)).toBe(response);
  });
  it('should get similar value when set', () => {
    cache.set(request, response);
    expect(cache.get({ ...request })).toBe(response);
  });
  it('should be empty when cleared', () => {
    cache.set(request, response);
    expect(cache.get({ ...request })).toBe(response);
    cache.clear();
    expect(cache.get(request)).toBeNull();
  });
  it('should have value when set', () => {
    cache.set(request, response);
    expect(cache.has(request)).toBeTruthy();
  });
  it('should not have value when set expired', () => {
    cache.set(request, response, sub(new Date(), { hours: 1 }));
    expect(cache.has(request)).toBeFalsy();
  });
  it('should not have value when get expired', () => {
    const now = new Date();
    cache.set(request, response, add(now, { hours: 1 }));
    expect(cache.has(request)).toBeTruthy();

    vi.useFakeTimers();
    vi.setSystemTime(add(now, { hours: 2 }));
    expect(cache.has(request)).toBeFalsy();
    vi.useRealTimers();
  });
});

describe('RecordingSegmentsCache', () => {
  const cache = new RecordingSegmentsCache();
  const now = new Date();
  const range: DateRange = {
    start: now,
    end: add(now, { hours: 1 }),
  };
  const badRange = { start: sub(now, { hours: 1 }), end: now };
  const createSegment = (date: Date, id: string): RecordingSegment => {
    return {
      start_time: date.getTime() / 1000,
      end_time: date.getTime() / 1000 + 10,
      id: id,
    };
  };
  const segments = [
    createSegment(now, 'segment-1'),
    createSegment(add(now, { seconds: 10 }), 'segment-2'),
    createSegment(add(now, { seconds: 20 }), 'segment-3'),
  ];

  beforeEach(() => {
    cache.clear();
  });

  it('should get segments when added', () => {
    cache.add('camera-1', range, segments);
    expect(cache.get('camera-1', range)).toEqual(segments);
  });
  it('should get some segments for shorter range', () => {
    cache.add('camera-1', range, segments);
    expect(cache.get('camera-1', { ...range, end: add(now, { seconds: 5 }) })).toEqual([
      segments[0],
    ]);
  });
  it('should not get for other range', () => {
    cache.add('camera-1', range, segments);
    expect(cache.get('camera-1', badRange)).toBeNull();
  });

  it('should have coverage when added', () => {
    cache.add('camera-1', range, segments);
    expect(cache.hasCoverage('camera-1', range)).toBeTruthy();
  });
  it('should not have coverage for other camera', () => {
    cache.add('camera-1', range, segments);
    expect(cache.hasCoverage('camera-2', range)).toBeFalsy();
  });
  it('should not have coverage for other range', () => {
    cache.add('camera-1', range, segments);
    expect(cache.hasCoverage('camera-1', badRange)).toBeFalsy();
  });

  it('should be empty when cleared', () => {
    cache.add('camera-1', range, segments);
    cache.clear();
    expect(cache.get('camera-1', range)).toBeNull();
    expect(cache.hasCoverage('camera-1', range)).toBeFalsy();
  });

  it('should return internal cache', () => {
    cache.add('camera-1', range, segments);
    const internalCache = cache.getCache('camera-1');
    expect(internalCache).toBeTruthy();
    expect(internalCache?.get(range)).toEqual(segments);
  });
  it('should not return internal cache for wrong camera', () => {
    cache.add('camera-1', range, segments);
    expect(cache.getCache('camera-2')).toBeNull();
  });

  it('should return cameraIDs', () => {
    cache.add('camera-1', range, segments);
    cache.add('camera-2', range, segments);
    expect(sortBy(cache.getCameraIDs())).toEqual(sortBy(['camera-1', 'camera-2']));
  });

  it('should remove expired matches', () => {
    cache.add('camera-1', range, segments);
    cache.expireMatches('camera-1', (segment) => segment === segments[0]);
    expect(sortBy(cache.get('camera-1', range))).toEqual(segments.splice(1));
  });
});
