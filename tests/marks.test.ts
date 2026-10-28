import { describe, expect, it } from 'vitest';
import { findMark, MARK_TTL_MS, withMark, type Marks } from '../src/xap/marks';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('Xap marks', () => {
  it('keeps one mark per recipient until it is removed or a day old', () => {
    let m: Marks = withMark([], A, 123n, 1000);
    m = withMark(m, B, 7n, 1000);
    expect(findMark(m, A, 2000)).toBe(123n);
    expect(findMark(m, B, 2000)).toBe(7n);
    m = withMark(m, A, 456n, 3000);
    expect(m.filter(([pk]) => pk === A)).toHaveLength(1);
    expect(findMark(m, A, 3000)).toBe(456n);
    expect(findMark(m, A, 3000 + MARK_TTL_MS)).toBeNull();
    expect(findMark(withMark(m, A, null, 4000), A, 4000)).toBeNull();
  });

  it('ignores marks out of range, malformed, or from the future', () => {
    const bad: Marks = [[A, '0', 1000], [A, '1000000', 1000], [A, '12a', 1000], [A, '5', 9000]];
    for (const e of bad) expect(findMark([e], A, 2000)).toBeNull();
  });
});
