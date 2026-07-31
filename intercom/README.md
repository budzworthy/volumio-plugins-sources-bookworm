# Intercom — Phone-to-Volumio broadcast plugin

> **One-way intercom:** stream your phone microphone to Volumio in near real time,
> interrupting any current playback. Playback is automatically restored when the
> broadcast ends.

---

## What it does

The Intercom plugin starts a lightweight HTTP + WebSocket server directly on your
Volumio device. Open the intercom page on any phone (or laptop) that is on the
same Wi-Fi network, press **Start**, grant microphone permission, and your voice
(or any audio captured by the microphone) is streamed live to the Volumio speaker.

While the broadcast is active:

* Current Volumio playback is **stopped** so the intercom audio can be heard.
* Audio is received as raw 16-bit PCM and piped to the `aplay` ALSA player using
  Volumio's virtual audio device (`volumio`), providing low-latency output.

When the broadcast is stopped (or the browser page is closed/navigated away):

* `aplay` is terminated, releasing the ALSA device.
* If **Auto-Resume** is enabled (default), Volumio calls `volumioPlay()` to
  resume the previous queue position.

---

## How to use from your phone

1. **Install and enable** the Intercom plugin in Volumio → Plugins → System Controllers.
2. Find your Volumio device's IP address (shown in Volumio Settings → Network).
3. On your phone, open a browser and go to:

   ```
   http://<volumio-ip>:8096
   ```

   *(Replace `8096` with your configured port if you changed it.)*

4. Tap **Start** and grant microphone permission when prompted.
5. Speak — audio plays on the Volumio speaker immediately.
6. Tap **Stop** (or close the tab) to end the broadcast.

The intercom page is mobile-friendly and works on iOS Safari, Chrome for Android,
and most modern desktop browsers.

---

## Plugin settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Web Server Port** | `8096` | Port for the intercom web page and WebSocket stream. Must be > 1024 and < 65535. |
| **Audio Gain** | `1.0` | Volume multiplier applied server-side to the incoming PCM (0.1 – 5.0). Increase if the phone microphone is too quiet. |
| **Auto-Resume Playback** | `on` | Resume Volumio playback when the broadcast ends. |
| **Sample Rate** | `16000 Hz` | Audio sample rate. 16 kHz is recommended for voice; higher rates improve music quality at the cost of more network bandwidth. |

---

## Network & security

* **Same LAN only.** The intercom server listens on `0.0.0.0` (all interfaces)
  but is designed for trusted local-network use only.
* **No authentication.** Anyone on the same network who knows the IP and port can
  open the intercom page and start a broadcast. Do not expose the port to the
  internet without additional protection (reverse proxy with auth, firewall rule,
  etc.).
* Browser microphone access requires either `localhost` or an HTTPS origin.
  Over plain `http://` on a LAN, most Android browsers and Firefox will still
  prompt for permission, but iOS Safari ≥ 16 requires HTTPS for
  `getUserMedia`. If you see a "not supported" error on iOS, consider setting
  up a local reverse proxy with a self-signed certificate.

---

## Limitations

* **One broadcast at a time.** If a second device opens the page and tries to
  start while a broadcast is already active, it receives a "busy" message.
* **Auto-resume is best-effort.** It works reliably for MPD (local library,
  web radio added via the queue). Services such as Spotify or YouTube may or may
  not resume depending on whether their Volumio plugin re-queues the last track.
* **iOS Safari HTTP caveat** — see the note in Network & security above.
* The plugin uses `aplay` with the `volumio` ALSA device. If Volumio is
  configured to use a non-standard audio device, or if MPD does not release the
  device promptly after `volumioStop()`, the broadcast may fail to open the
  device. A 500 ms grace delay is built in; increase it by adjusting the
  `setTimeout` in `index.js` if you experience device-busy errors.

---

## Planned: listen / talkback (two-way mode)

The plugin is architected so a listen/talkback channel can be added with minimal
refactoring:

* `capabilities.supportsListen` is already exposed in the `/status` JSON
  endpoint and documented in `index.js`.
* TODO comments in `index.js` and `ui/index.html` mark the exact extension
  points for the reverse channel (Volumio mic → phone).
* The sender pipeline (phone → speaker) is fully self-contained in
  `_startBroadcast / _stopBroadcast / _spawnAplay` and will not need to change
  when the listen path is added.

To implement two-way mode in a future release:

1. Detect a capture device (`arecord -l`) at `onStart` and set
   `capabilities.supportsListen = true`.
2. Add a `/listen` WebSocket endpoint that streams `arecord` stdout to the
   connected phone.
3. On the phone UI, decode the incoming PCM and play it via a Web Audio
   `AudioBufferSourceNode`.
4. Expose a "Enable Listen" toggle in `UIConfig.json` that is only visible when
   `supportsListen` is true.

---

## Changelog

* **v1.0.0** — Initial release: one-way broadcast, playback interrupt, best-effort
  restore, configurable port/gain/sample-rate, mobile-friendly UI.
