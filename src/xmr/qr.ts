import qrcode from 'qrcode-generator';

/** One SVG path (`d`) for the dark modules of a QR code, plus its size in modules (no quiet zone). */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return { size, d };
}
