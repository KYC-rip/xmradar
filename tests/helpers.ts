import { Window } from 'happy-dom';

/** Build a standalone document at a given URL so hostname-based detection works. */
export function makeDoc(url: string, body: string, head = ''): Document {
  const win = new Window({ url });
  win.document.write(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`);
  return win.document as unknown as Document;
}
