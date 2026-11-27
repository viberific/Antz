import type { AnnotationView } from './annotator';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 17;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>, parent: SVGElement): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent.appendChild(e);
  return e;
}

/**
 * Draws the annotation on top of the canvas: a ring on the animal, a hairline leader, and a caption card beside it;
 * or, for colony events, a lower-third banner. All imperative DOM, updated each frame without going through React.
 */
export class AnnotationOverlay {
  private readonly layer: HTMLDivElement;
  private readonly svgRoot: SVGSVGElement;
  private readonly ring: SVGGElement;
  private readonly ringCircle: SVGCircleElement;
  private readonly leader: SVGPathElement;
  private readonly card: HTMLDivElement;
  private readonly banner: HTMLDivElement;

  private key = '';
  private side: 1 | -1 = 1;
  private cx = 0;
  private cy = 0;
  private placed = false;
  private lastW = 0;
  private lastH = 0;

  constructor(private readonly container: HTMLElement) {
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.layer = el('div', 'an-layer');
    this.layer.setAttribute('aria-live', 'polite');
    this.svgRoot = document.createElementNS(SVG_NS, 'svg');
    this.svgRoot.setAttribute('class', 'an-svg');
    this.leader = svg('path', { class: 'an-leader', fill: 'none', 'stroke-width': '1.25' }, this.svgRoot);
    this.ring = svg('g', { class: 'an-ring' }, this.svgRoot);
    this.ringCircle = svg('circle', { r: String(RING_R), fill: 'none', 'stroke-width': '1.6' }, this.ring);
    this.layer.appendChild(this.svgRoot);
    this.card = el('div', 'an-card', this.layer);
    this.banner = el('div', 'an-banner', this.layer);
    this.hideAll();
    container.appendChild(this.layer);
  }

  public dispose(): void {
    this.layer.remove();
  }

  private hideAll(): void {
    this.svgRoot.style.display = 'none';
    this.card.style.display = 'none';
    this.banner.style.display = 'none';
    this.key = '';
  }

  private fill(target: HTMLElement, v: AnnotationView): void {
    target.textContent = '';
    target.style.setProperty('--accent', v.accent);
    const kick = el('div', 'an-kicker', target);
    el('span', 'an-pip', kick);
    el('span', '', kick, v.kicker);
    el('div', 'an-title', target, v.title);
    if (v.term) el('div', 'an-term', target, v.term);
    el('div', 'an-body', target, v.body);
    if (v.aside) el('div', 'an-aside', target, v.aside);
    if (v.chips.length) {
      const chips = el('div', 'an-chips', target);
      for (const c of v.chips) el('span', 'an-chip', chips, c);
    }
  }

  /**
   * @param anchor canvas-pixel position of the subject (callouts only)
   * @param size   canvas size in pixels
   */
  public update(view: AnnotationView | null, anchor: { x: number; y: number } | null, dt: number, size: { w: number; h: number }): void {
    if (!view || view.alpha <= 0.002 || (view.layout === 'callout' && !anchor)) {
      if (this.key !== '') this.hideAll();
      return;
    }
    const { w, h } = size;
    if (w !== this.lastW || h !== this.lastH) {
      this.lastW = w;
      this.lastH = h;
      const fs = Math.max(10.5, Math.min(14, h / 31));
      this.layer.style.setProperty('--an-fs', `${fs.toFixed(2)}px`);
      this.layer.style.setProperty('--an-w', `${Math.round(Math.max(210, Math.min(340, w * 0.33)))}px`);
      this.layer.style.setProperty('--an-bw', `${Math.round(Math.max(280, Math.min(520, w * 0.5)))}px`);
      this.placed = false;
    }
    const a = view.alpha;
    const eased = a * a * (3 - 2 * a);

    if (view.layout === 'banner') {
      this.card.style.display = 'none';
      this.svgRoot.style.display = 'none';
      if (this.key !== view.key) {
        this.fill(this.banner, view);
        this.key = view.key;
      }
      this.banner.style.display = 'block';
      this.banner.style.opacity = String(eased);
      this.banner.style.transform = `translateY(${((1 - eased) * 10).toFixed(1)}px)`;
      return;
    }

    this.banner.style.display = 'none';
    const p = anchor!;
    if (this.key !== view.key) {
      this.fill(this.card, view);
      this.key = view.key;
      this.placed = false;
    }
    this.card.style.display = 'block';
    this.svgRoot.style.display = 'block';
    this.svgRoot.style.setProperty('--accent', view.accent);

    const cw = this.card.offsetWidth;
    const ch = this.card.offsetHeight;
    const gapX = RING_R + 46;
    const roomR = w - p.x - gapX - 10;
    const roomL = p.x - gapX - 10;
    // keep the card on the side it started on unless the other side has clearly more room
    if (this.side === 1 && roomR < cw && roomL > roomR + 40) this.side = -1;
    else if (this.side === -1 && roomL < cw && roomR > roomL + 40) this.side = 1;
    let tx = this.side === 1 ? p.x + gapX : p.x - gapX - cw;
    tx = Math.max(10, Math.min(w - cw - 10, tx));
    let ty = p.y - ch * 0.38;
    ty = Math.max(52, Math.min(h - ch - 12, ty));
    if (!this.placed) {
      this.cx = tx;
      this.cy = ty;
      this.placed = true;
    } else {
      const k = 1 - Math.exp(-5 * dt);
      this.cx += (tx - this.cx) * k;
      this.cy += (ty - this.cy) * k;
    }
    this.card.style.opacity = String(eased);
    this.card.style.transform = `translate(${this.cx.toFixed(1)}px, ${(this.cy + (1 - eased) * 8).toFixed(1)}px)`;

    // ring on the animal; the leader runs from its edge to the card's near edge
    this.ring.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) scale(${(0.85 + 0.15 * eased).toFixed(3)})`);
    const ex = this.side === 1 ? this.cx : this.cx + cw;
    const ey = this.cy + Math.min(22, ch * 0.3);
    const dx = ex - p.x;
    const dy = ey - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const sx = p.x + (dx / len) * (RING_R + 1);
    const sy = p.y + (dy / len) * (RING_R + 1);
    // draw the line growing out from the ring as the caption fades in
    const gx = sx + (ex - sx) * eased;
    const gy = sy + (ey - sy) * eased;
    this.leader.setAttribute('d', `M${sx.toFixed(1)} ${sy.toFixed(1)}L${gx.toFixed(1)} ${gy.toFixed(1)}`);
    this.svgRoot.style.opacity = String(Math.min(1, eased * 1.4));
  }
}
