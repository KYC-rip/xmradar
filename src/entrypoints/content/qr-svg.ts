import { qrPath } from '../../xmr/qr';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function qrSvg(text: string): SVGSVGElement {
  const { size, d } = qrPath(text);
  const pad = 4;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${size + pad * 2} ${size + pad * 2}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code of the Monero payment link');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of Object.entries({ x: -pad, y: -pad, width: size + pad * 2, height: size + pad * 2, fill: '#fff' })) bg.setAttribute(k, String(v));
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}
