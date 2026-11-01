import { aiReady, suggestTags, type SuggestResult } from './tags';
import { aiKeyItem, aiTagsItem, autoAddOn, autoOn, patchAiTags, type AiSource } from '../settings';

/** The background's tag-suggestion requests (PLAN-TAGS), after its session check. The key never leaves here. */

export async function tagsReady() {
  const ai = await aiTagsItem.getValue();
  return { ready: aiReady(ai, await aiKeyItem.getValue()), local: ai.source === 'local', source: ai.source, auto: autoOn(ai), autoAdd: autoAddOn(ai) };
}

/** A composer opened for one source never sends to another chosen since (it still says "local model"). */
export async function suggestFor(msg: { text: unknown; have?: unknown; source?: unknown }, fetchFn: typeof fetch = fetch): Promise<SuggestResult> {
  const ai = await aiTagsItem.getValue();
  if (msg.source !== ai.source) return { status: 'failed', reason: 'Tag settings changed: close and reopen the composer' };
  const have = Array.isArray(msg.have) ? msg.have.filter((t): t is string => typeof t === 'string') : [];
  return suggestTags(ai, await aiKeyItem.getValue(), String(msg.text), fetchFn, undefined, have);
}

/** The composer's Auto switch: `auto` only (autoAdd stays as set in Options), for the source it was opened with. */
export async function setAuto(msg: { on: unknown; source: unknown }): Promise<{ ok: true }> {
  if (typeof msg.on !== 'boolean') throw new Error('Bad request');
  if (msg.source !== ((await aiTagsItem.getValue()).source as AiSource)) throw new Error('Tag settings changed: close and reopen the composer');
  await patchAiTags({ auto: msg.on });
  // the source changed while saving: a choice made for the old one doesn't carry over
  if (msg.source !== (await aiTagsItem.getValue()).source) {
    await patchAiTags({ auto: undefined });
    throw new Error('Tag settings changed: close and reopen the composer');
  }
  return { ok: true };
}
