import { npubEncode } from 'nostr-tools/nip19';
import type { Event, EventTemplate } from 'nostr-tools/pure';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { callBridge } from '../../bridge';
import { extractPost, type ExtractedImage } from '../../extractors';
import { expandTweet, xExtractor } from '../../extractors/x';
import { cleanXLinks } from '../../extractors/x-links';
import { sendToBackground, type OpenComposerMsg, type RelayResult } from '../../messaging';
import { articleTemplate, articleTooLarge, blossomAuthTemplate, buildNote, checkSigned, encodeAuthHeader, wordCount, type PostImage } from '../../nostr/event';
import { retryable } from '../../nostr/retry';
import { cleanXLinksOn, settingsItem } from '../../settings';
import { h, trapFocus } from './dom';
import { composerSlot, createPill, pillView, type ComposerInstance, type PillState } from './publish-pill';
import { MAX_PASTED_IMAGES, MAX_PASTED_TOTAL, onPasteOrDrop } from './paste';

// one composer per page, expanded or as its pill
const slot = composerSlot();

const short = (npub: string) => `${npub.slice(0, 12)}…${npub.slice(-6)}`;

/** blob: URLs only exist in the page, so the background can't fetch them; hand it a data: URL instead. */
async function backgroundFetchableUrl(url: string): Promise<string> {
  if (!url.startsWith('blob:')) return url;
  let blob = await (await fetch(url)).blob();
  if (!blob.type.startsWith('image/')) blob = new Blob([blob], { type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.readAsDataURL(blob);
  });
}

export async function openComposer(ctx: ContentScriptContext, msg: OpenComposerMsg, target: Element | null) {
  if (slot.claim() === 'refuse') {
    // the background opened a session for this request; nothing will use it
    void sendToBackground({ type: 'close-session', sessionId: msg.sessionId }).catch(() => {});
    return;
  }
  try {
    slot.mounted(await mountComposer(ctx, msg, target));
  } catch (e) {
    slot.mounted(null);
    void sendToBackground({ type: 'close-session', sessionId: msg.sessionId }).catch(() => {});
    window.alert(`XMRadar: ${(e as Error).message}`);
  }
}

