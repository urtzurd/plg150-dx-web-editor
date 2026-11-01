// Web MIDI access and PLG150-DX system exclusive message builders.
//
// Message formats (PLG150-DX Owner's Manual, "MIDI Data Format"):
//   DX parameter change      F0 43 1n gg pp vv F7            (2.1.5)
//     gg = 0ggggghh: VCED -> ggggg=0, hh = param bits 8-7; ACED -> ggggg=6
//   DX bulk dump             F0 43 0n ff ch cl data.. cs F7  (2.2.3)
//     ff: 00 VCED(155)  05 ACED(49)  06 AMEM(1120)  09 VMEM(4096)
//     cs: data + cs == 0 (mod 128)
//   PLG150-DX native param   F0 43 1n 62 ah am al vv F7      (2.1.4)
//     System:      00 00 xx
//     Multi Part:  60 pp xx  (pp = part number 0-15)
(function () {
  'use strict';

  const MODEL_NATIVE = 0x62;

  const Sysex = {
    dxParam(dev, group, param, value) {
      return [0xF0, 0x43, 0x10 | dev, (group << 2) | (param >> 7), param & 0x7F, value & 0x7F, 0xF7];
    },
    vcedParam(dev, param, value) { return this.dxParam(dev, 0, param, value); },
    acedParam(dev, param, value) { return this.dxParam(dev, 6, param, value); },

    dxBulk(dev, format, data) {
      const sum = data.reduce((s, b) => s + b, 0);
      const cs = (128 - (sum & 0x7F)) & 0x7F;
      const n = data.length;
      return [0xF0, 0x43, dev & 0x0F, format, (n >> 7) & 0x7F, n & 0x7F, ...data, cs, 0xF7];
    },
    vcedBulk(dev, vced) { return this.dxBulk(dev, 0x00, vced.slice(0, DX.VCED_SIZE)); },
    acedBulk(dev, aced) { return this.dxBulk(dev, 0x05, aced.slice(0, DX.ACED_SIZE)); },
    vmemBulk(dev, voices) {
      return this.dxBulk(dev, 0x09, voices.flatMap(v => DX.vcedToVmem(v.vced)));
    },
    amemBulk(dev, voices) {
      return this.dxBulk(dev, 0x06, voices.flatMap(v => DX.acedToAmem(v.aced)));
    },

    native(dev, hi, mid, lo, value) {
      return [0xF0, 0x43, 0x10 | dev, MODEL_NATIVE, hi, mid, lo, value & 0x7F, 0xF7];
    },
    nativeSystem(dev, addr, value) { return this.native(dev, 0x00, 0x00, addr, value); },
    nativePart(dev, part, addr, value) { return this.native(dev, 0x60, part & 0x0F, addr, value); },
  };

  class Midi {
    constructor() {
      this.access = null;
      this.output = null;
      this.onStateChange = () => {};
      this.onSend = () => {};
    }

    get supported() { return typeof navigator.requestMIDIAccess === 'function'; }

    async init() {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
      this.access.onstatechange = () => this.onStateChange();
    }

    outputs() { return this.access ? [...this.access.outputs.values()] : []; }

    selectOutput(id) {
      this.output = this.outputs().find(p => p.id === id) || null;
    }

    send(bytes, label) {
      if (!this.output) return false;
      this.output.send(bytes);
      this.onSend(bytes, label);
      return true;
    }

    // Sends messages in sequence with a gap between them, so the host and the
    // board have time to digest each bulk before the next one arrives. The gap
    // also covers the wire time of a 5-pin DIN link (~0.32 ms per byte).
    async sendSequence(list, gapMs = 120) {
      for (const [bytes, label] of list) {
        if (!this.send(bytes, label)) return false;
        await new Promise(r => setTimeout(r, gapMs + bytes.length * 0.35));
      }
      return true;
    }
  }

  window.Sysex = Sysex;
  window.Midi = Midi;
})();
