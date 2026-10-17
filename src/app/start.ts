// Start screen shown when both sides are empty: Browse one package, or Compare two.
// Owned by UI / UX. The compare card hosts the existing empty-hint-a/b elements
// (moved in and out), so their testids stay unique.
import type { AppMode, Side } from '../types';
import { h } from './dom';

export interface StartHost {
  hints: Record<Side, HTMLElement>;
  /** Where the hints live when the start screen is not shown. */
  hintHome: HTMLElement;
  pick(side: Side, mode: AppMode): void;
  dismiss(): void;
}

export interface StartScreen {
  el: HTMLElement;
  show(on: boolean): void;
}

function zoneText(hint: HTMLElement, side: Side): void {
  hint.dataset.dropSide = side;
  hint.dataset.dropMode = 'compare';
}

export function createStartScreen(host: StartHost): StartScreen {
  const browseZone = h('button', { type: 'button', class: 'start-zone', 'data-testid': 'start-drop-browse', 'data-drop-side': 'a', 'data-drop-mode': 'browse' },
    h('span', { class: 'start-zone-icon', 'aria-hidden': 'true' }, '⇩'),
    h('strong', {}, 'Drop a customization .zip or project.xml'),
    h('span', { class: 'muted' }, 'or click to choose a file'));
  browseZone.addEventListener('click', () => host.pick('a', 'browse'));

  const compareZones = h('div', { class: 'start-pair' });
  const saved: Partial<Record<Side, { parent: Node | null; next: Node | null; children: Node[] }>> = {};

  const btnPaste = h('button', { type: 'button', class: 'link', 'data-testid': 'start-dismiss' }, 'paste or type text instead');
  btnPaste.addEventListener('click', () => host.dismiss());

  const el = h('div', { class: 'start-screen', 'data-testid': 'start-screen', hidden: true },
    h('div', { class: 'start-cards' },
      h('section', { class: 'start-card', 'data-testid': 'start-browse', 'aria-labelledby': 'sd-start-browse' },
        h('h2', { id: 'sd-start-browse' }, 'Browse a package'),
        h('p', { class: 'muted' }, 'See everything in one customization: code, screens, tables, files and DLLs.'),
        browseZone),
      h('section', { class: 'start-card', 'data-testid': 'start-compare', 'aria-labelledby': 'sd-start-compare' },
        h('h2', { id: 'sd-start-compare' }, 'Compare two packages'),
        h('p', { class: 'muted' }, 'Spot what changed between two versions, item by item.'),
        compareZones)),
    h('p', { class: 'start-foot' }, h('span', { 'aria-hidden': 'true' }, '🔒 '), 'Files are read in your browser; nothing is uploaded. Drop files anywhere, or ', btnPaste, '.'));

  function moveIn(): void {
    for (const side of ['a', 'b'] as const) {
      const hint = host.hints[side];
      if (saved[side]) continue;
      saved[side] = { parent: hint.parentNode, next: hint.nextSibling, children: [...hint.childNodes] };
      zoneText(hint, side);
      hint.classList.add('start-zone', 'in-start');
      hint.setAttribute('role', 'button');
      hint.tabIndex = 0;
      hint.setAttribute('aria-label', `Choose package ${side.toUpperCase()}`);
      hint.replaceChildren(
        h('span', { class: 'start-side', 'aria-hidden': 'true' }, side.toUpperCase()),
        h('strong', {}, side === 'a' ? 'Older / original' : 'Newer / changed'),
        h('span', { class: 'muted' }, 'drop or click'));
      compareZones.append(hint);
    }
  }

  function moveOut(): void {
    for (const side of ['a', 'b'] as const) {
      const s = saved[side];
      if (!s) continue;
      const hint = host.hints[side];
      hint.classList.remove('start-zone', 'in-start');
      hint.removeAttribute('role');
      hint.removeAttribute('tabindex');
      hint.removeAttribute('aria-label');
      delete hint.dataset.dropSide;
      delete hint.dataset.dropMode;
      hint.replaceChildren(...s.children);
      host.hintHome.append(hint);
      delete saved[side];
    }
  }

  for (const side of ['a', 'b'] as const) {
    const hint = host.hints[side];
    hint.addEventListener('click', () => {
      if (hint.classList.contains('in-start')) host.pick(side, 'compare');
    });
    hint.addEventListener('keydown', (e) => {
      if (hint.classList.contains('in-start') && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        host.pick(side, 'compare');
      }
    });
  }

  return {
    el,
    show(on) {
      if (on === !el.hidden) return;
      el.hidden = !on;
      if (on) moveIn();
      else moveOut();
    },
  };
}
