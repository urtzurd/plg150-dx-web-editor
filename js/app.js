// PLG150-DX editor: UI wiring, state, librarian and performance controls.
(function () {
  'use strict';

  const { OP, G, A } = DX;
  const $ = id => document.getElementById(id);
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ---------------------------------------------------------------- storage
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('plg150dx.' + key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('plg150dx.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
    remove(key) { try { localStorage.removeItem('plg150dx.' + key); } catch { /* ignore */ } },
  };

  // ---------------------------------------------------------------- state
  const ROM_NAMES = Object.keys(window.ROM_BANKS);
  // Region of each DX7 factory set, per yamahablackboxes.com (DX7 patches page):
  // "ROM1A Master (EU/JP)" heads ROM1A-2B, "ROM3A Master (US)" heads ROM3A-4B.
  // Only shown in names; the internal keys stay ROM1A.. so saved edits still load.
  const ROM_REGION = {
    ROM1A: 'EU/JP', ROM1B: 'EU/JP', ROM2A: 'EU/JP', ROM2B: 'EU/JP',
    ROM3A: 'US', ROM3B: 'US', ROM4A: 'US', ROM4B: 'US',
  };
  const cartLabel = n => (state.carts[n]?.rom && ROM_REGION[n] ? `${n} ${ROM_REGION[n]}` : n);

  function romVoices(name) {
    return DX.parseSyxFile(DX.base64ToBytes(window.ROM_BANKS[name])).voices;
  }

  const NATIVE_DEFAULTS = {
    0x00: 0, 0x01: 0, 0x05: 64,
    0x0B: 64, 0x0C: 64, 0x0D: 64, 0x0E: 64, 0x0F: 64, 0x10: 64,
    0x13: 64, 0x14: 64, 0x15: 64, 0x16: 64, 0x17: 64, 0x18: 64,
    0x1B: 64, 0x1C: 1, 0x1D: 0, 0x1E: 0, 0x20: 1,
  };

  const settings = Object.assign({
    out: '', device: 0, channel: 0, part: 0,
    liveSend: true, autoSend: true, sendAmem: true, bulkBlock: 0,
    velocity: 100, octave: 0, cart: 'ROM1A', perfHidden: false, opLayout: 'algorithm', uiScaling: 'fixed',
  }, store.get('settings', {}));

  const state = {
    carts: {},           // name -> { voices, rom: bool, modified: bool }
    cartName: null,
    index: 0,
    edit: DX.newVoice(),
    original: DX.newVoice(),
    edited: false,
    comparing: false,
    storeMode: false,
    clipboard: null,
    native: Object.assign({}, NATIVE_DEFAULTS, store.get('nativePart', {})),
    nativeSys: Object.assign({ 0x08: 1 }, store.get('nativeSys', {})),
  };

  function loadCarts() {
    for (const n of ROM_NAMES) state.carts[n] = { voices: romVoices(n), rom: true, modified: false };
    const saved = store.get('carts', {});
    for (const n in saved) {
      if (Array.isArray(saved[n]) && saved[n].length === 32) {
        state.carts[n] = { voices: saved[n], rom: ROM_NAMES.includes(n), modified: true };
      }
    }
  }
  function persistCarts() {
    const out = {};
    for (const n in state.carts) if (state.carts[n].modified) out[n] = state.carts[n].voices;
    store.set('carts', out);
  }
  const saveSettings = () => store.set('settings', settings);
  const cart = () => state.carts[state.cartName];

  // ---------------------------------------------------------------- MIDI
  const midi = new Midi();
  const hex = bytes => Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

  // Logs outgoing messages (the PLG150-DX never transmits, so there is no MIDI In).
  function log(bytes, label) {
    const isPerf = bytes[0] < 0xF0;
    if (isPerf && !$('logNotes').checked) return;
    const el = $('log');
    const shown = bytes.length > 48 ? hex(bytes.slice(0, 24)) + ` … (${bytes.length} bytes) … ` + hex(bytes.slice(-3)) : hex(bytes);
    el.textContent += `${new Date().toLocaleTimeString()} ${label ? '[' + label + '] ' : ''}${shown}\n`;
    if (el.textContent.length > 60000) el.textContent = el.textContent.slice(-40000);
    el.scrollTop = el.scrollHeight;
  }
  midi.onSend = (b, label) => log(b, label);

  function requireOutput() {
    if (midi.output) return true;
    toast('No MIDI output selected. Click "Enable MIDI" and choose the port.', true);
    return false;
  }

  function fillPortSelect(sel, ports, current, noneLabel) {
    sel.innerHTML = '';
    sel.appendChild(new Option(noneLabel, ''));
    for (const p of ports) sel.appendChild(new Option(p.name, p.id));
    const match = ports.find(p => p.id === current) || ports.find(p => p.name === current);
    sel.value = match ? match.id : '';
  }

  function refreshPorts() {
    fillPortSelect($('midiOut'), midi.outputs(), settings.out, '— none —');
    midi.selectOutput($('midiOut').value);
    const st = $('midiStatus');
    st.textContent = midi.output ? 'Out: ' + midi.output.name : 'No output';
    st.className = 'status ' + (midi.output ? 'ok' : 'err');
  }

  async function enableMidi() {
    if (!midi.supported) {
      $('midiStatus').textContent = 'Web MIDI not supported (use Chrome or Edge)';
      $('midiStatus').className = 'status err';
      return;
    }
    try {
      await midi.init();
      midi.onStateChange = refreshPorts;
      refreshPorts();
      $('midiConnect').textContent = 'Rescan';
    } catch (e) {
      $('midiStatus').textContent = 'MIDI access denied (SysEx permission needed)';
      $('midiStatus').className = 'status err';
    }
  }

  // Live parameter changes are coalesced so dragging a value sends at most
  // one message per parameter every 20 ms.
  const pending = new Map();
  let flushTimer = null;
  // Native (part/system) settings are always sent; voice edits follow "Live edit".
  function queueSend(key, bytes, label, always) {
    if (!midi.output) return;
    if (!always && (!settings.liveSend || state.comparing)) return;
    pending.set(key, [bytes, label]);
    if (!flushTimer) flushTimer = setTimeout(flushPending, 20);
  }
  function flushPending() {
    flushTimer = null;
    for (const [bytes, label] of pending.values()) midi.send(bytes, label);
    pending.clear();
  }

  function voiceMessages(v) {
    const dev = settings.device;
    // DX7II order: additional (ACED) first, then the voice (VCED).
    const list = [
      [Sysex.acedBulk(dev, v.aced), 'ACED bulk'],
      [Sysex.vcedBulk(dev, v.vced), 'VCED bulk'],
    ];
    // Operator on/off isn't part of the VCED bulk; send it every time so the card
    // never keeps an operator switched off from a previous voice (e.g. Compare).
    list.push([Sysex.vcedParam(dev, G.OPE, v.vced[G.OPE]), 'OP enable']);
    return list;
  }

  async function sendVoice(v = state.edit) {
    if (!requireOutput()) return;
    await midi.sendSequence(voiceMessages(v), 40);
  }

  async function sendBank() {
    if (!requireOutput()) return;
    const dev = settings.device;
    const voices = cart().voices;
    const block = settings.bulkBlock;
    const list = [[Sysex.nativeSystem(dev, 0x0E, block), '32 bulk receive block']];
    if (settings.sendAmem) list.push([Sysex.amemBulk(dev, voices), 'AMEM bulk']);
    list.push([Sysex.vmemBulk(dev, voices), 'VMEM bulk']);
    $('sendBank').disabled = true;
    await midi.sendSequence(list, 150);
    $('sendBank').disabled = false;
    toast(`Sent "${cartLabel(state.cartName)}" to PLG user voices ${block ? '33–64' : '1–32'}`);
  }

  // ---------------------------------------------------------------- toast
  let toastTimer;
  function toast(msg, err) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  // ---------------------------------------------------------------- fields
  // A field is bound to one byte of the edit buffer (vced/aced) or of the
  // native parameter set. Descriptor:
  //   { label, src: 'vced'|'aced'|'native'|'nativeSys', idx, max, min=0,
  //     options: [labels] | fn(i)->label, offset: shown = raw - offset, title, wide }
  const bound = [];

  // The voice on screen: the original while comparing, otherwise the edit buffer.
  const shownVoice = () => (state.comparing ? state.original : state.edit);

  function getRaw(d) {
    if (d.src === 'native') return state.native[d.idx];
    if (d.src === 'nativeSys') return state.nativeSys[d.idx];
    return shownVoice()[d.src][d.idx];
  }

  function makeField(parent, d) {
    // a <div>, not a <label>: a drag released over the caption must not focus the box
    const wrap = h('div', 'field' + (d.wide ? ' wide' : ''));
    const lab = h('span', null, d.label);
    if (d.title) wrap.title = d.title;
    wrap.appendChild(lab);
    const min = d.min || 0;
    let input;
    if (d.options) {
      input = h('select');
      for (let i = min; i <= d.max; i++) {
        const text = typeof d.options === 'function' ? d.options(i) : d.options[i - min];
        input.appendChild(new Option(text, i));
      }
      input.addEventListener('change', () => commit(d, +input.value));
    } else {
      input = h('input');
      input.type = 'number';
      wrap.classList.add('num');
      const off = d.offset || 0;
      input.min = min - off; input.max = d.max - off; input.step = 1;
      input.addEventListener('input', () => {
        if (input.value === '' || isNaN(+input.value)) return;
        const raw = Math.max(min, Math.min(d.max, Math.round(+input.value) + off));
        commit(d, raw);
      });
      input.addEventListener('change', () => refreshField({ d, input }));
      input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
      // The box ignores the mouse (CSS pointer-events) until it is in typing
      // mode, so a press can never focus it or select its text by itself;
      // presses land on this wrapper and are handled by attachDrag.
      const box = h('div', 'numbox');
      box.appendChild(input);
      input.addEventListener('focus', () => box.classList.add('editing'));
      input.addEventListener('blur', () => box.classList.remove('editing'));
      // operator panels are too tight for the +/- buttons
      if (!parent.closest('.op-sections')) {
        // our own +/- buttons (the native spinners can't be used without
        // letting the box take mouse input)
        box.classList.add('spin');
        for (const [cls, step, text] of [['spin-up', 1, '▲'], ['spin-down', -1, '▼']]) {
          const btn = h('button', 'spin-btn ' + cls, text);
          btn.type = 'button';
          btn.tabIndex = -1;
          btn.addEventListener('click', () => {
            if (input.disabled) return;
            const raw = Math.max(min, Math.min(d.max, getRaw(d) + step));
            if (raw !== getRaw(d)) { commit(d, raw); refreshField({ d, input }); }
          });
          box.appendChild(btn);
        }
      }
      attachDrag(box, d, input, true);
      attachDrag(lab, d, input, false);
      wrap.appendChild(box);
    }
    if (d.options) wrap.appendChild(input);
    parent.appendChild(wrap);
    const b = { d, input, wrap };
    bound.push(b);
    refreshField(b);
    return b;
  }

  // Vertical drag editing. The full range is covered in about 300 px of travel
  // (2–12 px per step); hold Shift for single steps every 12 px.
  // Not typing: any vertical movement drags; only a press and release with no
  // vertical movement switches the box to typing mode.
  // Typing: a click places the caret; moving more than 3 px leaves typing mode
  // and drags.
  let dragSession = null;   // only one drag at a time; ended on release/cancel/blur

  function attachDrag(target, d, input, clickToEdit) {
    const min = d.min || 0;
    target.addEventListener('pointerdown', e => {
      if (e.button !== 0 || input.disabled || e.target.closest('.spin-btn')) return;
      if (dragSession) dragSession.end(false);
      const editing = document.activeElement === input;
      if (!editing) {
        e.preventDefault();
        // leave typing mode in whatever box had it
        const a = document.activeElement;
        if (a && a.tagName === 'INPUT') a.blur();
      }
      const startY = e.clientY, start = getRaw(d);
      const px = Math.max(2, Math.min(12, 300 / (d.max - min + 1)));
      const threshold = editing ? 3 : 1;
      let moved = false;

      const move = ev => {
        if (ev.pointerId !== e.pointerId) return;
        const dy = startY - ev.clientY;
        if (!moved) {
          if (Math.abs(dy) < threshold) return;
          moved = true;
          if (document.activeElement === input) input.blur();
          window.getSelection()?.removeAllRanges();
          document.body.classList.add('dragging');
        }
        ev.preventDefault();
        const raw = Math.max(min, Math.min(d.max, start + Math.round(dy / (ev.shiftKey ? 12 : px))));
        if (raw !== getRaw(d)) { commit(d, raw); refreshField({ d, input }); }
      };
      const end = clicked => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('blur', onCancel);
        document.body.classList.remove('dragging');
        dragSession = null;
        if (clicked && !moved && !editing && clickToEdit) { input.focus(); input.select(); }
      };
      const onUp = ev => { if (ev.pointerId === e.pointerId) end(true); };
      const onCancel = () => end(false);

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('blur', onCancel);
      dragSession = { end };
    });
  }

  function refreshField(b) {
    const raw = getRaw(b.d);
    const v = b.d.options ? raw : raw - (b.d.offset || 0);
    if (document.activeElement !== b.input || b.d.options) b.input.value = v;
    // Compare: voice fields are read-only and show the original values;
    // unchanged ones are greyed out, changed ones blink.
    const voiceField = b.d.src === 'vced' || b.d.src === 'aced';
    const cmp = state.comparing && voiceField;
    const changed = cmp && state.original[b.d.src][b.d.idx] !== state.edit[b.d.src][b.d.idx];
    b.input.disabled = cmp;
    b.wrap.classList.toggle('cmp-same', cmp && !changed);
    b.wrap.classList.toggle('cmp-changed', changed);
  }
  const refreshAll = () => bound.forEach(refreshField);

  function commit(d, raw) {
    const dev = settings.device;
    if (d.src === 'native') {
      state.native[d.idx] = raw;
      store.set('nativePart', state.native);
      queueSend('n' + d.idx, Sysex.nativePart(dev, settings.part, d.idx, raw), 'Native part ' + d.label, true);
      return;
    }
    if (d.src === 'nativeSys') {
      state.nativeSys[d.idx] = raw;
      store.set('nativeSys', state.nativeSys);
      queueSend('s' + d.idx, Sysex.nativeSystem(dev, d.idx, raw), 'Native system ' + d.label, true);
      return;
    }
    if (state.comparing) return;
    state.edit[d.src][d.idx] = raw;
    markEdited();
    if (d.src === 'vced') queueSend('v' + d.idx, Sysex.vcedParam(dev, d.idx, raw), 'VCED ' + d.idx);
    else queueSend('a' + d.idx, Sysex.acedParam(dev, d.idx, raw), 'ACED ' + d.idx);
    afterParamChange(d);
  }

  // ---------------------------------------------------------------- labels
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const CURVES = ['-LIN', '-EXP', '+EXP', '+LIN'];
  const LFO_WAVES = ['Triangle', 'Saw Down', 'Saw Up', 'Square', 'Sine', 'Sample/Hold'];
  const OFF_ON = ['Off', 'On'];

  // ---------------------------------------------------------------- voice page
  const opViews = [];   // per operator: { root, egSvg, onBtn, levelBar, o }

  function buildVoicePage() {
    makeField($('algFields'), { label: 'Algorithm', src: 'vced', idx: G.ALG, max: 31, options: i => String(i + 1), title: 'Operator arrangement: which operators modulate which, and which are carriers' });
    makeField($('algFields'), { label: 'Feedback', src: 'vced', idx: G.FB, max: 7, title: 'Self-modulation amount of the feedback operator (0–7)' });
    makeField($('algFields'), { label: 'Osc Sync', src: 'vced', idx: G.OPI, max: 1, options: OFF_ON, title: 'Oscillator Key Sync: restart the operator waveforms at each key press' });

    makeField($('lfoFields'), { label: 'Wave', src: 'vced', idx: G.LFW, max: 5, options: LFO_WAVES, wide: true, title: 'LFO waveform' });
    makeField($('lfoFields'), { label: 'Speed', src: 'vced', idx: G.LFS, max: 99, title: 'LFO speed' });
    makeField($('lfoFields'), { label: 'Delay', src: 'vced', idx: G.LFD, max: 99, title: 'Time before the LFO starts after a key is pressed' });
    makeField($('lfoFields'), { label: 'PMD', src: 'vced', idx: G.LPMD, max: 99, title: 'LFO Pitch Modulation Depth (vibrato)' });
    makeField($('lfoFields'), { label: 'AMD', src: 'vced', idx: G.LAMD, max: 99, title: 'LFO Amplitude Modulation Depth (tremolo / wah)' });
    makeField($('lfoFields'), { label: 'Key Sync', src: 'vced', idx: G.LFKS, max: 1, options: OFF_ON, title: 'LFO Key Sync: restart the LFO at each key press' });
    makeField($('lfoFields'), { label: 'Pitch Mod Sens', src: 'vced', idx: G.LPMS, max: 7, title: 'Pitch Modulation Sensitivity: how strongly the LFO and mod wheel move the pitch (0–7)' });

    for (let i = 0; i < 4; i++) makeField($('pegFields'), { label: 'Rate ' + (i + 1), src: 'vced', idx: G.PR1 + i, max: 99, title: `Pitch EG Rate ${i + 1}: speed of moving to Level ${i + 1}` });
    for (let i = 0; i < 4; i++) makeField($('pegFields'), { label: 'Level ' + (i + 1), src: 'vced', idx: G.PL1 + i, max: 99, title: `Pitch EG Level ${i + 1}${i === 3 ? ' (start and release level)' : ''}: 50 = no pitch shift` });

    const nameWrap = h('label', 'field wide');
    nameWrap.title = 'Voice name (10 characters)';
    nameWrap.appendChild(h('span', null, 'Voice Name'));
    const nameInput = h('input');
    nameInput.type = 'text'; nameInput.maxLength = 10; nameInput.id = 'voiceName';
    nameInput.style.fontFamily = 'Courier New, monospace';
    nameInput.addEventListener('input', () => {
      if (state.comparing) return;
      DX.setName(state.edit.vced, nameInput.value);
      markEdited();
      for (let i = 0; i < 10; i++) {
        queueSend('v' + (G.NAME + i), Sysex.vcedParam(settings.device, G.NAME + i, state.edit.vced[G.NAME + i]), 'VCED name');
      }
      updateLcd();
    });
    nameWrap.appendChild(nameInput);
    $('voiceFields').appendChild(nameWrap);
    makeField($('voiceFields'), { label: 'Transpose', src: 'vced', idx: G.TRNP, max: 48, options: DX.transposeName, title: 'Key Transpose (C3 = none)' });

    // operators in display order OP1..OP6
    const opsEl = $('ops');
    for (let n = 1; n <= 6; n++) {
      const o = 6 - n;           // VCED index (OP6 first)
      const b = o * 21;
      const root = h('div', 'panel op');
      const head = h('div', 'op-head');
      const title = h('h3', null, 'OP' + n);
      const onBtn = h('button', 'btn small', 'ON');
      onBtn.title = 'Operator on/off (temporary, not stored with the voice)';
      onBtn.addEventListener('click', () => toggleOp(n));
      const copyBtn = h('button', 'btn small', 'Copy');
      copyBtn.addEventListener('click', () => {
        state.clipboard = state.edit.vced.slice(b, b + 21).concat([state.edit.aced[A.AMS6 + o]]);
        toast('OP' + n + ' copied');
      });
      const pasteBtn = h('button', 'btn small', 'Paste');
      pasteBtn.addEventListener('click', () => pasteOp(o));
      copyBtn.classList.add('push-right');   // Copy, Paste, ON/OFF sit together on the right
      head.append(title, copyBtn, pasteBtn, onBtn);
      root.appendChild(head);

      const secs = h('div', 'op-sections');
      const sec = (name, cls, title) => {
        const s = h('div', 'op-sec');
        const h4 = h('h4', null, name);
        if (title) h4.title = title;
        s.appendChild(h4);
        const f = h('div', 'fields' + (cls ? ' ' + cls : ''));
        s.appendChild(f);
        secs.appendChild(s);
        return { s, f };
      };

      // Operator, Oscillator and Level Scaling each fit on one line ('one-row')
      const out = sec('Operator', 'one-row');
      makeField(out.f, { label: 'Level', src: 'vced', idx: b + OP.TL, max: 99, title: 'Output Level: volume of a carrier, or modulation amount of a modulator' });
      makeField(out.f, { label: 'Velo', src: 'vced', idx: b + OP.KVS, max: 7, title: 'Key Velocity Sensitivity: how much key velocity affects the level (0–7)' });
      makeField(out.f, { label: 'AMS', src: 'vced', idx: b + OP.AMS, max: 3, title: 'Amplitude Modulation Sensitivity (DX7, 0–3)' });
      makeField(out.f, { label: 'Rt Scl', src: 'vced', idx: b + OP.RS, max: 7, title: 'Keyboard Rate Scaling: higher notes make the envelope faster (0–7)' });
      const levelBar = h('div', 'level-bar');
      levelBar.appendChild(h('div'));
      out.s.appendChild(levelBar);

      const osc = sec('Oscillator', 'one-row');
      makeField(osc.f, { label: 'Mode', src: 'vced', idx: b + OP.PM, max: 1, options: ['Ratio', 'Fixed'], title: 'Oscillator Mode: Ratio follows the key pitch, Fixed plays a fixed frequency' });
      makeField(osc.f, { label: 'Coarse', src: 'vced', idx: b + OP.PC, max: 31, title: 'Frequency Coarse: ratio multiplier (0 = 0.5), or fixed frequency range' });
      makeField(osc.f, { label: 'Fine', src: 'vced', idx: b + OP.PF, max: 99, title: 'Frequency Fine: fine adjustment of the ratio or fixed frequency' });
      makeField(osc.f, { label: 'Detune', src: 'vced', idx: b + OP.DET, max: 14, offset: 7, title: 'Detune: slight pitch offset (−7 to +7)' });

      const eg = sec('Envelope');
      const egSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      egSvg.classList.add('eg');
      eg.s.insertBefore(egSvg, eg.f);
      eg.f.classList.add('eg-fields');
      for (let i = 0; i < 4; i++) makeField(eg.f, { label: 'R' + (i + 1), src: 'vced', idx: b + OP.R1 + i, max: 99, title: `EG Rate ${i + 1}: speed of moving to L${i + 1}` });
      for (let i = 0; i < 4; i++) makeField(eg.f, { label: 'L' + (i + 1), src: 'vced', idx: b + OP.L1 + i, max: 99, title: `EG Level ${i + 1}` + ['', '', ' (sustain level)', ' (start and release level)'][i] });

      const kls = sec('Keyboard Level Scaling', 'one-row');
      makeField(kls.f, { label: 'Break', src: 'vced', idx: b + OP.BP, max: 99, options: DX.breakPointName, title: 'Break Point: key where keyboard level scaling starts' });
      makeField(kls.f, { label: 'L Crv', src: 'vced', idx: b + OP.LC, max: 3, options: CURVES, title: 'Left Curve: shape of the level scaling below the break point' });
      makeField(kls.f, { label: 'L Dep', src: 'vced', idx: b + OP.LD, max: 99, title: 'Left Depth: amount of level scaling below the break point' });
      makeField(kls.f, { label: 'R Crv', src: 'vced', idx: b + OP.RC, max: 3, options: CURVES, title: 'Right Curve: shape of the level scaling above the break point' });
      makeField(kls.f, { label: 'R Dep', src: 'vced', idx: b + OP.RD, max: 99, title: 'Right Depth: amount of level scaling above the break point' });

      root.appendChild(secs);
      opsEl.appendChild(root);
      opViews[n] = { root, egSvg, onBtn, levelBar: levelBar.firstChild, o };
    }
    // lines follow the panels when the window resizes or the tab becomes visible
    new ResizeObserver(() => drawOpLinks()).observe(opsEl);
  }

  function pasteOp(o) {
    if (!state.clipboard || state.comparing) return;
    const b = o * 21;
    for (let i = 0; i < 21; i++) state.edit.vced[b + i] = state.clipboard[i];
    state.edit.aced[A.AMS6 + o] = state.clipboard[21];
    markEdited();
    for (let i = 0; i < 21; i++) queueSend('v' + (b + i), Sysex.vcedParam(settings.device, b + i, state.edit.vced[b + i]), 'VCED paste');
    queueSend('a' + (A.AMS6 + o), Sysex.acedParam(settings.device, A.AMS6 + o, state.clipboard[21]), 'ACED paste');
    refreshAll();
    updateGraphics();
    toast('Pasted into OP' + (6 - o));
  }

  // Bit 5 = OP1 ... bit 0 = OP6
  const opBit = n => 1 << (6 - n);
  function toggleOp(n) {
    if (state.comparing) return;
    state.edit.vced[G.OPE] ^= opBit(n);
    markEdited();   // counts as an edit, so Compare can switch back to the original
    queueSend('v155', Sysex.vcedParam(settings.device, G.OPE, state.edit.vced[G.OPE]), 'OP enable');
    updateGraphics();
  }

  // ---------------------------------------------------------------- function page (ACED)
  function buildFunctionPage() {
    makeField($('fnModeFields'), {
      label: 'Poly / Mono', src: 'aced', idx: A.PMOD, max: 3, wide: true,
      options: ['Poly', 'Mono', 'Poly Unison', 'Mono Unison'],
      title: 'Poly or mono, optionally with unison (several voices stacked on each note)',
    });
    makeField($('fnModeFields'), { label: 'Unison Detune', src: 'aced', idx: A.UDTN, max: 7, title: 'Detune between the stacked voices in unison mode (0–7)' });
    makeField($('fnModeFields'), { label: 'Random Pitch', src: 'aced', idx: A.RNDP, max: 7, title: 'Random pitch variation on each note (0–7)' });

    makeField($('fnBendFields'), { label: 'Range', src: 'aced', idx: A.PBR, max: 12, title: 'Pitch bend range in semitones' });
    makeField($('fnBendFields'), { label: 'Step', src: 'aced', idx: A.PBS, max: 12, title: 'Pitch bend step in semitones (0 = smooth)' });

    makeField($('fnPortaFields'), {
      label: 'Mode', src: 'aced', idx: A.PORM, max: 1, wide: true,
      options: ['Retain / Fingered', 'Follow / Full Time'], title: 'Poly: Sus-key retain/follow — Mono: fingered/full time',
    });
    makeField($('fnPortaFields'), { label: 'Step (Gliss)', src: 'aced', idx: A.PQNT, max: 12, title: 'Portamento step in semitones (0 = smooth glide, otherwise glissando)' });
    makeField($('fnPortaFields'), { label: 'Time', src: 'aced', idx: A.POS, max: 99, title: 'Portamento time' });

    makeField($('fnPegFields'), { label: 'PEG Range', src: 'aced', idx: A.PEGR, max: 3, options: ['8 oct', '2 oct', '1 oct', '1/2 oct'], title: 'Pitch EG range: maximum pitch swing of the pitch envelope' });
    makeField($('fnPegFields'), { label: 'PEG Vel Sw', src: 'aced', idx: A.VPSW, max: 1, options: OFF_ON, title: 'Pitch EG velocity switch: key velocity scales the pitch envelope' });
    makeField($('fnPegFields'), { label: 'PEG Rate Scl', src: 'aced', idx: A.PGRS, max: 7, title: 'Pitch EG rate scaling: higher notes make the pitch envelope faster (0–7)' });
    makeField($('fnPegFields'), { label: 'LFO Key Trig', src: 'aced', idx: A.LTRG, max: 1, options: ['Single', 'Multi'], title: 'LFO key trigger: Single = one LFO for all notes, Multi = one LFO per note' });

    for (let n = 1; n <= 6; n++) {
      makeField($('fnAmsFields'), { label: 'OP' + n, src: 'aced', idx: A.AMS6 + (6 - n), max: 7, title: `OP${n} Amplitude Modulation Sensitivity (DX7II, 0–7)` });
    }
  }

  // ---------------------------------------------------------------- native page
  const nativeOpFields = { car: [], mod: [] };
  function buildNativePage() {
    makeField($('nativeSysFields'), {
      label: 'Velocity Curve', src: 'nativeSys', idx: 0x08, max: 6, wide: true,
      options: ['DX7', 'Normal', 'Soft1', 'Soft2', 'Easy', 'Wide', 'Hard'], title: 'Velocity response curve of the PLG150-DX',
    });

    makeField($('nativeAcFields'), {
      label: 'AC4 Controller', src: 'native', idx: 0x00, max: 6, wide: true,
      options: ['Off', 'Mod Wheel', 'Breath', 'Foot', 'Expression', 'Ch Aftertouch', 'Pitch Bend'], title: 'Controller assigned to AC4 (assignable controller)',
    });
    makeField($('nativeAcFields'), { label: 'AC4 Param', src: 'native', idx: 0x01, max: 1, options: ['No assign', 'EG Bias'], title: 'What AC4 controls' });
    makeField($('nativeAcFields'), { label: 'AC4 Depth', src: 'native', idx: 0x05, max: 127, offset: 64, title: 'How strongly AC4 affects its destination (−64 to +63)' });
    makeField($('nativeAcFields'), { label: 'Rcv DX SysEx', src: 'native', idx: 0x20, max: 1, options: OFF_ON, title: 'Must be ON for this editor to work' });

    makeField($('nativePortaFields'), { label: 'Feedback', src: 'native', idx: 0x1B, min: 57, max: 71, offset: 64, title: 'Feedback offset added to the voice (−7 to +7)' });
    makeField($('nativePortaFields'), { label: 'Porta Mode', src: 'native', idx: 0x1C, max: 1, wide: true, options: ['Retain / Fingered', 'Follow / Full Time'], title: 'Poly: Sus-key retain/follow — Mono: fingered/full time' });
    makeField($('nativePortaFields'), { label: 'Porta Step', src: 'native', idx: 0x1D, max: 12, title: 'Portamento step in semitones (0 = smooth glide)' });
    makeField($('nativePortaFields'), { label: 'Bend Step', src: 'native', idx: 0x1E, max: 12, title: 'Pitch bend step in semitones (0 = smooth)' });

    for (let n = 1; n <= 6; n++) {
      nativeOpFields.car.push(makeField($('nativeCarFields'), { label: 'OP' + n, src: 'native', idx: 0x0A + n, max: 127, offset: 64, title: `OP${n} carrier level offset (−64 to +63)` }));
      nativeOpFields.mod.push(makeField($('nativeModFields'), { label: 'OP' + n, src: 'native', idx: 0x12 + n, max: 127, offset: 64, title: `OP${n} modulator level offset (−64 to +63)` }));
    }
  }

  function sendNativeAll() {
    if (!requireOutput()) return;
    const dev = settings.device;
    const list = [[Sysex.nativeSystem(dev, 0x08, state.nativeSys[0x08]), 'Native velocity curve']];
    for (const k in state.native) list.push([Sysex.nativePart(dev, settings.part, +k, state.native[k]), 'Native part ' + (+k).toString(16)]);
    midi.sendSequence(list, 15).then(() => toast('Native settings sent'));
  }

  // ---------------------------------------------------------------- graphics & LCD
  function afterParamChange(d) {
    if (d.src === 'vced' && d.idx >= G.NAME && d.idx < G.NAME + 10) updateLcd();
    updateGraphics();
  }

  function updateGraphics() {
    const v = shownVoice().vced;
    const alg = Graphics.ALGORITHMS[v[G.ALG]];
    // Operator panels mirror the algorithm: carriers on the bottom row,
    // each modulator stacked above the operator it modulates.
    // Linear layout: all six side by side, OP1..OP6, no connection lines.
    const linear = settings.opLayout === 'linear';
    const { pos, cols, rows } = Graphics.layout(alg);
    $('ops').classList.toggle('linear', linear);
    // fixed-width columns (--op-w), so panels keep their size whatever the algorithm
    $('ops').style.gridTemplateColumns = `repeat(${linear ? 6 : cols}, var(--op-w))`;
    Graphics.drawAlgorithm($('algSvg'), v[G.ALG], n => (v[G.OPE] & opBit(n)) !== 0, toggleOp);
    Graphics.drawEnvelope($('pegSvg'),
      [v[G.PR1], v[G.PR2], v[G.PR3], v[G.PR4]], [v[G.PL1], v[G.PL2], v[G.PL3], v[G.PL4]], { bipolar: true });
    for (let n = 1; n <= 6; n++) {
      const view = opViews[n], b = view.o * 21;
      const carrier = alg.carriers.includes(n);
      const on = (v[G.OPE] & opBit(n)) !== 0;
      view.root.classList.toggle('carrier', carrier);
      view.root.classList.toggle('off', !on);
      view.root.style.gridColumn = linear ? n : pos[n].col + 1;
      view.root.style.gridRow = linear ? 1 : rows - pos[n].row;
      view.onBtn.textContent = on ? 'ON' : 'OFF';
      view.onBtn.classList.toggle('on', on);
      // Compare: the button shows the original state; greyed if unchanged, blinking if toggled
      const opChanged = state.comparing && ((state.original.vced[G.OPE] ^ state.edit.vced[G.OPE]) & opBit(n)) !== 0;
      view.onBtn.disabled = state.comparing;
      view.onBtn.classList.toggle('cmp-same', state.comparing && !opChanged);
      view.onBtn.classList.toggle('cmp-changed', opChanged);
      view.levelBar.style.width = (v[b + OP.TL] / 99 * 100) + '%';
      Graphics.drawEnvelope(view.egSvg,
        [v[b + OP.R1], v[b + OP.R2], v[b + OP.R3], v[b + OP.R4]],
        [v[b + OP.L1], v[b + OP.L2], v[b + OP.L3], v[b + OP.L4]]);
      // native carrier/modulator offsets apply only to operators of that role
      nativeOpFields.car[n - 1].wrap.classList.toggle('disabled', !carrier);
      nativeOpFields.mod[n - 1].wrap.classList.toggle('disabled', carrier);
    }
    drawOpLinks();
  }

  function drawOpLinks() {
    if (settings.opLayout === 'linear') { $('opsLines').innerHTML = ''; return; }
    const v = shownVoice().vced;
    const panels = {};
    for (let n = 1; n <= 6; n++) panels[n] = opViews[n].root;
    Graphics.drawOpConnections($('opsLines'), $('ops'), v[G.ALG], panels, n => (v[G.OPE] & opBit(n)) !== 0);
  }

  function updateLcd() {
    const num = String(state.index + 1).padStart(2, '0');
    const name = DX.getName(shownVoice().vced);
    Graphics.drawSevenSegment($('ledSvg'), num, state.edited);
    $('led').setAttribute('aria-label', `Voice ${num}${state.edited ? ', edited' : ''}`);
    $('led').classList.toggle('blink', state.comparing);
    $('lcd1').textContent = state.comparing ? 'COMPARE' : state.storeMode ? 'STORE: SELECT' : ('CRT ' + cartLabel(state.cartName)).slice(0, 16);
    $('lcd2').textContent = `V${num} ${name}`;
    const ni = $('voiceName');
    if (ni) {
      if (document.activeElement !== ni) ni.value = name.trimEnd();
      const nameChanged = DX.getName(state.original.vced) !== DX.getName(state.edit.vced);
      ni.disabled = state.comparing;
      ni.parentElement.classList.toggle('cmp-same', state.comparing && !nameChanged);
      ni.parentElement.classList.toggle('cmp-changed', state.comparing && nameChanged);
    }
  }

  // "Edited" means the edit buffer actually differs from the voice as selected,
  // so putting every parameter back counts as unedited again (LED dot off,
  // Compare reports no changes, no discard prompt).
  function markEdited() {
    const e = state.edit, o = state.original;
    state.edited = e.vced.some((b, i) => b !== o.vced[i]) || e.aced.some((b, i) => b !== o.aced[i]);
    updateLcd();
  }

  // ---------------------------------------------------------------- librarian
  function buildVoiceGrid() {
    const grid = $('voiceGrid');
    grid.innerHTML = '';
    const voices = cart().voices;
    voices.forEach((v, i) => {
      const b = h('button', 'voice-btn' + (i === state.index ? ' sel' : ''));
      b.appendChild(h('span', 'num', String(i + 1)));
      b.appendChild(h('span', 'name', DX.getName(v.vced)));
      b.title = DX.getName(v.vced).trim();
      b.addEventListener('click', () => onVoiceButton(i));
      grid.appendChild(b);
    });
    grid.classList.toggle('store-mode', state.storeMode);
  }

  function onVoiceButton(i) {
    if (state.storeMode) {
      if (!confirm(`Store "${DX.getName(state.edit.vced).trim()}" to ${cartLabel(state.cartName)} #${i + 1}, replacing "${DX.getName(cart().voices[i].vced).trim()}"?`)) {
        return;
      }
      const v = DX.cloneVoice(state.edit);
      v.vced[G.OPE] = 63;
      cart().voices[i] = v;
      cart().modified = true;
      persistCarts();
      state.storeMode = false;
      state.index = i;
      state.original = DX.cloneVoice(state.edit);
      state.edited = false;
      buildVoiceGrid();
      buildCartSelect();
      updateLcd();
      toast(`Stored to ${cartLabel(state.cartName)} #${i + 1}. Use "Send Bank" to write the cartridge to the PLG.`);
      return;
    }
    selectVoice(i);
  }

  function selectVoice(i, opts = {}) {
    if (state.edited && !opts.force && !confirm('The current voice has unsaved edits. Discard them?')) return;
    state.comparing = false;
    state.index = i;
    state.edit = DX.cloneVoice(cart().voices[i]);
    state.original = DX.cloneVoice(state.edit);
    state.edited = false;
    $('compare').classList.remove('on');
    buildVoiceGrid();
    refreshAll();
    updateGraphics();
    updateLcd();
    if (settings.autoSend && midi.output && !opts.noSend) sendVoice();
  }

  function buildCartSelect() {
    const sel = $('cartSelect');
    sel.innerHTML = '';
    for (const n in state.carts) {
      const c = state.carts[n];
      sel.appendChild(new Option(cartLabel(n) + (c.rom && c.modified ? ' (edited)' : ''), n));
    }
    sel.appendChild(new Option('＋ New cartridge', '__new'));
    if (state.carts[state.cartName] && (!state.carts[state.cartName].rom || state.carts[state.cartName].modified)) {
      sel.appendChild(new Option(state.carts[state.cartName].rom ? '↺ Revert this ROM' : '✕ Remove this cartridge', '__remove'));
    }
    sel.value = state.cartName;
  }

  function selectCart(name, opts = {}) {
    if (state.edited && !opts.force && !confirm('The current voice has unsaved edits. Discard them?')) {
      $('cartSelect').value = state.cartName;
      return;
    }
    state.cartName = name;
    settings.cart = name; saveSettings();
    state.storeMode = false;
    buildCartSelect();
    selectVoice(0, { force: true, noSend: opts.noSend });
  }

  function uniqueName(base) {
    let n = base.replace(/\.[^.]+$/, '').slice(0, 24) || 'USER';
    if (!state.carts[n]) return n;
    for (let i = 2; ; i++) if (!state.carts[`${n} (${i})`]) return `${n} (${i})`;
  }

  function onCartSelect() {
    const v = $('cartSelect').value;
    if (v === '__new') {
      const name = uniqueName('USER');
      state.carts[name] = { voices: range(32, () => DX.newVoice()), rom: false, modified: true };
      persistCarts();
      selectCart(name);
    } else if (v === '__remove') {
      const c = cart();
      if (!confirm(c.rom ? `Revert ${cartLabel(state.cartName)} to the factory ROM data?` : `Remove cartridge "${state.cartName}" from the editor?`)) {
        $('cartSelect').value = state.cartName;
        return;
      }
      if (c.rom) { state.carts[state.cartName] = { voices: romVoices(state.cartName), rom: true, modified: false }; persistCarts(); selectCart(state.cartName, { force: true }); }
      else { delete state.carts[state.cartName]; persistCarts(); selectCart(ROM_NAMES[0], { force: true }); }
    } else {
      selectCart(v);
    }
  }

  function importSysex(bytes, name) {
    const res = DX.parseSyxFile(bytes);
    res.warnings.forEach(w => toast(w, true));
    if (res.voices) {
      const n = uniqueName(name);
      state.carts[n] = { voices: res.voices, rom: false, modified: true };
      persistCarts();
      selectCart(n, { noSend: true });
      toast(`Loaded 32 voices into "${n}"`);
    } else if (res.single) {
      if (state.edited && !confirm('Replace the current edits with the received voice?')) return;
      state.edit = res.single;
      state.comparing = false;
      markEdited();
      refreshAll(); updateGraphics(); updateLcd();
      toast(`Loaded voice "${DX.getName(res.single.vced).trim()}" into the edit buffer`);
      if (settings.autoSend && midi.output) sendVoice();
    } else {
      toast('No DX7 voice data (VMEM 32-voice or VCED 1-voice) found', true);
    }
  }

  function download(name, bytes) {
    const blob = new Blob([Uint8Array.from(bytes)], { type: 'application/octet-stream' });
    const a = h('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const fileSafe = s => s.trim().replace(/[^\w\-. ]+/g, '_') || 'voice';

  // ---------------------------------------------------------------- keyboard & wheels
  const KEY_COUNT = 61;
  const keyEls = new Map();
  const down = new Set();
  const baseNote = () => 36 + settings.octave * 12;   // 36 = C1 (Yamaha naming)

  function noteOn(note, vel) {
    if (note < 0 || note > 127 || down.has(note)) return;
    down.add(note);
    keyEls.get(note)?.classList.add('down');
    midi.send([0x90 | settings.channel, note, vel || settings.velocity]);
  }
  function noteOff(note) {
    if (!down.has(note)) return;
    down.delete(note);
    keyEls.get(note)?.classList.remove('down');
    midi.send([0x80 | settings.channel, note, 64]);
  }
  function allOff() { [...down].forEach(noteOff); }

  function buildKeyboard() {
    const kb = $('keyboard');
    kb.innerHTML = '';
    keyEls.clear();
    const isBlack = n => [1, 3, 6, 8, 10].includes(n % 12);
    const base = baseNote();
    const whites = range(KEY_COUNT, i => base + i).filter(n => !isBlack(n)).length;
    const ww = 100 / whites;
    let wi = 0;
    for (let i = 0; i < KEY_COUNT; i++) {
      const note = base + i;
      const k = h('div', 'key ' + (isBlack(note) ? 'black' : 'white'));
      if (isBlack(note)) {
        k.style.left = `calc(${wi * ww}% - ${ww * 0.32}%)`;
        k.style.width = ww * 0.64 + '%';
      } else {
        k.style.left = wi * ww + '%';
        k.style.width = ww + '%';
        if (note % 12 === 0) k.appendChild(h('span', 'lbl', DX.noteName(note)));
        wi++;
      }
      k.dataset.note = note;
      keyEls.set(note, k);
      kb.appendChild(k);
    }
    $('octLabel').textContent = `${DX.noteName(base)}–${DX.noteName(base + KEY_COUNT - 1)}`;
  }

  function setupKeyboardPointer() {
    const kb = $('keyboard');
    const active = new Map();   // pointerId -> note
    const velFromEvent = (e, key) => {
      // lower on the key = louder, scaled around the velocity slider value
      const r = key.getBoundingClientRect();
      const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      return Math.max(1, Math.min(127, Math.round(settings.velocity * (0.55 + 0.6 * y))));
    };
    const keyAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el && el.classList.contains('key') ? el : null;
    };
    kb.addEventListener('pointerdown', e => {
      const key = keyAt(e.clientX, e.clientY);
      if (!key) return;
      kb.setPointerCapture(e.pointerId);
      const note = +key.dataset.note;
      active.set(e.pointerId, note);
      noteOn(note, velFromEvent(e, key));
    });
    kb.addEventListener('pointermove', e => {
      if (!active.has(e.pointerId)) return;
      const key = keyAt(e.clientX, e.clientY);
      const note = key ? +key.dataset.note : null;
      if (note === active.get(e.pointerId)) return;
      noteOff(active.get(e.pointerId));
      if (note != null) { active.set(e.pointerId, note); noteOn(note, velFromEvent(e, key)); }
      else active.set(e.pointerId, null);
    });
    const end = e => {
      if (!active.has(e.pointerId)) return;
      const n = active.get(e.pointerId);
      if (n != null) noteOff(n);
      active.delete(e.pointerId);
    };
    kb.addEventListener('pointerup', end);
    kb.addEventListener('pointercancel', end);
  }

  // Computer keyboard: two rows like a tracker. Z = C of the lowest octave.
  const KEYMAP = {
    z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ',': 12,
    q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24,
  };
  function setupComputerKeys() {
    const typing = () => {
      const a = document.activeElement;
      return a && (a.tagName === 'INPUT' && a.type !== 'checkbox' && a.type !== 'range' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
    };
    const noteFor = k => baseNote() + 24 + KEYMAP[k];   // starts at C3
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && state.storeMode) { state.storeMode = false; buildVoiceGrid(); updateLcd(); return; }
      if (typing() || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k in KEYMAP) { noteOn(noteFor(k)); e.preventDefault(); }
    });
    document.addEventListener('keyup', e => {
      const k = e.key.toLowerCase();
      if (k in KEYMAP) noteOff(noteFor(k));
    });
    window.addEventListener('blur', allOff);
  }

  // Generic vertical wheel. value is 0..1; springBack returns it to 0.5 on release.
  function setupWheel(el, initial, springBack, onChange) {
    const thumb = el.firstElementChild;
    let value = initial;
    const draw = () => {
      const r = el.clientHeight - thumb.offsetHeight - 4;
      thumb.style.top = (2 + (1 - value) * r) + 'px';
    };
    const setFromY = y => {
      const r = el.getBoundingClientRect();
      const t = thumb.offsetHeight;
      value = Math.max(0, Math.min(1, 1 - (y - r.top - t / 2) / (r.height - t)));
      draw();
      onChange(value);
    };
    el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); setFromY(e.clientY); });
    el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId)) setFromY(e.clientY); });
    const release = () => {
      if (!springBack) return;
      value = 0.5; draw(); onChange(value);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    new ResizeObserver(draw).observe(el);
    draw();
  }

  function setupPerformance() {
    let lastBend = -1, lastMod = -1;
    setupWheel($('pitchWheel'), 0.5, true, v => {
      const val = v === 0.5 ? 8192 : Math.round(v * 16383);
      if (val === lastBend) return;
      lastBend = val;
      midi.send([0xE0 | settings.channel, val & 0x7F, val >> 7]);
    });
    setupWheel($('modWheel'), 0, false, v => {
      const val = Math.round(v * 127);
      if (val === lastMod) return;
      lastMod = val;
      midi.send([0xB0 | settings.channel, 1, val]);
    });
    let sustain = false;
    $('sustain').addEventListener('click', () => {
      sustain = !sustain;
      $('sustain').classList.toggle('on', sustain);
      midi.send([0xB0 | settings.channel, 64, sustain ? 127 : 0]);
    });
    $('panic').addEventListener('click', () => {
      allOff();
      const ch = settings.channel;
      midi.send([0xB0 | ch, 120, 0]);
      midi.send([0xB0 | ch, 123, 0]);
      midi.send([0xB0 | ch, 121, 0]);
      sustain = false;
      $('sustain').classList.remove('on');
    });
    $('velocity').value = settings.velocity;
    $('velOut').textContent = settings.velocity;
    $('velocity').addEventListener('input', e => {
      settings.velocity = +e.target.value;
      $('velOut').textContent = settings.velocity;
      saveSettings();
    });
    const shift = d => {
      const o = Math.max(-2, Math.min(2, settings.octave + d));
      if (o === settings.octave) return;
      allOff();
      settings.octave = o; saveSettings();
      buildKeyboard();
    };
    // Hiding the footer only frees screen space; the computer keys still play.
    const showPerf = hidden => {
      document.body.classList.toggle('perf-hidden', hidden);
      $('perfToggle').textContent = hidden ? '▲ Keyboard' : '▼ Keyboard';
      $('perfToggle').title = hidden ? 'Show the keyboard' : 'Hide the keyboard';
      $('perfToggle').setAttribute('aria-expanded', String(!hidden));
    };
    showPerf(settings.perfHidden);
    $('perfToggle').addEventListener('click', () => {
      settings.perfHidden = !settings.perfHidden; saveSettings();
      if (settings.perfHidden) allOff();
      showPerf(settings.perfHidden);
    });
    $('octDown').addEventListener('click', () => shift(-1));
    $('octUp').addEventListener('click', () => shift(1));
    buildKeyboard();
    setupKeyboardPointer();
    setupComputerKeys();
  }

  // ---------------------------------------------------------------- setup bar & buttons
  function setupControls() {
    const fill = (sel, n, f, val) => { for (let i = 0; i < n; i++) sel.appendChild(new Option(f(i), i)); sel.value = val; };
    fill($('deviceId'), 16, i => String(i + 1), settings.device);
    fill($('midiChannel'), 16, i => String(i + 1), settings.channel);
    fill($('plgPart'), 16, i => String(i + 1), settings.part);
    $('deviceId').addEventListener('change', e => { settings.device = +e.target.value; saveSettings(); });
    $('midiChannel').addEventListener('change', e => { allOff(); settings.channel = +e.target.value; saveSettings(); });
    $('plgPart').addEventListener('change', e => { settings.part = +e.target.value; saveSettings(); });
    $('midiOut').addEventListener('change', e => {
      allOff();
      midi.selectOutput(e.target.value);
      settings.out = midi.output ? midi.output.name : ''; saveSettings();
      refreshPorts();
    });
    $('midiConnect').addEventListener('click', enableMidi);
    const applyUiScaling = () => document.body.classList.toggle('ui-auto', settings.uiScaling === 'auto');
    if (settings.uiScaling !== 'auto') settings.uiScaling = 'fixed';   // unknown or missing value
    $('uiScaling').value = settings.uiScaling;
    applyUiScaling();
    $('uiScaling').addEventListener('change', e => { settings.uiScaling = e.target.value; saveSettings(); applyUiScaling(); });
    $('opLayout').value = settings.opLayout;
    $('opLayout').addEventListener('change', e => { settings.opLayout = e.target.value; saveSettings(); updateGraphics(); });

    const bindCheck = (id, key) => {
      $(id).checked = settings[key];
      $(id).addEventListener('change', e => { settings[key] = e.target.checked; saveSettings(); });
    };
    bindCheck('liveSend', 'liveSend');
    bindCheck('autoSend', 'autoSend');
    bindCheck('sendAmem', 'sendAmem');
    $('bulkBlock').value = settings.bulkBlock;
    $('bulkBlock').addEventListener('change', e => { settings.bulkBlock = +e.target.value; saveSettings(); });

    $('sendVoice').addEventListener('click', () => sendVoice(state.comparing ? state.original : state.edit));
    $('sendBank').addEventListener('click', sendBank);
    $('compare').addEventListener('click', () => {
      if (!state.edited) { toast('Nothing to compare: no parameter differs from the original voice'); return; }
      state.comparing = !state.comparing;
      $('compare').classList.toggle('on', state.comparing);
      refreshAll();
      updateGraphics();
      updateLcd();
      if (midi.output) sendVoice(state.comparing ? state.original : state.edit);
    });
    $('storeVoice').addEventListener('click', () => {
      if (state.comparing) return;
      state.storeMode = !state.storeMode;
      buildVoiceGrid();
      updateLcd();
      if (state.storeMode) toast('Click the destination voice button (Esc to cancel)');
    });
    $('initVoice').addEventListener('click', () => {
      if (state.comparing || !confirm('Initialize the edit buffer to INIT VOICE?')) return;
      state.edit = DX.newVoice();
      markEdited();
      refreshAll(); updateGraphics();
      if (midi.output) sendVoice();
    });
    $('exportVoice').addEventListener('click', () => {
      const dev = settings.device;
      const bytes = [...Sysex.vcedBulk(dev, state.edit.vced), ...Sysex.acedBulk(dev, state.edit.aced)];
      download(fileSafe(DX.getName(state.edit.vced)) + '.syx', bytes);
    });

    $('cartSelect').addEventListener('change', onCartSelect);
    const openFile = () => $('fileInput').click();
    $('loadFile').addEventListener('click', openFile);
    $('fileInput').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      importSysex(new Uint8Array(await f.arrayBuffer()), f.name);
    });
    $('saveCart').addEventListener('click', () => {
      const voices = cart().voices;
      // VMEM first so plain DX7 tools read the file; AMEM follows for the extra parameters.
      const bytes = [...Sysex.vmemBulk(0, voices), ...Sysex.amemBulk(0, voices)];
      download(fileSafe(cartLabel(state.cartName)) + '.syx', bytes);
    });

    // tabs
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    }));

    $('sendNativeAll').addEventListener('click', sendNativeAll);
    $('resetNative').addEventListener('click', () => {
      Object.assign(state.native, NATIVE_DEFAULTS);
      state.nativeSys[0x08] = 1;
      store.set('nativePart', state.native);
      store.set('nativeSys', state.nativeSys);
      refreshAll();
      if (midi.output) sendNativeAll();
    });
    $('clearLog').addEventListener('click', () => { $('log').textContent = ''; });

    window.addEventListener('beforeunload', e => {
      if (state.edited) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ---------------------------------------------------------------- boot
  loadCarts();
  state.cartName = state.carts[settings.cart] ? settings.cart : ROM_NAMES[0];
  setupControls();
  buildVoicePage();
  buildFunctionPage();
  buildNativePage();
  buildCartSelect();
  selectVoice(0, { force: true, noSend: true });
  setupPerformance();
  // Re-open MIDI automatically if the permission was granted before.
  if (midi.supported && navigator.permissions) {
    navigator.permissions.query({ name: 'midi', sysex: true })
      .then(p => { if (p.state === 'granted') enableMidi(); })
      .catch(() => {});
  }
})();
