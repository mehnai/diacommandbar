import { validCustomUrl } from './core.js';

const sections = [
  ['appearance', 'Appearance', 'How the bar looks.'],
  ['bar', 'Command bar', 'What shows up inside the bar.'],
  ['newtab', 'New tab', 'The page you see when you open a tab.'],
  ['search', 'Search', 'Where your searches go.'],
  ['sources', 'Sources', 'What the bar can look through.'],
  ['overlay', 'Overlay', 'The bar on top of websites.'],
  ['shortcuts', 'Shortcuts', 'Keys that get you around faster.'],
];
const choice = (key, label, options, desc = '') => ({ key, label, options, desc });
const toggle = (key, label, desc) => choice(key, label, [[true, 'On'], [false, 'Off']], desc);
const stepper = (key, label, min, max, step, format) => ({ key, label, min, max, step, format });
const el = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function createSettingsUI({ dialog, onChange, onReset, onShortcut, clearStatus, modifier }) {
  const nav = dialog.querySelector('.settings-nav-items');
  const rows = dialog.querySelector('#settings-rows');
  let section = 'appearance', current, structure = '', controls = [], resetting = false;
  const pending = new Set();
  for (const [key, title] of sections) {
    const button = el('button', '', title);
    button.dataset.section = key;
    button.addEventListener('click', () => { section = key; clearStatus(); update(current); });
    nav.append(button);
  }
  const reset = dialog.querySelector('#restore-defaults');
  reset.addEventListener('click', async () => {
    if (resetting || pending.size) return;
    resetting = true; sync();
    try { await onReset(); } finally { resetting = false; sync(); }
  });

  function model(state) {
    const s = state.settings;
    return {
      appearance: [
        choice('theme', 'Theme', [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']]),
        choice('accent', 'Accent color', [['mono', 'None'], ['blue', 'Blue', 255], ['green', 'Green', 150], ['orange', 'Orange', 55], ['red', 'Red', 25]], 'Colors the cursor, switches, and highlighted result. Pick None to keep it black and white.'),
        choice('font', 'Font', [['dia', 'Dia'], ['serif', 'Serif'], ['mono', 'Mono']], 'Changes the bar and settings. The clock keeps its display font.'),
        choice('density', 'Spacing', [['compact', 'Compact'], ['default', 'Comfortable'], ['roomy', 'Spacious']]),
        stepper('radius', 'Roundness', 0, 24, 2, v => v === 0 ? 'Square' : `${v}px`),
        stepper('width', 'Bar width', 520, 820, 20, v => `${v}px`),
        choice('contrast', 'Contrast', [['standard', 'Normal'], ['high', 'Higher']], 'Higher makes text darker and borders clearer.'),
      ],
      bar: [
        choice('selection', 'Highlight', [['solid', 'Inverted'], ['soft', 'Soft']], 'How the selected result stands out.'),
        toggle('chips', 'Show filter buttons', 'You can always type @ for tabs, * for bookmarks, # for history, or > for actions.'),
        toggle('icons', 'Show icons'),
        toggle('kinds', 'Label each result', 'Shows “Switch to tab”, “Bookmark”, and so on.'),
        toggle('numbers', 'Show number shortcuts', `Press ${modifier}1 through ${modifier}9 to jump straight to a result.`),
        toggle('hints', 'Show keyboard hints'),
      ],
      newtab: [
        toggle('newTabPage', 'Use a separate command page', 'Off keeps your browser’s own new-tab page. The extension button and shortcut still work; the Overlay setting can still open the bar over websites.'),
        toggle('clock', 'Show date and time'),
        choice('hour12', 'Time format', [[true, '3:30 PM'], [false, '15:30']]),
        choice('position', 'Bar position', [['center', 'Middle'], ['top', 'Higher up']]),
        choice('background', 'Background', [['solid', 'Plain'], ['dots', 'Dot grid']]),
      ],
      search: [
        choice('engine', 'Search with', [['default', 'Browser default'], ['google', 'Google'], ['duckduckgo', 'DuckDuckGo'], ['bing', 'Bing'], ['brave', 'Brave'], ['custom', 'Something else…']]),
        ...(s.engine === 'custom' ? [{ key: 'customUrl', label: 'Search address', text: true, desc: 'Paste an HTTPS search link and put %s where your words should go.' }] : []),
        toggle('autocomplete', 'Suggest searches as I type', state.incognito ? 'Query autocomplete is paused in private browsing.' : 'Suggestions come from Google, so what you type is sent there. Your searches still go to the engine above.'),
        stepper('maxResults', 'How many results', 3, 10, 1, v => `${v} results`),
        choice('openIn', 'Open results in', [['auto', 'Automatic'], ['replace', 'This tab'], ['new', 'A new tab']], `Automatic uses a new tab from an overlay and the current tab from the separate page. Hold ${modifier} when you press Enter to always use a new tab.`),
      ],
      sources: [
        choice('defaultScope', 'Start by searching', [['all', 'Everything'], ['tabs', 'Open tabs'], ['bookmarks', 'Bookmarks'], ['history', 'History'], ['actions', 'Actions']]),
        toggle('allWindows', 'Include tabs from other windows'),
        toggle('bookmarks', 'Search my bookmarks', 'Your browser will ask for permission first.'),
        toggle('history', 'Search my history', 'Your browser will ask for permission first.'),
        ...(state.permissions.history ? [choice('historyDays', 'Look back', [[7, 'A week'], [30, 'A month'], [90, '3 months']])] : []),
        { label: 'Tab, bookmark, and history matches stay on your device.', note: true },
      ],
      overlay: [
        toggle('newTabOverlay', 'Open new tabs as an overlay', `${modifier}T shows the bar on top of the page you were on instead of a blank page. Needs permission to draw on websites.`),
        toggle('outsideDismiss', 'Close when I click outside'),
        toggle('rememberPos', 'Remember where I moved it', 'Otherwise it opens in the center each time.'),
      ],
      shortcuts: [
        { label: 'Open the command bar', keys: state.shortcut || 'Not assigned' },
        { label: 'Open settings', keys: `${modifier} ,` },
        { label: 'Open in a new tab', keys: `${modifier} ↵` },
        { label: 'Jump to a result', keys: `${modifier} 1–9` },
        { label: 'Clear, then close', keys: 'esc' },
        { label: 'Search tabs, bookmarks, history, actions', keys: '@ * # >' },
        { label: 'Change the shortcut', button: 'Change…', desc: 'Opens your browser’s shortcut settings.' },
      ],
    }[section];
  }

  function effective(key) {
    if (['bookmarks', 'history'].includes(key)) return !!current.permissions[key];
    if (['autocomplete', 'newTabOverlay'].includes(key)) return current.settings[key] && !!current.permissions[key];
    return current.settings[key];
  }

  async function change(key, value) {
    if (resetting || pending.has(key)) return;
    pending.add(key); sync();
    // Invoke immediately to keep optional permission requests in the gesture.
    try { await onChange(key, value); }
    finally { pending.delete(key); sync(); }
  }

  function sync() {
    reset.disabled = resetting || pending.size > 0;
    for (const c of controls) {
      const value = effective(c.row.key);
      const disabled = resetting || pending.has(c.row.key) || (c.row.key === 'autocomplete' && current.incognito);
      if (c.options) for (const [button, v] of c.options) {
        button.setAttribute('aria-pressed', String(value === v));
        button.disabled = !!disabled;
      }
      if (c.output) {
        c.output.textContent = c.row.format(value);
        c.less.disabled = disabled || value <= c.row.min;
        c.more.disabled = disabled || value >= c.row.max;
      }
      if (c.input) {
        c.input.disabled = !!disabled;
        if (document.activeElement !== c.input) c.input.value = value;
      }
    }
  }

  function update(state) {
    current = state;
    const key = `${section}:${state.settings.engine === 'custom'}:${state.permissions.history}:${state.incognito}:${state.shortcut}`;
    if (structure !== key) {
      structure = key;
      const [, title, intro] = sections.find(([id]) => id === section);
      dialog.querySelector('#settings-title').textContent = title;
      dialog.querySelector('#settings-intro').textContent = intro;
      for (const button of nav.children) {
        button.setAttribute('aria-current', button.dataset.section === section ? 'page' : 'false');
      }
      rows.replaceChildren(); controls = [];
      for (const row of model(state)) {
        const wrapper = el('div', `setting${row.note ? ' settings-note' : ''}`);
        const copy = el('div', 'setting-copy');
        const label = el('div', 'setting-label', row.label);
        label.id = `label-${row.key || rows.children.length}`;
        copy.append(label);
        if (row.desc) {
          const desc = el('p', 'setting-description', row.desc); desc.id = `description-${row.key}`; copy.append(desc);
        }
        wrapper.append(copy);
        const control = { row };
        if (row.options || row.format) {
          const group = el('div', row.options ? 'choices' : 'stepper');
          group.setAttribute('role', 'group'); group.setAttribute('aria-labelledby', label.id);
          if (row.desc) group.setAttribute('aria-describedby', `description-${row.key}`);
          if (row.options) {
            control.options = row.options.map(([value, text, hue]) => {
              const button = el('button', 'text-choice', text);
              button.dataset.setting = row.key;
              button.dataset.value = String(value);
              if (hue !== undefined) {
                const dot = el('span', 'accent-dot'); dot.style.background = `oklch(0.6 0.15 ${hue})`; button.prepend(dot);
              }
              button.addEventListener('click', () => { if (effective(row.key) !== value) change(row.key, value); });
              group.append(button); return [button, value];
            });
          } else {
            const less = el('button', '', '−'), more = el('button', '', '+'), output = el('output');
            less.setAttribute('aria-label', `Decrease ${row.label.toLowerCase()}`);
            more.setAttribute('aria-label', `Increase ${row.label.toLowerCase()}`);
            output.setAttribute('aria-live', 'polite');
            less.addEventListener('click', () => change(row.key, Math.max(row.min, effective(row.key) - row.step)));
            more.addEventListener('click', () => change(row.key, Math.min(row.max, effective(row.key) + row.step)));
            group.append(less, output, more); Object.assign(control, { less, more, output });
          }
          wrapper.append(group);
        } else if (row.text) {
          const input = el('input', 'search-address');
          input.id = 'custom-url'; input.setAttribute('aria-labelledby', label.id); input.setAttribute('aria-describedby', `description-${row.key}`);
          input.placeholder = 'https://example.com/search?q=%s'; input.spellcheck = false; input.autocomplete = 'off';
          input.addEventListener('input', () => { input.setCustomValidity(''); input.removeAttribute('aria-invalid'); });
          const commit = () => {
            const value = input.value.trim();
            const valid = validCustomUrl(value);
            input.setCustomValidity(valid ? '' : 'Use an HTTPS search address containing %s, without a username or password.');
            input.setAttribute('aria-invalid', String(!valid));
            if (valid) change(row.key, value); else input.reportValidity();
          };
          input.addEventListener('change', commit);
          input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); commit(); } });
          wrapper.append(input); control.input = input;
        } else if (row.keys) wrapper.append(el('span', 'shortcut-keys', row.keys));
        else if (row.button) {
          const button = el('button', 'text-link', row.button); button.id = 'configure-shortcut';
          button.addEventListener('click', onShortcut); wrapper.append(button);
        }
        controls.push(control); rows.append(wrapper);
      }
      dialog.querySelector('.settings-content').scrollTop = 0;
    }
    sync();
  }
  return { update };
}
