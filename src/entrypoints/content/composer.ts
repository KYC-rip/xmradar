import { npubEncode } from 'nostr-tools/nip19';
import type { Event, EventTemplate } from 'nostr-tools/pure';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { callBridge } from '../../bridge';
import { extractPost, type ExtractedImage } from '../../extractors';
import { sendToBackground, type OpenComposerMsg, type RelayResult } from '../../messaging';
import { articleTemplate, articleTooLarge, blossomAuthTemplate, buildNote, checkSigned, encodeAuthHeader, wordCount, type PostImage } from '../../nostr/event';
import { settingsItem } from '../../settings';
import { h, trapFocus } from './dom';

let open = false;

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
  if (open) return;
  open = true;
  try {
    await mountComposer(ctx, msg, target);
  } catch (e) {
    open = false;
    void sendToBackground({ type: 'close-session', sessionId: msg.sessionId }).catch(() => {});
    window.alert(`XMRadar: ${(e as Error).message}`);
  }
}

async function mountComposer(ctx: ContentScriptContext, msg: OpenComposerMsg, target: Element | null) {
  const { post, fallback } = extractPost(target, document, { selection: msg.selection, srcUrl: msg.srcUrl });
  const settings = await settingsItem.getValue();
  const previousFocus = document.activeElement as HTMLElement | null;
  let closed = false;

  const ui = await createShadowRootUi(ctx, {
    name: 'xmradar-ui',
    position: 'modal',
    zIndex: 2147483647,
    isolateEvents: true,
    onMount(container) {
      const close = () => {
        if (closed) return;
        closed = true;
        ui.remove();
      };

      const status = h('div', { class: 'status', attrs: { role: 'status', 'aria-live': 'polite' } });
      const setStatus = (text: string, kind: 'info' | 'error' | 'ok' = 'info') => {
        status.className = `status ${kind}`;
        status.textContent = text;
      };

      const art = post.article;
      const textarea = h('textarea', { value: post.text, rows: art ? 16 : 8, attrs: { 'aria-label': art ? 'Article text (Markdown)' : 'Note text' } });
      const titleInput = h('input', { type: 'text', value: art?.title ?? '', attrs: { 'aria-label': 'Article title', placeholder: 'Title' } });
      const summaryInput = h('input', { type: 'text', value: art?.summary ?? '', attrs: { 'aria-label': 'Article summary', placeholder: 'Summary (optional)' } });
      const sizeLine = h('div', { class: 'warn hidden' }, 'This article is over 60 KB. Some relays reject events this large.');
      const wordsLine = h('div', { class: 'signer' });
      const signerLine = h('div', { class: 'signer' }, 'Connecting to signer…');
      const dupeLine = h(
        'div',
        { class: 'warn hidden' },
        art ? 'You already published this article. Publishing again replaces the earlier version.' : 'You already posted this to Nostr.',
      );

      const selected = new Set<ExtractedImage>(post.images);
      const imageGrid = h(
        'div',
        { class: 'images' },
        ...post.images.map((img) => {
          const box = h('input', { type: 'checkbox', checked: true, attrs: { 'aria-label': 'Include image' } });
          box.addEventListener('change', () => (box.checked ? selected.add(img) : selected.delete(img)));
          return h('label', { class: 'thumb' }, h('img', { src: img.url, alt: img.alt ?? '' }), box);
        }),
      );

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
        post.images.length ? imageGrid : '',
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
      container.append(h('div', { class: 'backdrop' }, dialog));

      cancelBtn.addEventListener('click', close);
      dialog.parentElement!.addEventListener('click', (e) => e.target === e.currentTarget && close());
      trapFocus(dialog, close);
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
        if (!reupload.checked) {
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

      const renderResults = (list: RelayResult[]) =>
        results.replaceChildren(...list.map((r) => h('li', { class: r.ok ? 'ok' : 'error', textContent: `${r.ok ? '✓' : '✗'} ${r.relay}${r.ok ? '' : ` — ${r.message}`}` })));

      let busy = false;
      let done = false;
      publishBtn.addEventListener('click', async () => {
        if (done) return close();
        if (busy) return;
        if (art && (!titleInput.value.trim() || !textarea.value.trim())) return setStatus('The article needs a title and text', 'error');
        if (!textarea.value.trim() && !selected.size) return setStatus('Nothing to post', 'error');
        busy = true;
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
          for (const img of post.images.filter((i) => selected.has(i))) {
            setStatus(`Uploading image ${prepared.size + 1}…`);
            prepared.set(img, await prepareImage(img));
            if (closed) return;
          }
          const text = textarea.value;
          let template: EventTemplate;
          if (art) {
            template = articleTemplate({
              article: art,
              postImages: post.images,
              prepared,
              title: titleInput.value,
              summary: summaryInput.value,
              markdown: text,
              sourceUrl: post.sourceUrl,
              appendSource: appendSource.checked,
            });
          } else {
            template = buildNote({ text, images: [...prepared.values()], sourceUrl: post.sourceUrl, appendSource: appendSource.checked });
          }
          if (settings.debug) debugPre.textContent = JSON.stringify(template, null, 2);
          setStatus('Waiting for signer…');
          const event = await sign(template);
          if (closed) return;
          setStatus('Publishing…');
          const res = await sendToBackground({ type: 'publish', sessionId: msg.sessionId, event, sourceUrl: post.sourceUrl, text });
          renderResults(res.results);
          if (res.results.some((r) => r.ok)) {
            done = true;
            const ref = res.naddr ?? res.nevent;
            // notes open in RipleyOS's Nostr app; it has no article (naddr) route yet, so articles stay on njump
            const link = res.naddr ? `https://njump.me/${ref}` : `https://app.ros.rip/nostr/note/${ref}`;
            status.className = 'status ok';
            status.replaceChildren(
              'Published! ',
              h('a', { href: link, target: '_blank', rel: 'noopener', textContent: res.naddr ? 'View on njump' : 'View on ros.rip' }),
              ' ',
              h('button', { class: 'link', textContent: res.naddr ? 'Copy naddr' : 'Copy nevent', onclick: () => void navigator.clipboard.writeText(ref) }),
            );
            publishBtn.textContent = 'Done';
            textarea.readOnly = true;
          } else {
            setStatus(`No relay accepted the ${art ? 'article' : 'note'}.`, 'error');
          }
        } catch (e) {
          setStatus((e as Error).message, 'error');
        } finally {
          if (!done) textarea.readOnly = titleInput.readOnly = summaryInput.readOnly = false;
          busy = false;
          publishBtn.classList.remove('busy');
          publishBtn.disabled = false;
        }
      });
    },
    onRemove() {
      open = false;
      closed = true;
      void sendToBackground({ type: 'close-session', sessionId: msg.sessionId }).catch(() => {});
      previousFocus?.focus?.();
    },
  });
  try {
    ui.mount();
  } catch (e) {
    ui.remove();
    throw e;
  }
}
