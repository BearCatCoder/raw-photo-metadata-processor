# Raw Photo Metadata Processor

An OpenCode V2 plugin that uses image recognition and Adobe XMP to update **metadata only** for RAW, PSD, and JPEG images on Windows. It is based on [`BearCatCoder/raw-photo-processor`](https://github.com/BearCatCoder/raw-photo-processor), with all pixel editing, Camera Raw adjustment, cropping, and output rendering removed.

## Use

Install this directory as `.opencode/plugins/raw-photo-metadata-processor`, restart OpenCode, then run:

```text
/raw-photo-metadata-processor C:\absolute\path\to\images
```

The folder is scanned non-recursively. Supported files with the same basename are treated as renditions of one asset (for example, `DSC001.ARW`, `DSC001.psd`, and `DSC001.jpg`). The model analyzes that asset once and writes identical descriptive metadata to every rendition.

The command defaults to `openai/gpt-6-luna` and falls back to `openai/gpt-5.6-terra`. To select another model before restarting OpenCode:

```powershell
$env:RAW_PHOTO_METADATA_PROCESSOR_MODEL = "openai/gpt-5.6-terra"
opencode service restart
```

## Metadata workflow

For each asset, the plugin:

1. Reads existing GPS, Description, and Creator metadata without changing the image.
2. Creates a temporary, maximum-1600-pixel JPEG preview for model vision. The preview is deleted when the job ends.
3. Independently identifies and researches the image.
4. Writes photo-specific IPTC Description and keywords.
5. Applies the baseline's location rules:
   - no identification of individual people;
   - any named place requires a verified location and complete City, State/Province, Country, and ISO Country Code;
   - Sublocation requires image-recognition confidence strictly above 90%;
   - without source GPS or Description, inferred landmark coordinates require independently verified confidence above 90%; and
   - coordinates are never placed in Description.
6. Assigns **all applicable codes** from the complete active IPTC Scene-NewsCodes vocabulary (`010100` through `012400`).
7. Searches the complete locally bundled IPTC Subject NewsCodes vocabulary and assigns every applicable active eight-digit Subject Code. The local catalog contains all 1,404 entries, including 17 retired entries retained for completeness but blocked from assignment.
8. Preserves Creator and an existing copyright notice. When Creator exists but the notice is blank, it adds `Copyright (c) <Creator>. All rights reserved.`, marks the work copyrighted, and writes creator-specific XMP Usage Terms.

Every photo is identified independently. Descriptions and keywords may repeat when the independently observed content genuinely supports the same wording or terms.

## File writing behavior

- **PSD and JPEG:** XMP is updated in place through Adobe XMP; image pixels are not decoded and re-saved.
- **DNG and supported RAW containers:** metadata is embedded when Adobe's installed XMP handler permits safe updates.
- **Proprietary RAW:** when embedding is unsupported, Adobe-compatible `<basename>.xmp` sidecars are written. If a sidecar already exists, its values and Camera Raw settings are preserved: absent scalar fields are filled and missing keywords, Scene codes, and Subject codes are merged into their existing arrays.

Existing metadata outside the fields managed by this plugin is preserved. Source GPS is retained; verified inferred GPS is added only when source GPS is absent.

## Local IPTC vocabularies

- Scene NewsCodes: all 24 active codes are embedded in the plugin.
- Subject NewsCodes: `data/iptc-subject-codes.json` contains all 1,404 official English entries from the IPTC controlled-vocabulary server under CC BY 4.0.

The Subject Code vocabulary is deprecated by IPTC in favor of Media Topics, but it is included because this plugin explicitly supports the legacy `Iptc4xmpCore:SubjectCode` field. During each asset workflow, the model must search the local catalog before submitting metadata. Returned codes are validated against the bundled active-code set before they are written.

## Supported inputs

- RAW: 3FR, ARW, CR2, CR3, DNG, ERF, IIQ, KDC, MOS, MRW, NEF, NRW, ORF, PEF, RAF, RAW, RW2, RWL, SRW, and X3F
- PSD
- JPG and JPEG

## Requirements

- Windows
- Adobe Photoshop with AdobeXMPScript
- Adobe Camera Raw support for any proprietary RAW formats being previewed

Photoshop remains visible during preview and metadata bridge calls. Do not interact with it while a batch is active. Cancellation is reserved for an explicit user request.
