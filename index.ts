import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const RAW_EXTENSIONS = new Set([
  ".3fr", ".arw", ".cr2", ".cr3", ".dng", ".erf", ".iiq", ".kdc", ".mos",
  ".mrw", ".nef", ".nrw", ".orf", ".pef", ".raf", ".raw", ".rw2", ".rwl",
  ".srw", ".x3f",
])

const number = (minimum: number, maximum: number, description: string) => ({
  type: "number",
  minimum,
  maximum,
  description,
})

const EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    temperature: number(2000, 50000, "Camera Raw color temperature in kelvin."),
    tint: number(-150, 150, "Camera Raw green/magenta tint."),
    exposure: number(-5, 5, "Exposure in stops. Keep realistic edits near zero."),
    contrast: number(-100, 100, "Light panel contrast."),
    highlights: number(-100, 100, "Light panel highlights."),
    shadows: number(-100, 100, "Light panel shadows."),
    whites: number(-100, 100, "Light panel whites."),
    blacks: number(-100, 100, "Light panel blacks."),
    texture: number(-100, 100, "Effects panel texture."),
    clarity: number(-100, 100, "Effects panel clarity."),
    dehaze: number(-100, 100, "Effects panel dehaze."),
    vibrance: number(-100, 100, "Color panel vibrance."),
    saturation: number(-100, 100, "Color panel saturation."),
    mixer: {
      type: "object",
      additionalProperties: false,
      description: "Color Mixer HSL adjustments. Omitted channels remain neutral.",
      properties: Object.fromEntries(
        ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"].flatMap((color) =>
          ["Hue", "Saturation", "Luminance"].map((dimension) => [
            `${color}${dimension}`,
            number(-100, 100, `${color} ${dimension.toLowerCase()}.`),
          ]),
        ),
      ),
    },
    straightenDegrees: number(-45, 45, "Clockwise rotation needed to straighten the image."),
    orientation: {
      type: "string",
      enum: ["auto", "landscape", "portrait"],
      description: "Final 3:2 (6x4) or 2:3 (4x6) crop orientation.",
    },
    cropCenterX: number(0, 1, "Horizontal crop focal point, normalized from left to right."),
    cropCenterY: number(0, 1, "Vertical crop focal point, normalized from top to bottom."),
    cropScale: number(0.5, 1, "Fraction of the largest safe 3:2 crop to retain."),
    description: {
      type: "string",
      maxLength: 2000,
      description: "Objective IPTC Description based on the image and GPS-derived location. Never identify or name individual people. Omit when the image has no GPS coordinates.",
    },
    keywords: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 64 },
      description: "Concise IPTC keywords describing visible subjects. Include verified location terms only when GPS is supplied; never include names of individual people.",
    },
    inferredLocation: {
      type: "object",
      additionalProperties: false,
      description: "Use only when the source has no GPS and a visually distinctive landmark is identified with greater than 90% certainty. Verify the landmark and coordinates before supplying this object.",
      properties: {
        landmark: { type: "string", minLength: 1, maxLength: 200 },
        confidence: number(0.900001, 1, "Landmark-identification confidence. Must be strictly greater than 0.90."),
        latitude: number(-90, 90, "Verified WGS-84 latitude of the landmark."),
        longitude: number(-180, 180, "Verified WGS-84 longitude of the landmark."),
      },
      required: ["landmark", "confidence", "latitude", "longitude"],
    },
    location: {
      type: "object",
      additionalProperties: false,
      description: "Required when GPS, a verified inferred landmark, or the source Description establishes a location.",
      properties: {
        city: { type: "string", minLength: 1, maxLength: 200 },
        stateProvince: { type: "string", minLength: 1, maxLength: 200 },
        country: { type: "string", minLength: 1, maxLength: 200 },
        isoCountryCode: { type: "string", pattern: "^[A-Za-z]{3}$", description: "ISO 3166-1 alpha-3 country code used by IPTC, such as USA, CAN, GBR, or FRA." },
      },
      required: ["city", "stateProvince", "country", "isoCountryCode"],
    },
  },
} as const

