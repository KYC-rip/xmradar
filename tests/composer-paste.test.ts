import { describe, expect, it, vi } from 'vitest';
import { imageFiles, MAX_PASTED_BYTES, MAX_PASTED_TOTAL, onPasteOrDrop, type PasteTarget } from '../src/entrypoints/content/paste';

const file = (name: string, type: string, size = 10) => ({ name, type, size, lastModified: 1 }) as File;
const room = { count: 8, bytes: MAX_PASTED_TOTAL };
const data = (files: File[], opts: { text?: string; items?: File[]; types?: string[] } = {}) =>
  ({
    files,
    items: (opts.items ?? []).map((f) => ({ kind: 'file', getAsFile: () => f })),
    types: opts.types ?? (files.length || opts.items?.length ? ['Files'] : []),
    getData: (t: string) => (t === 'text/plain' ? (opts.text ?? '') : ''),
  }) as unknown as DataTransfer;

function target(accepts = true) {
  const added: File[] = [];
  const statuses: [string, string][] = [];
  const t: PasteTarget = { accepts: () => accepts, room: () => room, add: (f) => added.push(f), status: (s, k) => statuses.push([s, k]) };
  const e = { preventDefault: vi.fn() };
  return { t, e, added, statuses };
}

describe('pasting pictures into the composer', () => {
  it('a pasted screenshot is added', () => {
    expect(imageFiles(data([file('image.png', 'image/png')]), 'paste', room).images).toHaveLength(1);
  });
  it('a clipboard that only fills items (not files) works, and one in both lists counts once', () => {
    const shot = file('image.png', 'image/png');
    expect(imageFiles(data([], { items: [shot] }), 'paste', room).images).toEqual([shot]);
    expect(imageFiles(data([shot], { items: [{ ...shot } as File] }), 'paste', room).images).toHaveLength(1);
    // Chrome's getAsFile() hands out a new File with a new timestamp: still one picture
    const again = new File([new Uint8Array(shot.size)], shot.name, { type: shot.type, lastModified: shot.lastModified + 5 });
    expect(imageFiles(data([shot], { items: [again] }), 'paste', room).images).toEqual([shot]);
  });
  it('a paste with text stays a text paste, even if a picture comes along', () => {
    expect(imageFiles(data([file('image.png', 'image/png')], { text: 'hello' }), 'paste', room)).toEqual({ images: [], refused: [] });
  });
  it('a drop takes files whatever else it carries', () => {
    expect(imageFiles(data([file('a.jpg', 'image/jpeg')], { text: 'a.jpg' }), 'drop', room).images).toHaveLength(1);
  });
  it('refuses non-images and SVG, files over 20 MB (exactly 20 MB is fine), and past the count or total', () => {
    const r = imageFiles(
      data([file('a.pdf', 'application/pdf'), file('b.svg', 'image/svg+xml'), file('c.png', 'image/png', MAX_PASTED_BYTES + 1), file('d.png', 'image/png', MAX_PASTED_BYTES), file('e.gif', 'image/gif')]),
      'drop',
      { count: 1, bytes: MAX_PASTED_TOTAL },
    );
    expect(r.images.map((f) => f.name)).toEqual(['d.png']);
    expect(r.refused).toEqual(["a.pdf isn't an image", "b.svg isn't an image", 'c.png is larger than 20 MB', 'e.gif: no room for more than 8 added images']);
    expect(imageFiles(data([file('f.png', 'image/png', 30)]), 'drop', { count: 8, bytes: 20 }).refused).toEqual(["f.png: added images can't pass 40 MB in all"]);
  });
  it('nothing to read: nothing added, nothing refused', () => {
    expect(imageFiles(null, 'paste', room)).toEqual({ images: [], refused: [] });
    expect(imageFiles(data([]), 'paste', room)).toEqual({ images: [], refused: [] });
  });
});

describe('the paste and drop handler', () => {
  it('a pasted picture is added and the browser paste is stopped', () => {
    const { t, e, added, statuses } = target();
    onPasteOrDrop(e, data([file('image.png', 'image/png')]), 'paste', t);
    expect(added).toHaveLength(1);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(statuses).toEqual([['Image added; uploaded to Blossom when you publish.', 'info']]);
  });
  it('a text paste goes through untouched', () => {
    const { t, e, added, statuses } = target();
    onPasteOrDrop(e, data([], { text: 'hello', types: ['text/plain'] }), 'paste', t);
    expect([added, statuses, e.preventDefault.mock.calls]).toEqual([[], [], []]);
  });
  it('some added, some refused: both said', () => {
    const { t, e, added, statuses } = target();
    onPasteOrDrop(e, data([file('a.png', 'image/png'), file('b.pdf', 'application/pdf')]), 'drop', t);
    expect(added).toHaveLength(1);
    expect(statuses).toEqual([["Image added; uploaded to Blossom when you publish. Not added: b.pdf isn't an image", 'error']]);
  });
  it('an article, or a note while publishing: a dropped file is refused, never opened; a paste is left alone', () => {
    const drop = target(false);
    onPasteOrDrop(drop.e, data([file('a.png', 'image/png')]), 'drop', drop.t);
    expect(drop.e.preventDefault).toHaveBeenCalled();
    expect(drop.added).toEqual([]);
    expect(drop.statuses[0]![1]).toBe('error');
    const paste = target(false);
    onPasteOrDrop(paste.e, data([file('a.png', 'image/png')]), 'paste', paste.t);
    expect([paste.added, paste.statuses, paste.e.preventDefault.mock.calls]).toEqual([[], [], []]);
  });
  it('a dropped file that adds nothing still never opens', () => {
    const { t, e } = target();
    onPasteOrDrop(e, data([], { types: ['Files'] }), 'drop', t);
    expect(e.preventDefault).toHaveBeenCalled();
  });
});