async function mountComposer(ctx: ContentScriptContext, msg: OpenComposerMsg, target: Element | null): Promise<ComposerInstance> {
  // a timeline tweet may be cut behind "Show more"; a selection is taken as it is
  if (!msg.selection?.trim() && xExtractor.matches(document)) target = (await expandTweet(target, document).catch(() => null)) ?? target;
  const { post, fallback } = extractPost(target, document, { selection: msg.selection, srcUrl: msg.srcUrl });
  const settings = await settingsItem.getValue();
  const previousFocus = document.activeElement as HTMLElement | null;
  let closed = false;
  // pictures pasted or dropped in: page-local blob: URLs, released when the composer goes
  const pasted = new Map<ExtractedImage, number>();
  let instance!: ComposerInstance;

  const ui = await createShadowRootUi(ctx, {
    name: 'xmradar-ui',
    // no full-page wrapper: the backdrop covers the page only while the composer is expanded
    position: 'inline',
    isolateEvents: true,
    onMount(container) {
      const close = () => {
        if (closed) return;
        closed = true;
        ui.remove();
      };
      // dismissed while busy: hidden for good, closed once the work ends
      let hidden = false;

      const status = h('div', { class: 'status', attrs: { role: 'status', 'aria-live': 'polite' } });
      const setStatus = (text: string, kind: 'info' | 'error' | 'ok' = 'info') => {
        status.className = `status ${kind}`;
        status.textContent = text;
      };
      let pillState: PillState = { kind: 'draft' };
      // the pill and, for the steps on the way, the composer's status line say the same
      const step = (state: PillState) => {
        pillState = state;
        const view = pillView(state, art ? 'article' : 'note');
        pill.update(view);
        if (state.kind !== 'published' && state.kind !== 'rejected' && state.kind !== 'draft') setStatus(view.text, view.tone);
      };

      const art = post.article;
      // X's share tracking out of links, shown so (PLAN-CLEANLINKS), and again at publish for edits
      const clean = (t: string) => (cleanXLinksOn(settings) ? cleanXLinks(t) : t);
      const textarea = h('textarea', { value: clean(post.text), rows: art ? 16 : 8, attrs: { 'aria-label': art ? 'Article text (Markdown)' : 'Note text' } });
      const titleInput = h('input', { type: 'text', value: clean(art?.title ?? ''), attrs: { 'aria-label': 'Article title', placeholder: 'Title' } });
      const summaryInput = h('input', { type: 'text', value: clean(art?.summary ?? ''), attrs: { 'aria-label': 'Article summary', placeholder: 'Summary (optional)' } });
      const sizeLine = h('div', { class: 'warn hidden' }, 'This article is over 60 KB. Some relays reject events this large.');
      const wordsLine = h('div', { class: 'signer' });
      const signerLine = h('div', { class: 'signer' }, 'Connecting to signer…');
      const dupeLine = h(
        'div',
        { class: 'warn hidden' },
        art ? 'You already published this article. Publishing again replaces the earlier version.' : 'You already posted this to Nostr.',
      );

      const selected = new Set<ExtractedImage>(post.images);
      // the post's images, then any pasted or dropped in (notes only); pasted ones live in this page only
      const images = [...post.images];
      const thumb = (img: ExtractedImage) => {
        const box = h('input', { type: 'checkbox', checked: true, attrs: { 'aria-label': 'Include image' } });
        box.addEventListener('change', () => (box.checked ? selected.add(img) : selected.delete(img)));
        return h('label', { class: 'thumb' }, h('img', { src: img.url, alt: img.alt ?? (pasted.has(img) ? 'Pasted image' : '') }), box);
      };
      const imageGrid = h('div', { class: images.length ? 'images' : 'images hidden' }, ...images.map(thumb));

      const reupload = h('input', { type: 'checkbox', checked: true });
      const appendSource = h('input', { type: 'checkbox', checked: settings.appendSourceLink });
      const debugPre = h('pre', { class: settings.debug ? 'debug' : 'hidden' });
      const results = h('ul', { class: 'results' });
      const publishBtn = h('button', { class: 'primary', textContent: art ? 'Publish article' : 'Publish' });
      const cancelBtn = h('button', { textContent: 'Cancel' });

      const dialog = h(
        'div',
        { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Copy post to Nostr' } },
        h('header', {}, h('h2', { textContent: art ? 'Copy article to Nostr' : 'Copy to Nostr' }), h('span', { class: 'site', textContent: art ? 'X Article' : post.site })),
        fallback ? h('div', { class: 'warn' }, msg.selection ? "Couldn't detect a post — using your selection." : "Couldn't detect a post — using page content.") : '',
        post.articleCard ? h('div', { class: 'warn' }, 'This post shares an X Article. To copy the whole article, open it and use Copy to Nostr there.') : '',
        signerLine,
        dupeLine,
        art ? titleInput : '',
        art ? summaryInput : '',
        textarea,
        art ? wordsLine : '',
        art ? sizeLine : '',
        imageGrid,
        h(
          'div',
          { class: 'options' },
          post.images.length ? h('label', {}, reupload, ' Re-upload images to Blossom') : '',
          h('label', {}, appendSource, ' Append link to original'),
        ),
        debugPre,
        status,
        results,
        h('footer', {}, cancelBtn, publishBtn),
      );
      const backdrop = h('div', { class: 'backdrop' }, dialog);
      const minimiseBtn = h('button', { class: 'icon', textContent: '–', attrs: { 'aria-label': 'Minimise', title: 'Minimise' } });
      dialog.querySelector('header')!.append(minimiseBtn);
      container.append(backdrop);

      const pill = createPill({ retry: () => void retry(), open: () => expand(), dismiss: () => dismiss() });
      const expanded = () => backdrop.isConnected;
      const minimise = () => {
        if (!expanded()) return;
        backdrop.remove();
        pill.update(pillView(pillState, art ? 'article' : 'note'));
        container.append(pill.el);
        previousFocus?.focus?.();
      };
      const expand = () => {
        if (expanded() || hidden) return;
        pill.el.remove();
        container.append(backdrop);
        textarea.focus();
      };
      // a publish or a retry under way
      const working = () => busy || retrying;
      const dismiss = () => {
        if (!working()) return close();
        hidden = true;
        pill.el.remove();
        slot.release(instance);
      };
      // while it publishes, leaving the composer only minimises it: the publish goes on
      const leave = () => (working() ? minimise() : close());
      instance = {
        busy: working,
        // published, with no failed relay left worth retrying
        finished: () => done && !shown.some(retryable),
        expanded,
        expand,
        close,
        notice: (text) => (expanded() ? setStatus(text) : pill.notice(text)),
      };

      cancelBtn.addEventListener('click', leave);
      minimiseBtn.addEventListener('click', minimise);
      // a click beside the composer keeps the draft
      backdrop.addEventListener('click', (e) => e.target === e.currentTarget && minimise());
      trapFocus(dialog, leave);
      dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) publishBtn.click();
      });
      setTimeout(() => textarea.focus(), 0);

      let pubkey: string | null = null;
      /** Returns the signer error message, or null on success. */
      const connect = async (): Promise<string | null> => {
        try {
          pubkey = await callBridge<string>('getPublicKey', undefined, 60_000);
          signerLine.textContent = `Posting as ${short(npubEncode(pubkey))}`;
          signerLine.className = 'signer';
          return null;
        } catch (e) {
          const message = (e as Error).message;
          signerLine.className = 'signer error';
          signerLine.replaceChildren(message, ' ', h('button', { class: 'link', textContent: 'Retry', onclick: () => void connect() }));
          return message;
        }
      };
      void connect();

      let dupeTimer: ReturnType<typeof setTimeout> | undefined;
      const checkDuplicate = () =>
        sendToBackground({ type: 'check-duplicate', sessionId: msg.sessionId, sourceUrl: post.sourceUrl, text: textarea.value })
          .then((r) => dupeLine.classList.toggle('hidden', !r.duplicate))
          .catch(() => {});
      void checkDuplicate();
      const checkSize = () => {
        if (!art) return;
        sizeLine.classList.toggle('hidden', !articleTooLarge(textarea.value));
        wordsLine.textContent = `${wordCount(textarea.value).toLocaleString()} words`;
      };
      checkSize();
      // a picture pasted or dropped into a note is added to its images and always uploaded to Blossom
      const pasteTarget = {
        accepts: () => !art && !busy && !done,
        room: () => ({ count: MAX_PASTED_IMAGES - pasted.size, bytes: MAX_PASTED_TOTAL - [...pasted.values()].reduce((a, b) => a + b, 0) }),
        add: (file: File) => {
          const img: ExtractedImage = { url: URL.createObjectURL(file) };
          images.push(img);
          pasted.set(img, file.size);
          selected.add(img);
          imageGrid.append(thumb(img));
          imageGrid.classList.remove('hidden');
        },
        status: setStatus,
      };
      textarea.addEventListener('paste', (e) => onPasteOrDrop(e, e.clipboardData, 'paste', pasteTarget));
      textarea.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
      });
      textarea.addEventListener('drop', (e) => onPasteOrDrop(e, e.dataTransfer, 'drop', pasteTarget));
      textarea.addEventListener('input', () => {
        checkSize();
        clearTimeout(dupeTimer);
        dupeTimer = setTimeout(checkDuplicate, 400);
      });

      const sign = async (template: EventTemplate) => {
        if (!pubkey) throw new Error('Signer not connected');
        const signed = await callBridge<Event>('signEvent', template);
        checkSigned(template, signed, pubkey);
        return signed;
      };

      const prepareImage = async (img: ExtractedImage): Promise<PostImage> => {
        if (!reupload.checked && !pasted.has(img)) {
          if (img.url.startsWith('blob:')) throw new Error('This image only exists in the page; enable re-upload or untick it');
          return { url: img.url, alt: img.alt };
        }
        try {
          const url = await backgroundFetchableUrl(img.url);
          const info = await sendToBackground({ type: 'fetch-image', sessionId: msg.sessionId, url });
          const auth = await sign(blossomAuthTemplate(info.sha256));
          const uploaded = await sendToBackground({ type: 'upload-image', sessionId: msg.sessionId, url, sha256: info.sha256, auth: encodeAuthHeader(auth) });
          return { url: uploaded.url, mime: info.mime, sha256: info.sha256, dim: info.dim, alt: img.alt };
        } catch (e) {
          // a page-local blob: URL is useless to anyone else, so there's no fallback for it
          if (!img.url.startsWith('blob:') && window.confirm(`Image upload failed: ${(e as Error).message}\n\nUse the original image URL instead?`)) {
            return { url: img.url, alt: img.alt };
          }
          throw new Error(`Image upload failed: ${(e as Error).message}`);
        }
      };

      // the latest result per relay, so a retry updates the list in place
      let shown: RelayResult[] = [];
      let published: Event | null = null;
      const retryBtn = h('button', { class: 'link', textContent: '' });
      const renderResults = (list: RelayResult[]) => {
        shown = shown.length ? shown.map((r) => list.find((n) => n.relay === r.relay) ?? r) : list;
        results.replaceChildren(...shown.map((r) => h('li', { class: r.ok ? 'ok' : 'error', textContent: `${r.ok ? '✓' : '✗'} ${r.relay}${r.ok ? '' : ` — ${r.message}`}` })));
        const again = shown.filter(retryable);
        if (published && again.length) {
          retryBtn.textContent = `Retry ${again.length} failed ${again.length === 1 ? 'relay' : 'relays'}`;
          results.append(h('li', {}, retryBtn));
        }
      };
      let outcome: Extract<PillState, { kind: 'published' }> | null = null;
      const showOutcome = () => {
        if (outcome && shown.some((r) => r.ok)) step({ ...outcome, results: shown });
        else step({ kind: 'rejected', results: shown });
      };
      let retrying = false;
      // the composer's link and the pill's Retry share this
      const retry = async () => {
        const again = shown.filter(retryable).map((r) => r.relay);
        if (!published || !again.length || retrying) return;
        retrying = retryBtn.disabled = true;
        retryBtn.textContent = 'Retrying…';
        step({ kind: 'retrying', count: again.length });
        try {
          renderResults((await sendToBackground({ type: 'republish', sessionId: msg.sessionId, event: published, relays: again })).results);
          // the status line said "Retrying…"
          if (shown.some((r) => r.ok)) showPublished();
          else setStatus(`No relay accepted the ${art ? 'article' : 'note'}.`, 'error');
          showOutcome();
        } catch (e) {
          setStatus((e as Error).message, 'error');
          renderResults([]);
          step({ kind: 'error', message: (e as Error).message });
        } finally {
          retrying = retryBtn.disabled = false;
          if (hidden) close();
        }
      };
      retryBtn.addEventListener('click', () => void retry());

      const showPublished = () => {
        if (!outcome) return;
        done = true;
        status.className = 'status ok';
        status.replaceChildren(
          'Published! ',
          h('a', { href: outcome.link.href, target: '_blank', rel: 'noopener', textContent: outcome.link.label }),
          ' ',
          h('button', { class: 'link', textContent: outcome.copyLabel, onclick: () => void navigator.clipboard.writeText(outcome!.ref) }),
        );
        publishBtn.textContent = 'Done';
        textarea.readOnly = titleInput.readOnly = summaryInput.readOnly = true;
      };

      let busy = false;
      let done = false;
      publishBtn.addEventListener('click', async () => {
        if (working()) return;
        if (done) return close();
        if (art && (!titleInput.value.trim() || !textarea.value.trim())) return setStatus('The article needs a title and text', 'error');
        if (!textarea.value.trim() && !selected.size) return setStatus('Nothing to post', 'error');
        busy = true;
        minimise();
        textarea.readOnly = titleInput.readOnly = summaryInput.readOnly = true;
        publishBtn.disabled = true;
        publishBtn.classList.add('busy');
        results.replaceChildren();
        try {
          if (!pubkey) {
            const err = await connect();
            if (err) throw new Error(err);
          }
          const prepared = new Map<ExtractedImage, PostImage>();
          for (const img of images.filter((i) => selected.has(i))) {
            step({ kind: 'uploading', index: prepared.size + 1, count: selected.size });
            prepared.set(img, await prepareImage(img));
            if (closed) return;
          }
          // the setting as it is now; a link pasted after opening is cleaned too
          const cleanNow = cleanXLinksOn(await settingsItem.getValue()) ? cleanXLinks : (t: string) => t;
          const text = cleanNow(textarea.value);
          let template: EventTemplate;
          if (art) {
            template = articleTemplate({
              article: art,
              postImages: post.images,
              prepared,
              title: cleanNow(titleInput.value),
              summary: cleanNow(summaryInput.value),
              markdown: text,
              sourceUrl: post.sourceUrl,
              appendSource: appendSource.checked,
            });
          } else {
            template = buildNote({ text, images: [...prepared.values()], sourceUrl: post.sourceUrl, appendSource: appendSource.checked });
          }
          if (settings.debug) debugPre.textContent = JSON.stringify(template, null, 2);
          step({ kind: 'signing' });
          const event = await sign(template);
          if (closed) return;
          step({ kind: 'publishing' });
          const res = await sendToBackground({ type: 'publish', sessionId: msg.sessionId, event, sourceUrl: post.sourceUrl, text });
          shown = [];
          published = event;
          const ref = res.naddr ?? res.nevent;
          // notes open in RipleyOS's Nostr app; it has no article (naddr) route yet, so articles stay on njump
          outcome = {
            kind: 'published',
            results: [],
            link: res.naddr ? { href: `https://njump.me/${ref}`, label: 'View on njump' } : { href: `https://app.ros.rip/nostr/note/${ref}`, label: 'View on ros.rip' },
            ref,
            copyLabel: res.naddr ? 'Copy naddr' : 'Copy nevent',
          };
          renderResults(res.results);
          if (res.results.some((r) => r.ok)) showPublished();
          else setStatus(`No relay accepted the ${art ? 'article' : 'note'}.`, 'error');
          showOutcome();
        } catch (e) {
          setStatus((e as Error).message, 'error');
          step({ kind: 'error', message: (e as Error).message });
        } finally {
          if (!done) textarea.readOnly = titleInput.readOnly = summaryInput.readOnly = false;
          busy = false;
          publishBtn.classList.remove('busy');
          publishBtn.disabled = false;
          if (hidden) close();
        }
      });
    },
    onRemove() {
      slot.release(instance);
      closed = true;
      for (const img of pasted.keys()) URL.revokeObjectURL(img.url);
      pasted.clear();
      void sendToBackground({ type: 'close-session', sessionId: msg.sessionId }).catch(() => {});
      // a composer replacing this one takes the focus after this
      previousFocus?.focus?.();
    },
  });
  try {
    ui.mount();
  } catch (e) {
    ui.remove();
    throw e;
  }
  return instance;
}