type Edit = {
  temperature?: number
  tint?: number
  exposure?: number
  contrast?: number
  highlights?: number
  shadows?: number
  whites?: number
  blacks?: number
  texture?: number
  clarity?: number
  dehaze?: number
  vibrance?: number
  saturation?: number
  mixer?: Record<string, number>
  straightenDegrees?: number
  orientation?: "auto" | "landscape" | "portrait"
  cropCenterX?: number
  cropCenterY?: number
  cropScale?: number
  description?: string
  keywords?: string[]
  inferredLocation?: {
    landmark: string
    confidence: number
    latitude: number
    longitude: number
  }
  location?: {
    city: string
    stateProvince: string
    country: string
    isoCountryCode: string
  }
}

type JobEntry = {
  raw: string
  psd: string
  jpeg: string
  preview: string
  exposureBias?: number | null
  gps?: { latitude: number; longitude: number } | null
  sourceDescription?: string | null
}

type Job = {
  id: string
  folder: string
  work: string
  entries: JobEntry[]
  index: number
  overwrite: boolean
  completed: Array<{ raw: string; psd: string; jpeg: string }>
  skipped: Array<{ raw: string; reason: string }>
  group?: { type: "single" | "bracket"; indices: number[] }
  descriptions: Set<string>
  keywordSets: Set<string>
}

const jobs = new Map<string, Job>()

// @opencode/plugin's Plugin.define is an identity helper. Keeping that tiny
// helper local lets this project plugin load without a separate package install.
const definePlugin = <T>(plugin: T) => plugin

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, parsed))
}

function xml(value: string | number) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
}

function cameraRawXmp(edit: Edit) {
  const values: Record<string, string | number> = {
    Version: "17.0",
    ProcessVersion: "15.4",
    WhiteBalance: edit.temperature || edit.tint ? "Custom" : "As Shot",
    Exposure2012: clamp(edit.exposure, 0, -5, 5),
    Contrast2012: clamp(edit.contrast, 0, -100, 100),
    Highlights2012: clamp(edit.highlights, 0, -100, 100),
    Shadows2012: clamp(edit.shadows, 0, -100, 100),
    Whites2012: clamp(edit.whites, 0, -100, 100),
    Blacks2012: clamp(edit.blacks, 0, -100, 100),
    Texture: clamp(edit.texture, 0, -100, 100),
    Clarity2012: clamp(edit.clarity, 0, -100, 100),
    Dehaze: clamp(edit.dehaze, 0, -100, 100),
    Vibrance: clamp(edit.vibrance, 0, -100, 100),
    Saturation: clamp(edit.saturation, 0, -100, 100),
    RemoveChromaticAberration: 1,
    AutoLateralCA: 1,
    LensProfileEnable: 1,
    LensManualDistortionAmount: 0,
  }
  if (edit.temperature !== undefined) values.Temperature = clamp(edit.temperature, 5500, 2000, 50000)
  if (edit.tint !== undefined) values.Tint = clamp(edit.tint, 0, -150, 150)

  const colorNames: Record<string, string> = {
    red: "Red", orange: "Orange", yellow: "Yellow", green: "Green",
    aqua: "Aqua", blue: "Blue", purple: "Purple", magenta: "Magenta",
  }
  for (const [key, value] of Object.entries(edit.mixer ?? {})) {
    const match = key.match(/^(red|orange|yellow|green|aqua|blue|purple|magenta)(Hue|Saturation|Luminance)$/)
    if (!match) continue
    values[`${match[2]}Adjustment${colorNames[match[1]]}`] = clamp(value, 0, -100, 100)
  }

  const attributes = Object.entries(values)
    .map(([key, value]) => `      crs:${key}="${xml(value)}"`)
    .join("\n")

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
${attributes}/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

async function runPhotoshop(pluginDirectory: string, script: string, config: unknown, signal: AbortSignal) {
  const runner = path.join(pluginDirectory, "scripts", "invoke-photoshop.ps1")
  const scriptPath = path.join(pluginDirectory, "scripts", script)
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64")
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", runner, "-ScriptPath", scriptPath, "-ConfigBase64", encoded,
    ], { windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const abort = () => child.kill()
    signal.addEventListener("abort", abort, { once: true })
    child.once("error", reject)
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort)
      if (signal.aborted) return reject(new Error("Photo processing was cancelled."))
      if (code === 0) return resolve()
      reject(new Error((stderr || stdout || `Photoshop exited with code ${code}`).trim()))
    })
  })
}

