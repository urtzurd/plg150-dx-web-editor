# PLG150-DX Web Editor

Browser editor/librarian for the Yamaha PLG150-DX plug-in board in a Modular Synthesis
Plug-in host synth. It talks to the board with the **DX** and **PLG150-DX Native** SysEx
messages.

You can use it directly at this link: https://urtzurd.github.io/plg150-dx-web-editor/

## Running

The editor needs Web MIDI with SysEx access:

- **Chrome or Edge**: open `index.html` directly, or serve the folder (below).
- **Firefox** (108 or later) should also work, but only from a served page (not
  `file://`), and it asks you to install a site permission add-on to grant MIDI access.
  Not tested.
- **Safari** has no Web MIDI and is not supported.

To serve the folder: `python3 -m http.server 8150`, then open http://localhost:8150

Click **Enable MIDI** and allow SysEx access. Then pick the MIDI Out port connected to the host
synth, the Device ID (must match the Device Number set on the host synth), the keyboard
channel (the host synth's receive channel for the PLG150-DX part) and the PLG Part.

## Messages sent

| Action | Message |
|---|---|
| Edit a voice parameter (Live edit on) | DX parameter change `F0 43 1n gg pp vv F7` (VCED g=0, ACED g=6) |
| Send Voice (edit buffer) | ACED bulk (fmt 05, 49 bytes), VCED bulk (fmt 00, 155 bytes), then the operator on/off parameter (VCED 155) |
| Send Bank | Native `00 00 0E` (32-voice receive block), AMEM (fmt 06, if **+ AMEM** is checked), VMEM (fmt 09) |
| Native tab | `F0 43 1n 62 00 00 xx vv F7` (system), `F0 43 1n 62 60 pp xx vv F7` (part) |
| Keyboard / wheels | Note on/off, pitch bend, CC1, CC64 on the keyboard channel |
| Panic | CC120 (All Sound Off), CC123 (All Notes Off), CC121 (Reset Controllers) |

## On the host synth

- **RcvDxSysEx** must be ON (in the board's part settings, or on the Native tab).
- The VCED/ACED edit buffer is only heard when a **PLG150-DX user voice** is selected
  (the manual: "Bulk select: User Bank"). Select a PLG user voice on the host synth first.
- **Send Bank** writes 32 voices into PLG user voices 1–32 or 33–64. Store them on the
  host synth as described in its manual if you want to keep them.
- The board can't send its data back, so the editor works from its own copy: the DX7 ROM
  cartridges (built in) and `.syx` files you open. No MIDI input is used.

## Files

- `index.html`, `css/style.css`: the UI
- `js/dx7.js`: voice model and VMEM/VCED/AMEM/ACED conversion
- `js/midi.js`: Web MIDI and SysEx builders
- `js/graphics.js`: algorithm diagrams and EG graphs
- `js/app.js`: the app
- `js/roms.js`: the eight `rom*.syx` banks, embedded (generated). ROM1A–2B are the
  EU/JP factory set and ROM3A–4B the US set, per
  [Yamaha Black Boxes](https://yamahablackboxes.com/collection/yamaha-dx7-synthesizer/patches/#factory).

Cartridges you change or load are kept in the browser's localStorage. Use **Save .syx**
to keep them as files. Saved files are VMEM followed by AMEM, which DX7 tools can read.
**Export** saves the current voice as a single-voice VCED + ACED `.syx` file.

## Changelog

- 1/Nov/2026: First version of the editor.
