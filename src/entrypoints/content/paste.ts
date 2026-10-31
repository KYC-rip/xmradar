/** What a paste or drop into the composer adds as images (pasted pictures always go through Blossom). */

export const MAX_PASTED_BYTES = 20 * 1024 * 1024;
export const MAX_PASTED_TOTAL = 40 * 1024 * 1024;
export const MAX_PASTED_IMAGES = 8;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/** what's still allowed: images and bytes */
export interface Room {
  count: number;
  bytes: number;
}

export interface PastedFiles {
  images: File[];
  /** why a file was left out, for the status line */
  refused: string[];
}

/**
 * The files of a paste or drop: `files` when it has any, else the file `items` (some clipboards fill only one).
 * Never both: when both are filled they hold the same pictures, and each `getAsFile()` copy carries a new
 * timestamp, so a pasted screenshot would be added twice.
 */
function filesOf(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []);
  if (files.length) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((f): f is File => !!f);
}

/**
 * The image files in a paste or drop. A paste that also carries text (copied from a page or a document,
 * which often brings a rendered picture along) stays a text paste; a drop only takes files.
 */
export function imageFiles(data: DataTransfer | null, kind: 'paste' | 'drop', room: Room): PastedFiles {
  const out: PastedFiles = { images: [], refused: [] };
  if (!data) return out;
  if (kind === 'paste' && data.getData('text/plain')) return out;
  let { count, bytes } = room;
  for (const file of filesOf(data)) {
    const name = file.name || 'image';
    if (!IMAGE_TYPES.has(file.type)) out.refused.push(`${file.name || 'file'} isn't an image`);
    else if (file.size > MAX_PASTED_BYTES) out.refused.push(`${name} is larger than 20 MB`);
    else if (count <= 0) out.refused.push(`${name}: no room for more than ${MAX_PASTED_IMAGES} added images`);
    else if (file.size > bytes) out.refused.push(`${name}: added images can't pass 40 MB in all`);
    else {
      out.images.push(file);
      count--;
      bytes -= file.size;
    }
  }
  return out;
}

export interface PasteTarget {
  /** a note that isn't publishing: pictures can be added */
  accepts(): boolean;
  room(): Room;
  add(file: File): void;
  status(text: string, kind: 'info' | 'error'): void;
}

/** A paste or drop on the note text: pictures are added, text pastes go through, a file drop never opens the file. */
export function onPasteOrDrop(e: { preventDefault(): void }, data: DataTransfer | null, kind: 'paste' | 'drop', target: PasteTarget): void {
  // a dropped file the page doesn't take would be opened by the browser, leaving the composer
  const fileDrop = kind === 'drop' && !!data && Array.from(data.types ?? []).includes('Files');
  if (!target.accepts()) {
    if (fileDrop) {
      e.preventDefault();
      target.status('Pictures can only be added to a note, and not while it is publishing', 'error');
    }
    return;
  }
  const { images, refused } = imageFiles(data, kind, target.room());
  if (!images.length && !refused.length) {
    if (fileDrop) e.preventDefault();
    return;
  }
  e.preventDefault();
  for (const file of images) target.add(file);
  const added = images.length ? `${images.length > 1 ? `${images.length} images` : 'Image'} added; uploaded to Blossom when you publish.` : '';
  if (refused.length) target.status(`${added ? `${added} ` : ''}Not added: ${[...new Set(refused)].join('; ')}`, 'error');
  else target.status(added, 'info');
}