async function makePreview(pluginDirectory: string, entry: JobEntry, signal: AbortSignal) {
  await runPhotoshop(pluginDirectory, "preview.jsx", { input: entry.raw, output: entry.preview }, signal)
  await stat(entry.preview)
}

function currentResult(job: Job, message: string) {
  const group = job.group ?? { type: "single" as const, indices: [job.index] }
  const entries = group.indices.map((index) => job.entries[index])
  const exposureSummary = entries
    .map((entry, offset) => {
      const bias = entry.exposureBias === null ? "unknown" : `${entry.exposureBias ?? 0} EV`
      const gps = entry.gps ? `; GPS ${entry.gps.latitude.toFixed(6)}, ${entry.gps.longitude.toFixed(6)}` : "; no GPS"
      const description = entry.sourceDescription ? `; source Description: ${entry.sourceDescription.slice(0, 500)}` : "; no source Description"
      return `${offset}: ${path.basename(entry.raw)} (${bias}${gps}${description})`
    })
    .join("\n")
  const metadataInstruction = entries.some((entry) => entry.gps)
    ? `Independently research this selected photo using its supplied GPS coordinates. Add an objective, photo-specific description, subject/location keywords, and verified City, State/Province, Country, and three-letter ISO Country Code. Do not reuse another photo's metadata. Never identify individual people; describe them only generically.`
    : `Independently evaluate this selected photo and its source Description, if supplied. If the source Description establishes a location, verify it and provide a photo-specific Description, keywords, City, State/Province, Country, and three-letter ISO Country Code. Otherwise, only when a distinctive landmark can be identified with greater than 90% certainty, separately verify its WGS-84 coordinates and provide inferredLocation plus those location fields. If neither condition applies, omit inferredLocation, generated description, and location fields, and add photo-specific visual-subject keywords with no guessed location. Do not reuse another photo's metadata.`
  const instruction = group.type === "bracket"
    ? `This is a five-shot bracket set. Compare all five attached previews and call raw_photo_processor_apply with selectedOffset 0-4 for the best usable exposure. Only that frame will be processed.`
    : `Analyze the attached preview, then call raw_photo_processor_apply with realistic Camera Raw values and a 3:2 crop.`
  return {
    content: [
      { type: "text", text: `${message}\nJob: ${job.id}\nSequence position ${job.index + 1} of ${job.entries.length}:\n${exposureSummary}\n${instruction}\n${metadataInstruction}` },
      ...entries.map((entry) => ({ type: "file", uri: pathToFileURL(entry.preview).href, mime: "image/jpeg", name: path.basename(entry.raw) })),
    ],
  }
}

function isZeroBias(value: number | null | undefined) {
  return typeof value === "number" && Math.abs(value) < 0.0001
}

function normalizeMetadataText(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ")
}

function keywordFingerprint(keywords: string[]) {
  return [...new Set(keywords.map(normalizeMetadataText).filter(Boolean))].sort().join("\u001f")
}

async function ensureMetadata(pluginDirectory: string, job: Job, indices: number[], signal: AbortSignal) {
  const missing = indices.filter((index) => {
    const entry = job.entries[index]
    return entry?.exposureBias === undefined || entry?.gps === undefined || entry?.sourceDescription === undefined
  })
  if (!missing.length) return
  const output = path.join(job.work, `metadata-${missing[0]}-${missing.length}.tsv`)
  await runPhotoshop(pluginDirectory, "metadata.jsx", {
    inputs: missing.map((index) => job.entries[index].raw),
    output,
  }, signal)
  const lines = (await readFile(output, "utf8")).split(/\r?\n/)
  for (const line of lines) {
    if (!line) continue
    const [positionText, biasText = "", latitudeText = "", longitudeText = "", descriptionText = ""] = line.split("\t")
    const position = Number(positionText)
    if (!Number.isInteger(position) || position < 0 || position >= missing.length) continue
    const bias = Number(biasText)
    const entry = job.entries[missing[position]]
    entry.exposureBias = biasText.trim() !== "" && Number.isFinite(bias) ? bias : null
    const latitude = Number(latitudeText)
    const longitude = Number(longitudeText)
    entry.gps = latitudeText.trim() !== "" && longitudeText.trim() !== ""
      && Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      ? { latitude, longitude }
      : null
    entry.sourceDescription = descriptionText.trim() || null
  }
  for (const index of missing) {
    if (job.entries[index].exposureBias === undefined) job.entries[index].exposureBias = null
    if (job.entries[index].gps === undefined) job.entries[index].gps = null
    if (job.entries[index].sourceDescription === undefined) job.entries[index].sourceDescription = null
  }
  await rm(output, { force: true })
}

