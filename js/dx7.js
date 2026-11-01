// DX7 / PLG150-DX voice data model.
//
// A voice is held as two plain byte arrays, exactly in the layout the PLG150-DX
// receives them (see PLG150-DX manual, tables <3-2>, <3-3>, <4-2>, <4-3>):
//   vced: 156 bytes  -> VCED (Voice Edit Buffer) params 0..155. 155 = operator enable.
//   aced: 49 bytes   -> ACED (Additional Edit Buffer) params 0..48.
// Operators are stored OP6 first (op index 0 = OP6 ... 5 = OP1), as in the spec.
(function () {
  'use strict';

  const VCED_SIZE = 155;      // bytes sent in a VCED bulk (op-enable is not part of it)
  const ACED_SIZE = 49;
  const VMEM_VOICE = 128;
  const AMEM_VOICE = 35;

  // VCED per-operator parameter offsets (add opIndex * 21)
  const OP = {
    R1: 0, R2: 1, R3: 2, R4: 3, L1: 4, L2: 5, L3: 6, L4: 7,
    BP: 8, LD: 9, RD: 10, LC: 11, RC: 12, RS: 13, AMS: 14, KVS: 15,
    TL: 16, PM: 17, PC: 18, PF: 19, DET: 20,
  };
  // VCED global parameter numbers
  const G = {
    PR1: 126, PR2: 127, PR3: 128, PR4: 129, PL1: 130, PL2: 131, PL3: 132, PL4: 133,
    ALG: 134, FB: 135, OPI: 136, LFS: 137, LFD: 138, LPMD: 139, LAMD: 140,
    LFKS: 141, LFW: 142, LPMS: 143, TRNP: 144, NAME: 145, OPE: 155,
  };
  // ACED parameter numbers (AMS0-7 for OP6..OP1 at 6..11)
  const A = {
    AMS6: 6, PEGR: 12, LTRG: 13, VPSW: 14, PMOD: 15, PBR: 16, PBS: 17,
    RNDP: 19, PORM: 20, PQNT: 21, POS: 22, PGRS: 38, UDTN: 47,
  };

  // Maximum values for every VCED parameter, used to sanitise imported data.
  const VCED_MAX = new Array(156).fill(99);
  for (let o = 0; o < 6; o++) {
    const b = o * 21;
    VCED_MAX[b + OP.LC] = 3; VCED_MAX[b + OP.RC] = 3; VCED_MAX[b + OP.RS] = 7;
    VCED_MAX[b + OP.AMS] = 3; VCED_MAX[b + OP.KVS] = 7; VCED_MAX[b + OP.PM] = 1;
    VCED_MAX[b + OP.PC] = 31; VCED_MAX[b + OP.DET] = 14;
  }
  Object.assign(VCED_MAX, {
    [G.ALG]: 31, [G.FB]: 7, [G.OPI]: 1, [G.LFKS]: 1, [G.LFW]: 5, [G.LPMS]: 7, [G.TRNP]: 48,
    [G.OPE]: 63,
  });
  for (let i = 0; i < 10; i++) VCED_MAX[G.NAME + i] = 127;

  const ACED_MAX = new Array(ACED_SIZE).fill(0);
  for (let i = 0; i < 6; i++) ACED_MAX[A.AMS6 + i] = 7;
  Object.assign(ACED_MAX, {
    [A.PEGR]: 3, [A.LTRG]: 1, [A.VPSW]: 1, [A.PMOD]: 3, [A.PBR]: 12, [A.PBS]: 12,
    [A.RNDP]: 7, [A.PORM]: 1, [A.PQNT]: 12, [A.POS]: 99, [A.PGRS]: 7, [A.UDTN]: 7,
  });

  const clamp = (v, max) => Math.max(0, Math.min(max, v | 0));

  function initVced() {
    const v = new Array(156).fill(0);
    for (let o = 0; o < 6; o++) {
      const b = o * 21;
      v[b + OP.R1] = v[b + OP.R2] = v[b + OP.R3] = v[b + OP.R4] = 99;
      v[b + OP.L1] = v[b + OP.L2] = v[b + OP.L3] = 99;
      v[b + OP.L4] = 0;
      v[b + OP.BP] = 39;
      v[b + OP.TL] = o === 5 ? 99 : 0;   // OP1 only
      v[b + OP.PC] = 1;
      v[b + OP.DET] = 7;
    }
    v[G.PR1] = v[G.PR2] = v[G.PR3] = v[G.PR4] = 99;
    v[G.PL1] = v[G.PL2] = v[G.PL3] = v[G.PL4] = 50;
    v[G.OPI] = 1; v[G.LFS] = 35; v[G.LFKS] = 1; v[G.LPMS] = 3; v[G.TRNP] = 24;
    setName(v, 'INIT VOICE');
    v[G.OPE] = 63;
    return v;
  }

  function initAced() {
    const a = new Array(ACED_SIZE).fill(0);
    a[A.PBR] = 2;
    return a;
  }

  function newVoice() { return { vced: initVced(), aced: initAced() }; }
  function cloneVoice(v) { return { vced: v.vced.slice(), aced: v.aced.slice() }; }

  function getName(vced) {
    let s = '';
    for (let i = 0; i < 10; i++) {
      const c = vced[G.NAME + i];
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : ' ';
    }
    return s;
  }
  function setName(vced, name) {
    const s = (name + '          ').slice(0, 10);
    for (let i = 0; i < 10; i++) {
      const c = s.charCodeAt(i);
      vced[G.NAME + i] = (c >= 32 && c < 127) ? c : 32;
    }
  }

  // ---- VMEM (packed 128 bytes) <-> VCED ---------------------------------
  function vmemToVced(p) {
    const v = new Array(156).fill(0);
    for (let o = 0; o < 6; o++) {
      const s = o * 17, d = o * 21;
      for (let i = 0; i < 11; i++) v[d + i] = p[s + i];
      v[d + OP.LC] = p[s + 11] & 3;
      v[d + OP.RC] = (p[s + 11] >> 2) & 3;
      v[d + OP.RS] = p[s + 12] & 7;
      v[d + OP.DET] = (p[s + 12] >> 3) & 15;
      v[d + OP.AMS] = p[s + 13] & 3;
      v[d + OP.KVS] = (p[s + 13] >> 2) & 7;
      v[d + OP.TL] = p[s + 14];
      v[d + OP.PM] = p[s + 15] & 1;
      v[d + OP.PC] = (p[s + 15] >> 1) & 31;
      v[d + OP.PF] = p[s + 16];
    }
    for (let i = 0; i < 8; i++) v[G.PR1 + i] = p[102 + i];
    v[G.ALG] = p[110] & 31;
    v[G.FB] = p[111] & 7;
    v[G.OPI] = (p[111] >> 3) & 1;
    v[G.LFS] = p[112]; v[G.LFD] = p[113]; v[G.LPMD] = p[114]; v[G.LAMD] = p[115];
    v[G.LFKS] = p[116] & 1;
    v[G.LFW] = (p[116] >> 1) & 7;
    v[G.LPMS] = (p[116] >> 4) & 7;
    v[G.TRNP] = p[117];
    for (let i = 0; i < 10; i++) v[G.NAME + i] = p[118 + i] & 127;
    v[G.OPE] = 63;
    for (let i = 0; i < 156; i++) v[i] = clamp(v[i], VCED_MAX[i]);
    return v;
  }

  function vcedToVmem(v) {
    const p = new Array(VMEM_VOICE).fill(0);
    for (let o = 0; o < 6; o++) {
      const s = o * 17, d = o * 21;
      for (let i = 0; i < 11; i++) p[s + i] = v[d + i];
      p[s + 11] = (v[d + OP.RC] << 2) | v[d + OP.LC];
      p[s + 12] = (v[d + OP.DET] << 3) | v[d + OP.RS];
      p[s + 13] = (v[d + OP.KVS] << 2) | v[d + OP.AMS];
      p[s + 14] = v[d + OP.TL];
      p[s + 15] = (v[d + OP.PC] << 1) | v[d + OP.PM];
      p[s + 16] = v[d + OP.PF];
    }
    for (let i = 0; i < 8; i++) p[102 + i] = v[G.PR1 + i];
    p[110] = v[G.ALG];
    p[111] = (v[G.OPI] << 3) | v[G.FB];
    p[112] = v[G.LFS]; p[113] = v[G.LFD]; p[114] = v[G.LPMD]; p[115] = v[G.LAMD];
    p[116] = (v[G.LPMS] << 4) | (v[G.LFW] << 1) | v[G.LFKS];
    p[117] = v[G.TRNP];
    for (let i = 0; i < 10; i++) p[118 + i] = v[G.NAME + i];
    return p.map(b => b & 127);
  }

  // ---- AMEM (packed 35 bytes) <-> ACED ----------------------------------
  function amemToAced(p) {
    const a = initAced();
    a[A.AMS6 + 0] = p[1] & 7;  a[A.AMS6 + 1] = (p[1] >> 3) & 7;   // OP6, OP5
    a[A.AMS6 + 2] = p[2] & 7;  a[A.AMS6 + 3] = (p[2] >> 3) & 7;   // OP4, OP3
    a[A.AMS6 + 4] = p[3] & 7;  a[A.AMS6 + 5] = (p[3] >> 3) & 7;   // OP2, OP1
    a[A.PEGR] = p[4] & 3;
    a[A.LTRG] = (p[4] >> 2) & 1;
    a[A.VPSW] = (p[4] >> 3) & 1;
    a[A.RNDP] = (p[4] >> 4) & 7;
    a[A.PMOD] = p[5] & 3;
    a[A.PBR] = (p[5] >> 2) & 15;
    a[A.PBS] = p[6] & 15;
    a[A.PORM] = p[7] & 1;
    a[A.PQNT] = (p[7] >> 1) & 15;
    a[A.POS] = p[8];
    a[A.PGRS] = p[0x18] & 7;
    a[A.UDTN] = p[0x22] & 7;
    for (let i = 0; i < ACED_SIZE; i++) a[i] = clamp(a[i], ACED_MAX[i]);
    return a;
  }

  function acedToAmem(a) {
    const p = new Array(AMEM_VOICE).fill(0);
    p[1] = (a[A.AMS6 + 1] << 3) | a[A.AMS6 + 0];
    p[2] = (a[A.AMS6 + 3] << 3) | a[A.AMS6 + 2];
    p[3] = (a[A.AMS6 + 5] << 3) | a[A.AMS6 + 4];
    p[4] = (a[A.RNDP] << 4) | (a[A.VPSW] << 3) | (a[A.LTRG] << 2) | a[A.PEGR];
    p[5] = (a[A.PBR] << 2) | a[A.PMOD];
    p[6] = a[A.PBS];
    p[7] = (a[A.PQNT] << 1) | a[A.PORM];
    p[8] = a[A.POS];
    p[0x18] = a[A.PGRS];
    p[0x22] = a[A.UDTN];
    return p.map(b => b & 127);
  }

  // Additional data for a voice that came from a plain DX7 (no AMEM/ACED):
  // carry the DX7 AMS (0-3) over unchanged and use DX7-like defaults.
  function acedFromDx7(vced) {
    const a = initAced();
    for (let o = 0; o < 6; o++) a[A.AMS6 + o] = vced[o * 21 + OP.AMS];
    return a;
  }

  // ---- Sysex parsing -----------------------------------------------------
  // Splits a byte buffer into individual F0..F7 messages.
  function splitSysex(bytes) {
    const msgs = [];
    let start = -1;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0xF0) start = i;
      else if (bytes[i] === 0xF7 && start >= 0) { msgs.push(bytes.slice(start, i + 1)); start = -1; }
    }
    return msgs;
  }

  // Decodes a DX bulk dump message: F0 43 0n fmt cntH cntL data.. cs F7
  function parseDxBulk(m) {
    if (m.length < 8 || m[1] !== 0x43 || (m[2] & 0xF0) !== 0x00) return null;
    const fmt = m[3];
    const count = (m[4] << 7) | m[5];
    if (m.length !== count + 8) return null;
    const data = Array.from(m.slice(6, 6 + count));
    const sum = data.reduce((s, b) => s + b, 0);
    const checksumOk = ((sum + m[6 + count]) & 0x7F) === 0;
    return { fmt, data, checksumOk };
  }

  // Loads any combination of VMEM/AMEM/VCED/ACED dumps found in a buffer.
  // Returns { voices: [32 voices] | null, single: voice | null, warnings: [] }
  function parseSyxFile(bytes) {
    const res = { voices: null, single: null, warnings: [] };
    let vmem = null, amem = null, vced = null, aced = null;
    for (const m of splitSysex(bytes)) {
      const b = parseDxBulk(m);
      if (!b) continue;
      if (!b.checksumOk) res.warnings.push(`Checksum mismatch in format ${b.fmt} dump (loaded anyway)`);
      if (b.fmt === 9 && b.data.length === 4096) vmem = b.data;
      else if (b.fmt === 6 && b.data.length === 1120) amem = b.data;
      else if (b.fmt === 0 && b.data.length === 155) vced = b.data;
      else if (b.fmt === 5 && b.data.length === 49) aced = b.data;
    }
    // Raw 4096-byte cartridge images without sysex framing
    if (!vmem && bytes.length === 4096 && bytes[0] !== 0xF0) vmem = Array.from(bytes);

    if (vmem) {
      res.voices = [];
      for (let i = 0; i < 32; i++) {
        const v = vmemToVced(vmem.slice(i * 128, i * 128 + 128));
        const a = amem ? amemToAced(amem.slice(i * 35, i * 35 + 35)) : acedFromDx7(v);
        res.voices.push({ vced: v, aced: a });
      }
    }
    if (vced) {
      const v = vced.concat([63]).map((b, i) => clamp(b, VCED_MAX[i]));
      const a = aced ? aced.map((b, i) => clamp(b, ACED_MAX[i])) : acedFromDx7(v);
      res.single = { vced: v, aced: a };
    }
    return res;
  }

  function base64ToBytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---- Display helpers ---------------------------------------------------
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Yamaha naming: MIDI 60 = C3
  const noteName = midi => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 2);
  const breakPointName = bp => noteName(bp + 21);       // 0 = A-1, 39 = C3
  const transposeName = t => noteName(t + 36);          // 0 = C1, 24 = C3

  window.DX = {
    VCED_SIZE, ACED_SIZE, OP, G, A, VCED_MAX, ACED_MAX,
    newVoice, cloneVoice, initVced, initAced, getName, setName,
    vmemToVced, vcedToVmem, amemToAced, acedToAmem, acedFromDx7,
    splitSysex, parseDxBulk, parseSyxFile, base64ToBytes,
    noteName, breakPointName, transposeName,
  };
})();
