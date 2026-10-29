/**
 * The missing-receipt warning (PLAN-NKIP01 §1.4 R12, PLAN-LOG §6): on an order page the signed xmr.club
 * feed lists with `log.format: "nkip01"`, a receipt is expected. The feed replaces the bundled adopter
 * list: a listing's operator says its order pages carry receipts, and xmr.club records it.
 */
export const missingReceiptText = (names: string[]) =>
  `xmr.club lists ${names.join(' and ')} as publishing a signed receipt (NKIP-0001) on its order pages, and this one shows none. If you deposit, keep a dated screenshot of this page.`;
