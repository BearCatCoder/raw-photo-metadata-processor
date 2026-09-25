# Raw Photo Processor

An OpenCode V2 plugin for AI-guided, non-recursive processing of one folder of RAW photos with Adobe Camera Raw and Adobe Photoshop on Windows.

## Use

Restart OpenCode after installation, then run:

```text
/raw-photo-processor C:\absolute\path\to\raws
```

The command defaults to `openai/gpt-6-luna` and falls back to `openai/gpt-5.6-terra` if Luna is unavailable. The model examines a temporary JPEG preview of each photo and selects restrained Camera Raw values, straightening, and a 3:2 or 2:3 crop. The plugin then creates:

- `<source folder>\PSDs\<name>.psd`
- `<source folder>\JPEGs\<name>.jpg` (8 Bits/Channel, JPEG quality 12)

Existing outputs are skipped by default. The RAW file is never modified. A temporary `.xmp` sidecar is used to pass settings to Camera Raw; an existing sidecar is restored byte-for-byte after the RAW is opened.

Before processing, the plugin reads the Exposure Bias metadata up to five images ahead. A `0 EV` image followed by four non-zero-EV images is treated as one bracket set. The model compares all five previews, processes only the best exposure, and skips the other four. Non-zero frames encountered shortly before a new `0 EV` image are treated as an incomplete bracket run and skipped.

When GPS coordinates are present, they are shown to the model so it can research the general subject/location and write an objective IPTC Description plus relevant subject and location keywords. The model is explicitly prohibited from identifying individual people.

Without source GPS, a landmark fallback is permitted only when the model can identify a distinctive landmark with greater than 90% certainty. The model must verify the landmark's WGS-84 coordinates; the plugin then embeds those coordinates in the PSD/JPEG XMP metadata and writes the location-aware Description and keywords. Below that threshold, it writes visual-subject keywords only, does not guess a location, and leaves the generated Description empty.

Whenever a location is established from source GPS, a verified landmark, or an existing source Description, the plugin also writes City, State/Province, Country, and the IPTC three-letter ISO Country Code into both output formats.

When source metadata contains a Creator, the plugin preserves any existing Copyright Notice or fills an empty notice with `Copyright (c) <Creator>. All rights reserved.` It marks the output as Copyrighted and writes XMP Rights and Usage Terms stating that the Creator retains all rights. These protections are embedded in both PSD and JPEG outputs.

Every processed photo is independently analyzed and, when a location is available or confidently inferred, independently researched. Descriptions and complete keyword sets must be photo-specific. The plugin rejects an exactly reused Description or identical complete keyword set within the same batch, while allowing individual relevant terms such as a shared city or `landscape` to overlap.

## Select Terra instead

Set this environment variable before starting or restarting the OpenCode service:

```powershell
$env:RAW_PHOTO_PROCESSOR_MODEL = "openai/gpt-5.6-terra"
opencode service restart
```

No project configuration entry is required because OpenCode automatically discovers the plugin under `.opencode/plugins`.

## Notes

- Supported formats include ARW, CR2/CR3, DNG, NEF, RAF, ORF, RW2, and other common proprietary RAW extensions.
- Camera Raw must support the camera's file format and lens profile. `Remove Chromatic Aberration` and `Use Profile Corrections` are requested for every image; profile correction depends on an installed/matched Adobe lens profile.
- Photoshop remains visible while the COM automation runs. Do not interact with it during a batch.
- “Open as Copy” is implemented non-interactively by opening the RAW with its temporary XMP into a new, unsaved Photoshop document. The source RAW and prior sidecar remain unchanged.
