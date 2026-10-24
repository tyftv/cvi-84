# CVI-84

A field-accurate emulation of the 1984 Fairlight **Computer Video Instrument**, plus CRT, VHS, halftone and black-and-white looks. Two versions:

- **Web app** (`web/`): load a video, play the CVI live, record automation, export an MP4. No install, no build step.
- **Premiere Pro plugin** (`premiere/`): the same engine as a keyframable video effect.

## How faithful is it?

Built from the original manuals (1985 Rev 5 dealer manual, 1984 preliminary manual, 1988 Video Entertainer manual):

- **Field store**: 256 × 256 pixels, 4 bits per R/G/B (4096 colours), 1-bit stencil plane. The chunky pixels are the real resolution.
- **Four planes**: Analog (untouched, full resolution), Digital (digitised + colourized), Store (frame buffer), Mix (store + analog double exposure). The 20 **Display Control** routings (Paint, Trail, Ghost, Colour trail, Catch-up, Crawl, Cascade…) decide what each stencil region shows and whether it updates the store. Trails, ghosts and catch-up come from those routings, not filters.
- **Colourize**: a live 4096-entry palette remap, 8 types (Tint, Translucent, Shade, Range, Solarize, Monochrome, Contour, Spectrum) driven by Hue/Sat/Value and the bipolar Colour Depth fader. Control by sliders, HSV fix, music or random.
- **Freeze control**: continuous, strobe, burst, single, music (grabs on bass peaks), external.
- **Screen control**: vertical/horizontal/quad mirror, horizontal/vertical wipe, shatter, pan:pen, glide, slide. Zoom on live video = mosaic; stretch = one-axis pixelation.
- **Stencils**: internal (drawn or wiped, rides the store's pan/zoom), external key, chroma key (live, stays put), under-over. Use/invert stencil.
- **Paint**: 10 methods (draw, dots, rubber band, circle, ellipse, rectangle, rays, cut & paste, fill, copy), 16 brushes, 6 paint types, 16 textures, 9 colour types, 9 symmetry modes, dejag, title text with 6 formats.
- **Wipes**: 8 colour wipes (incl. colour tunnel and disintegrate), 9 stencil wipes (incl. edge detect, colour detect and slow-scan wipes at one column per field).
- **50 Hz field clock** (60 Hz NTSC option): rates, strobes and wipes advance per field like the hardware.
- **Presets**: the factory list 00–99 by number and name. PRESET + two digits loads, PRESET + FREEZE saves over the current number.
- **Sequencer**: replaced by DAW-style automation recording (touch mode) that also records paint strokes and button presses.

Not emulated: the RS232 port and true two-machine Cascade (the Cascade planes feed the CVI's own output back in, which is what a second CVI on the same settings would give you).

## Web app

Open `web/index.html` from any static host (GitHub Pages deploys it automatically from `main`). Needs a current Chrome or Edge for MP4 export (WebCodecs); Safari works for playing.

Keys: **Space** play/pause, hold **D** to draw, **M** menu, **P** + two digits = preset, **F** freeze, **Esc** stop, **R** arm recording.

Recording: arm ● and play from 0:00. Every fader, button, menu choice, preset, wipe and paint stroke is written against the tape. Faders you aren't touching play back their recording. Export starts from the state you had when the tape rolled and replays the automation exactly.

## Premiere Pro plugin

See [`premiere/README.md`](premiere/README.md).

## Credits

MP4 encoding by [Mediabunny](https://mediabunny.dev) (MPL-2.0, vendored in `web/vendor/`). Fairlight is a trademark of Blackmagic Design; this project is not affiliated with it.