async function prepareCurrent(pluginDirectory: string, job: Job, signal: AbortSignal) {
  let lookahead = Array.from({ length: 5 }, (_, offset) => job.index + offset)
    .filter((index) => index < job.entries.length)
  await ensureMetadata(pluginDirectory, job, lookahead, signal)

  // A non-zero run immediately before a new zero-EV frame is a partial/ending
  // bracket sequence. Ignore that run and restart at the zero-EV frame.
  if (!isZeroBias(job.entries[job.index].exposureBias)) {
    const nextZero = lookahead.slice(1).find((index) => isZeroBias(job.entries[index].exposureBias))
    if (nextZero !== undefined) {
      for (let index = job.index; index < nextZero; index += 1) {
        job.skipped.push({ raw: job.entries[index].raw, reason: "Non-zero EV frame precedes a new 0 EV sequence." })
      }
      job.index = nextZero
      lookahead = Array.from({ length: 5 }, (_, offset) => job.index + offset)
        .filter((index) => index < job.entries.length)
      await ensureMetadata(pluginDirectory, job, lookahead, signal)
    }
  }

  const bracket = lookahead.length === 5
    && isZeroBias(job.entries[lookahead[0]].exposureBias)
    && lookahead.slice(1).every((index) => {
      const bias = job.entries[index].exposureBias
      return typeof bias === "number" && !isZeroBias(bias)
    })
  job.group = { type: bracket ? "bracket" : "single", indices: bracket ? lookahead : [job.index] }
  for (const index of job.group.indices) {
    await makePreview(pluginDirectory, job.entries[index], signal)
  }
}

async function findSidecar(raw: string) {
  const directory = path.dirname(raw)
  const target = `${path.parse(raw).name}.xmp`.toLowerCase()
  const existing = (await readdir(directory)).find((name) => name.toLowerCase() === target)
  return path.join(directory, existing ?? `${path.parse(raw).name}.xmp`)
}

async function applyEdit(pluginDirectory: string, entry: JobEntry, edit: Edit, overwrite: boolean, signal: AbortSignal) {
  const sidecar = await findSidecar(entry.raw)
  let previous: Buffer | undefined
  try {
    previous = await readFile(sidecar)
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
  }

  await writeFile(sidecar, cameraRawXmp(edit), "utf8")
  try {
    const inferred = !entry.gps
      && edit.inferredLocation
      && edit.inferredLocation.confidence > 0.9
      ? edit.inferredLocation
      : undefined
    const hasLocation = Boolean(entry.gps || inferred || (entry.sourceDescription && edit.location))
    await runPhotoshop(pluginDirectory, "process.jsx", {
      input: entry.raw,
      psd: entry.psd,
      jpeg: entry.jpeg,
      overwrite,
      straightenDegrees: clamp(edit.straightenDegrees, 0, -45, 45),
      orientation: edit.orientation ?? "auto",
      cropCenterX: clamp(edit.cropCenterX, 0.5, 0, 1),
      cropCenterY: clamp(edit.cropCenterY, 0.5, 0, 1),
      cropScale: clamp(edit.cropScale, 0.96, 0.5, 1),
      description: hasLocation && typeof edit.description === "string" ? edit.description.trim() : null,
      keywords: [...new Set((edit.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean))].slice(0, 30),
      gps: inferred ? { latitude: inferred.latitude, longitude: inferred.longitude } : null,
      location: hasLocation && edit.location ? {
        city: edit.location.city.trim(),
        stateProvince: edit.location.stateProvince.trim(),
        country: edit.location.country.trim(),
        isoCountryCode: edit.location.isoCountryCode.trim().toUpperCase(),
      } : null,
    }, signal)
  } finally {
    if (previous) await writeFile(sidecar, previous)
    else await rm(sidecar, { force: true })
  }
}

