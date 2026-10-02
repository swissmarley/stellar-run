import { nextUpgradeCost, upgradeLevel, upgradeUnlocked } from '../core/meta/economy.ts';
import { missionDef, missionText } from '../core/meta/missions.ts';
import type { LeaderEntry, Profile } from '../core/meta/profile.ts';
import { BIOMES } from '../data/biomes.ts';
import { COSMETICS } from '../data/cosmetics.ts';
import { SHIPS } from '../data/ships.ts';
import { UPGRADES } from '../data/upgrades.ts';
import type { KeyBindings } from '../game/input/input-router.ts';
import type { Settings } from '../services/settings.ts';
import { clear, h } from './dom.ts';

/** Callbacks from screens to the app controller. */
export interface MetaActions {
  back(): void;
  buyShip(id: string): void;
  selectShip(id: string): void;
  buyUpgrade(id: string): void;
  claimMission(id: string): void;
  buyCosmetic(id: string): void;
  equipCosmetic(id: string): void;
  leaderboard(which: 'local' | 'online'): Promise<readonly LeaderEntry[]>;
  changeSettings(mutator: (s: Settings) => void): void;
  requestTilt(): Promise<boolean>;
  calibrateTilt(): void;
  exportSave(): string;
  deleteData(): void;
  resetSettings(): void;
}

const fmt = (n: number): string => Math.floor(n).toLocaleString('en-US');
const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

function header(title: string, a: MetaActions, balance?: string): HTMLElement {
  return h(
    'header',
    { class: 'screen-head' },
    h(
      'button',
      { class: 'btn btn-ghost btn-back', type: 'button', 'aria-label': 'Back', onclick: () => a.back() },
      '‹ Back',
    ),
    h('h2', null, title),
    balance === undefined
      ? h('span')
      : h('span', { class: 'balance', 'aria-label': 'Shards' }, `◆ ${balance}`),
  );
}

