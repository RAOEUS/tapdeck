# Tapdeck Privacy Policy

Last updated: 2026-11-07

Tapdeck does not collect, store, transmit, or sell any personal data. There
are no accounts, no analytics, no telemetry, no advertising, and no third-party
tracking of any kind.

## What the extension does with data

- **Tab audio.** When you click "Start on this tab", Tapdeck captures that tab's
  audio, processes it inside your browser, and plays it back through your
  speakers. The audio never leaves your computer and is not recorded or saved.
- **Settings.** Your effect chains, presets, and the default chain for new tabs
  are saved in your browser's local extension storage (`chrome.storage.local`)
  so they survive restarts. They stay on your machine and are removed when you
  uninstall the extension.
- **Tab titles.** Tapdeck reads the titles of the tabs it is processing so it
  can label them in its interface. Titles are not stored or transmitted.

## Network requests

The only network request Tapdeck makes is when you use the **Headphone EQ**
feature. It downloads the headphone list and the correction profile you choose
from the public AutoEq project on GitHub
(`https://raw.githubusercontent.com/jaakkopasanen/AutoEq/`). These are plain
text files. No information about you is sent with the request beyond what any
ordinary web download sends (your IP address, as seen by GitHub). The headphone
list is cached locally so it isn't downloaded every time.

If you never use Headphone EQ, Tapdeck makes no network requests at all.

## Changes

If this policy ever changes, the new version will be published in this
repository with an updated date. There are no plans to collect any data.

## Contact

Open an issue on the project's repository.