async function nextUnprocessed(job: Job) {
  while (job.index < job.entries.length) {
    const entry = job.entries[job.index]
    if (job.overwrite) return entry
    let psdExists = false
    let jpegExists = false
    try { await stat(entry.psd); psdExists = true } catch {}
    try { await stat(entry.jpeg); jpegExists = true } catch {}
    if (!psdExists && !jpegExists) return entry
    job.skipped.push({ raw: entry.raw, reason: "Output already exists (overwrite=false)." })
    job.index += 1
  }
}

export default definePlugin({
  id: "raw-photo-processor",
  async setup(ctx) {
    const pluginDirectory = path.dirname(fileURLToPath(import.meta.url))
    const configuredModel = process.env.RAW_PHOTO_PROCESSOR_MODEL
      || (typeof ctx.options.model === "string" ? ctx.options.model : "openai/gpt-6-luna")
    const requested = configuredModel.split("/")
    const requestedProvider = requested.shift() ?? ""
    const requestedModel = requested.join("/")

    await ctx.command.transform((editor) => {
      editor.add({
        name: "raw-photo-processor",
        description: "Process every RAW photo in one folder into PSD and maximum-quality JPEG files.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const folder = prompt.text.trim()
          if (!folder) throw new Error("Provide one absolute folder path, for example: /raw-photo-processor C:\\Photos\\RAW")
          try {
            await ctx.session.switchModel({ sessionID, model: { providerID: requestedProvider, id: requestedModel } })
          } catch {
            await ctx.session.switchModel({ sessionID, model: { providerID: "openai", id: "gpt-5.6-terra" } })
          }
          await ctx.session.prompt({
            sessionID,
            delivery,
            text: `Run the RAW photo workflow for exactly this folder: ${JSON.stringify(folder)}. Call raw_photo_processor_start once. For each result, independently assess that photo's exposure, white balance, tonal recovery, restrained color, local contrast, horizon angle, composition, subject, and metadata; do not carry forward another photo's choices. A five-preview result is a bracket set: compare all five, choose the best exposure, and pass its 0-based selectedOffset to raw_photo_processor_apply so only that frame is processed. For every selected photo with GPS, perform a fresh lookup using its coordinates and create a unique objective Description, unique subject/location keywords, and verified City, State/Province, Country, and ISO 3166-1 alpha-3 Country Code. Without GPS, inspect the supplied source Description: if it establishes a location, freshly verify it and provide the same structured location fields and unique metadata. Otherwise separately assess whether a distinctive landmark can be identified with greater than 90% certainty; only above that threshold, perform a fresh verification lookup of the landmark and WGS-84 coordinates, provide inferredLocation, and create the same location fields and unique metadata. If no location is established, omit inferredLocation, generated Description, and location fields and create a unique visual-subject keyword set without a guessed location. Never copy a Description or complete keyword set between photos. Never identify or name individual people; use generic terms such as person, people, or crowd. Repeat until completion. Keep edits photorealistic; avoid clipping, halos, excessive saturation, and aggressive dehaze. Do not claim completion unless every image is completed or explicitly reported as skipped/failed.`,
          })
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "raw_photo_processor",
        description: "AI-guided Adobe Camera Raw and Photoshop batch processing for a single local folder.",
      })

      editor.add({
        name: "start",
        description: "Start a non-recursive RAW processing job and return the first JPEG preview for visual assessment.",
        options: { namespace: "raw_photo_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            folder: { type: "string", description: "Absolute path to the one folder containing RAW images." },
            overwrite: { type: "boolean", description: "Replace existing PSD/JPEG outputs. Defaults to false." },
          },
          required: ["folder"],
        },
        execute: async (input: any, context) => {
          const folder = path.resolve(input.folder)
          const info = await stat(folder)
          if (!info.isDirectory()) throw new Error(`Not a folder: ${folder}`)
          const names = await readdir(folder)
          const raws = names
            .filter((name) => RAW_EXTENSIONS.has(path.extname(name).toLowerCase()))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          if (!raws.length) throw new Error(`No supported RAW images were found directly in ${folder}`)

          const counts = new Map<string, number>()
          for (const raw of raws) {
            const stem = path.parse(raw).name.toLowerCase()
            counts.set(stem, (counts.get(stem) ?? 0) + 1)
          }
          const id = randomUUID()
          const work = path.join(tmpdir(), "Raw_Photo_Processor", id)
          await mkdir(work, { recursive: true })
          await mkdir(path.join(folder, "PSDs"), { recursive: true })
          await mkdir(path.join(folder, "JPEGs"), { recursive: true })
          const entries = raws.map((name, index) => {
            const parsed = path.parse(name)
            const stem = counts.get(parsed.name.toLowerCase())! > 1
              ? `${parsed.name}_${parsed.ext.slice(1).toUpperCase()}`
              : parsed.name
            return {
              raw: path.join(folder, name),
              psd: path.join(folder, "PSDs", `${stem}.psd`),
              jpeg: path.join(folder, "JPEGs", `${stem}.jpg`),
              preview: path.join(work, `${String(index + 1).padStart(5, "0")}.jpg`),
            }
          })
          const job: Job = {
            id,
            folder,
            work,
            entries,
            index: 0,
            overwrite: input.overwrite === true,
            completed: [],
            skipped: [],
            descriptions: new Set(),
            keywordSets: new Set(),
          }
          jobs.set(id, job)
          try {
            await nextUnprocessed(job)
            if (job.index >= job.entries.length) {
              jobs.delete(id)
              await rm(work, { recursive: true, force: true })
              return { content: `Nothing to process. ${job.skipped.length} image(s) skipped because outputs already exist.` }
            }
            await context.progress({ status: `Reading metadata and creating preview(s) at image 1 of ${entries.length}` })
            await prepareCurrent(pluginDirectory, job, context.signal)
            return currentResult(job, `Found ${entries.length} RAW image(s). Existing outputs are ${job.overwrite ? "replaced" : "skipped"}.`)
          } catch (error) {
            jobs.delete(id)
            await rm(work, { recursive: true, force: true })
            throw error
          }
        },
      })

      editor.add({
        name: "apply",
        description: "Apply visually selected Camera Raw settings, optics corrections, straightening, and a 3:2 crop; save PSD and JPEG; then return the next preview.",
        options: { namespace: "raw_photo_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobID: { type: "string" },
            selectedOffset: { type: "integer", minimum: 0, maximum: 4, description: "For a five-shot bracket set, the 0-based preview offset with the best exposure. Use 0 for a normal single image." },
            edit: EDIT_SCHEMA,
          },
          required: ["jobID", "edit"],
        },
        execute: async (input: { jobID: string; selectedOffset?: number; edit: Edit }, context) => {
          const job = jobs.get(input.jobID)
          if (!job) throw new Error("Unknown or completed RAW processing job.")
          const group = job.group ?? { type: "single" as const, indices: [job.index] }
          const selectedOffset = group.type === "bracket" ? input.selectedOffset : 0
          if (group.type === "bracket" && (!Number.isInteger(selectedOffset) || selectedOffset! < 0 || selectedOffset! > 4)) {
            throw new Error("Select the best bracket exposure with selectedOffset 0-4.")
          }
          const selectedIndex = group.indices[selectedOffset ?? 0]
          const entry = job.entries[selectedIndex]
          const keywords = [...new Set((input.edit.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean))]
          if (!keywords.length) throw new Error("Provide at least one non-identifying subject keyword for the selected image.")
          const inferred = input.edit.inferredLocation
          if (inferred && entry.gps) {
            throw new Error("Do not infer landmark GPS when the source already contains GPS coordinates.")
          }
          if (inferred && (!(inferred.confidence > 0.9) || !Number.isFinite(inferred.latitude) || !Number.isFinite(inferred.longitude))) {
            throw new Error("Inferred landmark location requires confidence greater than 0.90 and valid verified coordinates.")
          }
          const location = input.edit.location
          const descriptionLocation = Boolean(entry.sourceDescription?.trim() && location)
          const hasKnownLocation = Boolean(entry.gps || inferred || descriptionLocation)
          if ((entry.gps || inferred) && !location) {
            throw new Error("A GPS-based location requires City, State/Province, Country, and ISO Country Code.")
          }
          if (location) {
            const fields = [location.city, location.stateProvince, location.country, location.isoCountryCode]
            if (fields.some((field) => typeof field !== "string" || !field.trim())) {
              throw new Error("Location metadata requires non-empty City, State/Province, Country, and ISO Country Code fields.")
            }
            if (!/^[A-Za-z]{3}$/.test(location.isoCountryCode.trim())) {
              throw new Error("ISO Country Code must be an ISO 3166-1 alpha-3 code such as USA, CAN, GBR, or FRA.")
            }
            if (!entry.gps && !inferred && !entry.sourceDescription?.trim()) {
              throw new Error("Do not add location fields without source GPS, a verified inferred landmark, or a source Description establishing the location.")
            }
          }
          if (hasKnownLocation && !input.edit.description?.trim()) {
            throw new Error("A source or confidently inferred location is available; provide a location-informed, non-identifying description.")
          }
          const descriptionFingerprint = input.edit.description?.trim()
            ? normalizeMetadataText(input.edit.description)
            : undefined
          const keywordsFingerprint = keywordFingerprint(keywords)
          if (descriptionFingerprint && job.descriptions.has(descriptionFingerprint)) {
            throw new Error("This Description duplicates an earlier processed photo. Reassess this image and provide a unique, photo-specific Description.")
          }
          if (job.keywordSets.has(keywordsFingerprint)) {
            throw new Error("This complete keyword set duplicates an earlier processed photo. Reassess this image and provide a unique, photo-specific keyword set.")
          }
          await context.progress({ status: `Processing selected exposure ${path.basename(entry.raw)} (${selectedIndex + 1}/${job.entries.length})` })
          await applyEdit(pluginDirectory, entry, input.edit, job.overwrite, context.signal)
          if (descriptionFingerprint) job.descriptions.add(descriptionFingerprint)
          job.keywordSets.add(keywordsFingerprint)
          job.completed.push({ raw: entry.raw, psd: entry.psd, jpeg: entry.jpeg })
          if (group.type === "bracket") {
            for (const index of group.indices) {
              if (index !== selectedIndex) job.skipped.push({ raw: job.entries[index].raw, reason: `Bracket alternate; selected ${path.basename(entry.raw)}.` })
            }
          }
          job.index = group.indices[group.indices.length - 1] + 1
          job.group = undefined
          await nextUnprocessed(job)
          if (job.index >= job.entries.length) {
            jobs.delete(job.id)
            await rm(job.work, { recursive: true, force: true })
            return {
              content: `RAW processing complete. Created ${job.completed.length} PSD/JPEG pair(s); skipped ${job.skipped.length}.\nPSD files: ${path.join(job.folder, "PSDs")}\nJPEG files: ${path.join(job.folder, "JPEGs")}`,
            }
          }
          await context.progress({ status: `Reading metadata and creating preview(s) at image ${job.index + 1} of ${job.entries.length}` })
          await prepareCurrent(pluginDirectory, job, context.signal)
          return currentResult(job, `Saved ${path.basename(entry.psd)} and JPEGs/${path.basename(entry.jpeg)}.`)
        },
      })

      editor.add({
        name: "cancel",
        description: "Cancel a RAW processing job and delete its temporary previews.",
        options: { namespace: "raw_photo_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: { jobID: { type: "string" } },
          required: ["jobID"],
        },
        execute: async (input: { jobID: string }) => {
          const job = jobs.get(input.jobID)
          if (!job) return { content: "Job is already completed, cancelled, or unknown." }
          jobs.delete(input.jobID)
          await rm(job.work, { recursive: true, force: true })
          return { content: `Cancelled job ${input.jobID}. Completed output files were retained.` }
        },
      })
    })

    return async () => {
      await Promise.all([...jobs.values()].map((job) => rm(job.work, { recursive: true, force: true })))
      jobs.clear()
    }
  },
})