function bar(label: string, v01: number): HTMLElement {
  const fill = h('i');
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, v01)) * 100)}%`;
  return h('div', { class: 'stat' }, h('span', null, label), h('div', { class: 'stat-bar' }, fill));
}

export function hangarScreen(p: Profile, a: MetaActions): HTMLElement {
  const maxLat = Math.max(...SHIPS.map((s) => s.lateralSpeed));
  const maxSf = Math.max(...SHIPS.map((s) => s.speedFactor));
  const maxR = Math.max(...SHIPS.map((s) => s.hitRadius));
  const cards = SHIPS.map((s) => {
    const owned = p.ownedShips.includes(s.id);
    const selected = p.selectedShip === s.id;
    const swatch = h('div', { class: 'ship-swatch' });
    swatch.style.background = `linear-gradient(135deg, ${hex(s.model.hull)}, ${hex(s.model.trim)})`;
    const action = selected
      ? h('button', { class: 'btn', type: 'button', disabled: true }, 'Selected')
      : owned
        ? h(
            'button',
            { class: 'btn btn-primary', type: 'button', onclick: () => a.selectShip(s.id) },
            'Fly this',
          )
        : h(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              disabled: p.shards < s.price,
              onclick: () => a.buyShip(s.id),
            },
            `Buy ◆ ${fmt(s.price)}`,
          );
    return h(
      'article',
      { class: `card ship-card${selected ? ' selected' : ''}` },
      h(
        'div',
        { class: 'card-top' },
        swatch,
        h('div', null, h('h3', null, s.name), h('p', { class: 'muted' }, s.tagline)),
      ),
      bar('Top speed', s.speedFactor / maxSf),
      bar('Handling', s.lateralSpeed / maxLat),
      bar('Slim hull', 1 - (s.hitRadius - 0.25) / (maxR - 0.15)),
      h('p', { class: 'ability' }, h('b', null, `✦ ${s.abilityName}: `), s.abilityDesc),
      action,
    );
  });
  return h(
    'section',
    { class: 'screen screen-meta', 'aria-label': 'Hangar' },
    header('Hangar', a, fmt(p.shards)),
    h('div', { class: 'list' }, ...cards),
  );
}

export function upgradesScreen(p: Profile, a: MetaActions): HTMLElement {
  const branches = ['propulsion', 'handling', 'salvage', 'systems'] as const;
  const groups = branches.map((b) =>
    h(
      'div',
      { class: 'branch' },
      h('h3', null, b[0]!.toUpperCase() + b.slice(1)),
      ...UPGRADES.filter((u) => u.branch === b).map((u) => {
        const lv = upgradeLevel(p, u.id);
        const cost = nextUpgradeCost(p, u.id);
        const unlocked = upgradeUnlocked(p, u.id);
        const pips = h(
          'div',
          { class: 'pips', 'aria-label': `Level ${lv} of ${u.costs.length}` },
          ...u.costs.map((_, i) => h('i', { class: i < lv ? 'on' : '' })),
        );
        const label =
          cost < 0
            ? 'Maxed'
            : !unlocked
              ? `Needs ${u.requires.map((r) => UPGRADES.find((x) => x.id === r)?.name).join(', ')}`
              : `◆ ${fmt(cost)}`;
        return h(
          'div',
          { class: 'card upgrade' },
          h('div', null, h('b', null, u.name), h('p', { class: 'muted' }, u.desc), pips),
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              disabled: cost < 0 || !unlocked || p.shards < cost,
              onclick: () => a.buyUpgrade(u.id),
            },
            label,
          ),
        );
      }),
    ),
  );
  return h(
    'section',
    { class: 'screen screen-meta', 'aria-label': 'Upgrades' },
    header('Upgrades', a, fmt(p.shards)),
    h('div', { class: 'list' }, ...groups),
  );
}

export function missionsScreen(p: Profile, a: MetaActions, msToReset: number): HTMLElement {
  const hrs = Math.floor(msToReset / 3_600_000);
  const mins = Math.floor((msToReset % 3_600_000) / 60_000);
  const items = p.missions.list.map((m) => {
    const d = missionDef(m.id);
    const done = m.progress >= m.target;
    const fill = h('i');
    fill.style.width = `${Math.round((Math.min(m.progress, m.target) / m.target) * 100)}%`;
    return h(
      'div',
      { class: `card mission${done ? ' done' : ''}` },
      h(
        'div',
        null,
        h('b', null, missionText(m)),
        h('div', { class: 'stat-bar' }, fill),
        h('p', { class: 'muted' }, `${fmt(Math.min(m.progress, m.target))} / ${fmt(m.target)}`),
      ),
      m.claimed
        ? h('span', { class: 'claimed' }, '✓ Claimed')
        : h(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              disabled: !done,
              onclick: () => a.claimMission(m.id),
            },
            `Claim ◆ ${d?.reward ?? 0}`,
          ),
    );
  });
  return h(
    'section',
    { class: 'screen screen-meta', 'aria-label': 'Daily missions' },
    header('Missions', a, fmt(p.shards)),
    h('p', { class: 'muted center' }, `New missions in ${hrs} h ${mins} min (UTC midnight)`),
    h('div', { class: 'list' }, ...items),
  );
}

export function leaderboardScreen(a: MetaActions): HTMLElement {
  const body = h('ol', { class: 'leaders' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const show = async (which: 'local' | 'online'): Promise<void> => {
    for (const b of tabs.querySelectorAll('button'))
      b.setAttribute('aria-selected', String(b.dataset.tab === which));
    const rows = await a.leaderboard(which);
    clear(body);
    if (rows.length === 0) body.append(h('li', { class: 'muted' }, 'No runs yet. Go set a record!'));
    for (const r of rows) {
      const ship = SHIPS.find((s) => s.id === r.ship)?.name ?? r.ship;
      body.append(
        h(
          'li',
          null,
          h('b', null, fmt(r.score)),
          h('span', null, `${fmt(r.distance)} m · ${ship}`),
          h('small', null, r.date),
        ),
      );
    }
  };
  for (const [id, label] of [
    ['local', 'This device'],
    ['online', 'Global (offline demo)'],
  ] as const) {
    const b = h(
      'button',
      { class: 'btn tab', type: 'button', role: 'tab', onclick: () => void show(id) },
      label,
    );
    b.dataset.tab = id;
    tabs.append(b);
  }
  void show('local');
  return h(
    'section',
    { class: 'screen screen-meta', 'aria-label': 'Leaderboard' },
    header('Leaderboard', a),
    tabs,
    body,
    h(
      'p',
      { class: 'muted small' },
      'The global board is a local mock: STELLAR RUN never sends your scores anywhere.',
    ),
  );
}

export function shopScreen(p: Profile, a: MetaActions): HTMLElement {
  const item = (id: string): HTMLElement => {
    const c = COSMETICS.find((x) => x.id === id)!;
    const owned = p.ownedCosmetics.includes(c.id);
    const equipped = p.paint === c.id || p.trail === c.id;
    const sw = h('div', { class: 'swatch' });
    sw.style.background = c.colors.length ? hex(c.colors[0]!) : 'linear-gradient(90deg,#56b4e9,#e69f00)';
    return h(
      'div',
      { class: 'card cosmetic' },
      sw,
      h('b', null, c.name),
      equipped
        ? h('button', { class: 'btn', type: 'button', disabled: true }, 'Equipped')
        : owned
          ? h('button', { class: 'btn', type: 'button', onclick: () => a.equipCosmetic(c.id) }, 'Equip')
          : h(
              'button',
              {
                class: 'btn btn-primary',
                type: 'button',
                disabled: p.shards < c.price,
                onclick: () => a.buyCosmetic(c.id),
              },
              `◆ ${fmt(c.price)}`,
            ),
    );
  };
  return h(
    'section',
    { class: 'screen screen-meta', 'aria-label': 'Cosmetics' },
    header('Paint shop', a, fmt(p.shards)),
    h(
      'p',
      { class: 'muted small center' },
      'Cosmetic only. Everything is earned by flying; nothing is sold for money.',
    ),
    h('h3', null, 'Hull paint'),
    h('div', { class: 'grid' }, ...COSMETICS.filter((c) => c.kind === 'paint').map((c) => item(c.id))),
    h('h3', null, 'Engine trail'),
    h('div', { class: 'grid' }, ...COSMETICS.filter((c) => c.kind === 'trail').map((c) => item(c.id))),
  );
}

type Opt<T extends string> = readonly (readonly [T, string])[];

function segmented<T extends string>(
  label: string,
  value: T,
  options: Opt<T>,
  onChange: (v: T) => void,
): HTMLElement {
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  for (const [v, text] of options) {
    group.append(
      h(
        'button',
        {
          class: `seg${v === value ? ' on' : ''}`,
          type: 'button',
          role: 'radio',
          'aria-checked': String(v === value),
          onclick: () => onChange(v),
        },
        text,
      ),
    );
  }
  return h('div', { class: 'setting' }, h('span', null, label), group);
}

function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  fmtV = (v: number) => `${Math.round(v * 100)}%`,
): HTMLElement {
  const out = h('output', null, fmtV(value));
  const input = h('input', {
    type: 'range',
    min,
    max,
    step,
    value: String(value),
    'aria-label': label,
  }) as HTMLInputElement;
  input.addEventListener('input', () => {
    out.textContent = fmtV(Number(input.value));
  });
  input.addEventListener('change', () => onChange(Number(input.value)));
  return h('label', { class: 'setting' }, h('span', null, label), h('div', { class: 'slider' }, input, out));
}

function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  return h(
    'div',
    { class: 'setting' },
    h('span', null, label),
    h(
      'button',
      {
        class: `toggle${value ? ' on' : ''}`,
        type: 'button',
        role: 'switch',
        'aria-checked': String(value),
        'aria-label': label,
        onclick: () => onChange(!value),
      },
      value ? 'On' : 'Off',
    ),
  );
}

const KEY_LABELS: Record<keyof KeyBindings, string> = {
  left: 'Steer left',
  right: 'Steer right',
  up: 'Steer up',
  down: 'Steer down',
  boost: 'Boost',
  focus: 'Focus (hold)',
  ability: 'Ability',
  pause: 'Pause',
};

function keyName(code: string): string {
  return code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace('Arrow', '')
    .replace('Left', ' L')
    .replace('Right', ' R');
}

export function settingsScreen(
  s: Settings,
  a: MetaActions,
  info: { persistent: boolean; hapticsAvailable: boolean; version: string },
): HTMLElement {
  const set = (fn: (x: Settings) => void) => a.changeSettings(fn);
  const keyRows = (Object.keys(KEY_LABELS) as (keyof KeyBindings)[]).map((k) => {
    const btn = h(
      'button',
      { class: 'btn key', type: 'button', 'aria-label': `Rebind ${KEY_LABELS[k]}` },
      s.controls.keys[k].map(keyName).join(' / '),
    );
    btn.addEventListener('click', () => {
      btn.textContent = 'Press a key…';
      const capture = (e: KeyboardEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('keydown', capture, true);
        if (e.code === 'Escape' && k !== 'pause') {
          btn.textContent = s.controls.keys[k].map(keyName).join(' / ');
          return;
        }
        set((x) => {
          x.controls.keys[k] = [e.code];
        });
      };
      window.addEventListener('keydown', capture, true);
    });
    return h('div', { class: 'setting' }, h('span', null, KEY_LABELS[k]), btn);
  });

  const steering = segmented(
    'Steering',
    s.controls.steering,
    [
      ['drag', 'Drag'],
      ['tilt', 'Tilt'],
    ],
    async (v) => {
      if (v === 'tilt' && !(await a.requestTilt())) return;
      set((x) => {
        x.controls.steering = v;
      });
    },
  );

  return h(
    'section',
    { class: 'screen screen-meta screen-settings', 'aria-label': 'Settings' },
    header('Settings', a),
    h(
      'div',
      { class: 'list' },
      h('h3', null, 'Controls'),
      steering,
      s.controls.steering === 'drag'
        ? slider(
            'Drag sensitivity',
            s.controls.dragSensitivity,
            0.4,
            2.5,
            0.05,
            (v) =>
              set((x) => {
                x.controls.dragSensitivity = v;
              }),
            (v) => `${v.toFixed(2)}×`,
          )
        : h(
            'div',
            null,
            slider(
              'Tilt sensitivity',
              s.controls.tiltSensitivity,
              0.4,
              2.5,
              0.05,
              (v) =>
                set((x) => {
                  x.controls.tiltSensitivity = v;
                }),
              (v) => `${v.toFixed(2)}×`,
            ),
            h(
              'div',
              { class: 'setting' },
              h('span', null, 'Neutral position'),
              h('button', { class: 'btn', type: 'button', onclick: () => a.calibrateTilt() }, 'Recalibrate'),
            ),
          ),
      toggle('Invert vertical', s.controls.invertY, (v) =>
        set((x) => {
          x.controls.invertY = v;
        }),
      ),
      toggle('Left-handed layout', s.controls.leftHanded, (v) =>
        set((x) => {
          x.controls.leftHanded = v;
        }),
      ),
      segmented(
        'Tap does',
        s.controls.tapAction,
        [
          ['boost', 'Boost'],
          ['ability', 'Ability'],
          ['none', 'Nothing'],
        ],
        (v) =>
          set((x) => {
            x.controls.tapAction = v;
          }),
      ),
      segmented(
        'Press & hold does',
        s.controls.holdAction,
        [
          ['focus', 'Focus'],
          ['none', 'Nothing'],
        ],
        (v) =>
          set((x) => {
            x.controls.holdAction = v;
          }),
      ),
      h('details', { class: 'keys' }, h('summary', null, 'Keyboard bindings'), ...keyRows),

      h('h3', null, 'Sound'),
      slider('Master volume', s.audio.master, 0, 1, 0.05, (v) =>
        set((x) => {
          x.audio.master = v;
        }),
      ),
      slider('Music', s.audio.music, 0, 1, 0.05, (v) =>
        set((x) => {
          x.audio.music = v;
        }),
      ),
      slider('Effects', s.audio.sfx, 0, 1, 0.05, (v) =>
        set((x) => {
          x.audio.sfx = v;
        }),
      ),
      toggle('Mute', s.audio.muted, (v) =>
        set((x) => {
          x.audio.muted = v;
        }),
      ),
      segmented(
        'Haptics',
        s.haptics,
        [
          ['off', 'Off'],
          ['low', 'Low'],
          ['full', 'Full'],
        ],
        (v) =>
          set((x) => {
            x.haptics = v;
          }),
      ),
      info.hapticsAvailable
        ? null
        : h(
            'p',
            { class: 'muted small' },
            'This browser has no vibration API (e.g. iOS Safari), so haptics are unavailable.',
          ),

      h('h3', null, 'Graphics'),
      segmented(
        'Quality',
        s.graphics.quality,
        [
          ['auto', 'Auto'],
          ['low', 'Low'],
          ['medium', 'Med'],
          ['high', 'High'],
        ],
        (v) =>
          set((x) => {
            x.graphics.quality = v;
          }),
      ),
      toggle('Battery saver (30 fps)', s.graphics.fps30, (v) =>
        set((x) => {
          x.graphics.fps30 = v;
        }),
      ),
      toggle('Show FPS', s.graphics.showFps, (v) =>
        set((x) => {
          x.graphics.showFps = v;
        }),
      ),

      h('h3', null, 'Accessibility'),
      segmented(
        'Reduced motion',
        s.a11y.reducedMotion,
        [
          ['auto', 'System'],
          ['on', 'On'],
          ['off', 'Off'],
        ],
        (v) =>
          set((x) => {
            x.a11y.reducedMotion = v;
          }),
      ),
      segmented(
        'Colours',
        s.a11y.palette,
        [
          ['standard', 'Colour-blind safe'],
          ['highContrast', 'High contrast'],
        ],
        (v) =>
          set((x) => {
            x.a11y.palette = v;
          }),
      ),
      slider('Text size', s.a11y.textScale, 1, 1.5, 0.05, (v) =>
        set((x) => {
          x.a11y.textScale = v;
        }),
      ),
      slider('Screen shake', s.a11y.shake, 0, 1, 0.1, (v) =>
        set((x) => {
          x.a11y.shake = v;
        }),
      ),
      toggle('Screen flashes', s.a11y.flashes, (v) =>
        set((x) => {
          x.a11y.flashes = v;
        }),
      ),
      toggle('Score pop-ups', s.a11y.popups, (v) =>
        set((x) => {
          x.a11y.popups = v;
        }),
      ),

      h('h3', null, 'Privacy & data'),
      h(
        'p',
        { class: 'muted small' },
        'STELLAR RUN collects nothing: no analytics, no ads, no tracking, no accounts. Your progress is stored only in this browser.',
        info.persistent
          ? ''
          : ' Storage is unavailable here (private mode?), so progress will be lost when you close the tab.',
      ),
      h(
        'div',
        { class: 'setting' },
        h('span', null, 'Your save'),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              const ta = h('textarea', {
                class: 'export',
                readonly: true,
                'aria-label': 'Save data',
              }) as HTMLTextAreaElement;
              ta.value = a.exportSave();
              document.querySelector('.screen-settings .list')?.append(ta);
              ta.select();
            },
          },
          'Export',
        ),
      ),
      h(
        'div',
        { class: 'setting' },
        h('span', null, 'Delete all data'),
        h(
          'button',
          {
            class: 'btn btn-danger',
            type: 'button',
            onclick: (e: Event) => {
              const b = e.currentTarget as HTMLButtonElement;
              if (b.dataset.armed === '1') a.deleteData();
              else {
                b.dataset.armed = '1';
                b.textContent = 'Tap again to delete';
              }
            },
          },
          'Delete…',
        ),
      ),
      h(
        'div',
        { class: 'setting' },
        h('span', null, 'Settings'),
        h('button', { class: 'btn', type: 'button', onclick: () => a.resetSettings() }, 'Reset to defaults'),
      ),

      h('h3', null, 'About'),
      h(
        'p',
        { class: 'muted small' },
        `STELLAR RUN ${info.version}. Open source under the MIT licence; generated art and audio are CC0. Built with three.js (MIT). Biomes: ${BIOMES.map((b) => b.name).join(', ')}.`,
      ),
      h(
        'a',
        {
          class: 'link',
          href: 'https://github.com/swissmarley/stellar-run',
          target: '_blank',
          rel: 'noopener',
        },
        'Source code on GitHub',
      ),
    ),
  );
}

export function noticeScreen(onOk: () => void): HTMLElement {
  return h(
    'section',
    { class: 'screen screen-notice', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Privacy notice' },
    h('h2', null, 'Welcome, pilot'),
    h(
      'div',
      { class: 'card' },
      h('p', null, 'STELLAR RUN is free and open source.'),
      h(
        'ul',
        null,
        h('li', null, 'No ads, no tracking, no analytics.'),
        h('li', null, 'No accounts. Progress stays on this device.'),
        h('li', null, 'Nothing is ever sold for real money.'),
      ),
      h(
        'p',
        { class: 'muted small' },
        'You can export or delete your data any time in Settings → Privacy & data.',
      ),
    ),
    h(
      'div',
      { class: 'stack bottom' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: onOk }, "Let's fly"),
    ),
  );
}
