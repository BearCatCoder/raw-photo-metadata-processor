import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const RAW_EXTENSIONS = new Set([
  ".3fr", ".arw", ".cr2", ".cr3", ".dng", ".erf", ".iiq", ".kdc", ".mos",
  ".mrw", ".nef", ".nrw", ".orf", ".pef", ".raf", ".raw", ".rw2", ".rwl",
  ".srw", ".x3f",
])
const PSD_EXTENSIONS = new Set([".psd"])
const JPEG_EXTENSIONS = new Set([".jpg", ".jpeg"])
const SUPPORTED_EXTENSIONS = new Set([...RAW_EXTENSIONS, ...PSD_EXTENSIONS, ...JPEG_EXTENSIONS])

// Complete active IPTC Scene-NewsCodes vocabulary, verified against
// https://cv.iptc.org/newscodes/scene/
const IPTC_SCENES = {
  "010100": "headshot", "010200": "half-length", "010300": "full-length", "010400": "profile",
  "010500": "rear view", "010600": "single", "010700": "couple", "010800": "two",
  "010900": "group", "011000": "general view", "011100": "panoramic view", "011200": "aerial view",
  "011300": "under-water", "011400": "night scene", "011500": "satellite", "011600": "exterior view",
  "011700": "interior view", "011800": "close-up", "011900": "action", "012000": "performing",
  "012100": "posing", "012200": "symbolic", "012300": "off-beat", "012400": "movie scene",
} as const
const IPTC_SCENE_CODES = new Set<string>(Object.keys(IPTC_SCENES))
const IPTC_SCENE_CATALOG = Object.entries(IPTC_SCENES).map(([code, name]) => `${code} ${name}`).join("; ")

type SubjectCodeEntry = {
  code: string
  name: string
  definition: string
  broader: string | null
  retired: boolean
}

type SubjectCodeCatalog = {
  source: string
  scheme: string
  released: string
  license: string
  entries: SubjectCodeEntry[]
}

const number = (minimum: number, maximum: number, description: string) => ({
  type: "number", minimum, maximum, description,
})

const METADATA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: {
      type: "string",
      maxLength: 2000,
      description: "Objective IPTC Description based on this image and a verified location. Never include coordinates or identify individual people. Omit when exact location is unverified.",
    },
    keywords: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 64 },
      description: "Concise, photo-specific IPTC keywords. Place names require a verified location and complete location fields. Never identify individual people.",
    },
    locationDecision: {
      type: "string",
      enum: ["verified", "unverified"],
      description: "Use verified whenever any place is named. Use unverified only when no exact place can be established and no place names are emitted.",
    },
    iptcSceneCodes: {
      type: "array",
      maxItems: Object.keys(IPTC_SCENES).length,
      uniqueItems: true,
      items: { type: "string", enum: Object.keys(IPTC_SCENES) },
      description: "Every applicable official IPTC Scene-NewsCode from the complete supplied catalog. Include all that apply; use an empty array only when none can be assigned confidently.",
    },
    iptcSubjectCodes: {
      type: "array",
      maxItems: 30,
      uniqueItems: true,
      items: { type: "string", pattern: "^\\d{8}$" },
      description: "Every applicable active eight-digit IPTC Subject NewsCode found with the bundled local catalog search. Prefer the most specific applicable codes and include their broader codes when useful.",
    },
    inferredLocation: {
      type: "object",
      additionalProperties: false,
      description: "Only when source GPS is absent and a distinctive landmark is independently identified above 90% confidence.",
      properties: {
        landmark: { type: "string", minLength: 1, maxLength: 200 },
        confidence: number(0.900001, 1, "Landmark-identification confidence; strictly greater than 0.90."),
        latitude: number(-90, 90, "Verified WGS-84 latitude."),
        longitude: number(-180, 180, "Verified WGS-84 longitude."),
      },
      required: ["landmark", "confidence", "latitude", "longitude"],
    },
    location: {
      type: "object",
      additionalProperties: false,
      description: "Verified structured location. Omit when the exact location cannot be established.",
      properties: {
        sublocation: { type: "string", minLength: 1, maxLength: 200 },
        sublocationConfidence: number(0.900001, 1, "Image-recognition confidence for Sublocation; strictly greater than 0.90."),
        city: { type: "string", minLength: 1, maxLength: 200 },
        stateProvince: { type: "string", minLength: 1, maxLength: 200 },
        country: { type: "string", minLength: 1, maxLength: 200 },
        isoCountryCode: { type: "string", pattern: "^[A-Za-z]{3}$" },
      },
      required: ["city", "stateProvince", "country", "isoCountryCode"],
    },
  },
  required: ["keywords", "locationDecision", "iptcSceneCodes", "iptcSubjectCodes"],
} as const

type Metadata = {
  description?: string
  keywords: string[]
  locationDecision: "verified" | "unverified"
  iptcSceneCodes: string[]
  iptcSubjectCodes: string[]
  inferredLocation?: { landmark: string; confidence: number; latitude: number; longitude: number }
  location?: {
    sublocation?: string
    sublocationConfidence?: number
    city: string
    stateProvince: string
    country: string
    isoCountryCode: string
  }
}

type Asset = {
  stem: string
  files: string[]
  representative: string
  preview: string
  gps?: { latitude: number; longitude: number } | null
  sourceDescription?: string | null
  creator?: string | null
  subjectSearchCount?: number
}

type Job = {
  id: string
  sessionID: string
  folder: string
  work: string
  assets: Asset[]
  index: number
  completed: Array<{ stem: string; files: string[]; storage: string[] }>
}

const jobs = new Map<string, Job>()
const sessionJobs = new Map<string, string>()
const definePlugin = <T>(plugin: T) => plugin

function normalizeMetadataText(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ")
}

function descriptionContainsCoordinates(value: string) {
  return /\b(?:latitude|longitude|gps\s*coordinates?)\b/i.test(value)
    || /[-+]?\d{1,2}\.\d{3,}\s*[,;/]\s*[-+]?\d{1,3}\.\d{3,}/.test(value)
    || /\d+(?:\.\d+)?\s*°\s*(?:[NS]|north|south)|\d+(?:\.\d+)?\s*°\s*(?:[EW]|east|west)/i.test(value)
}

function sidecarFor(file: string) {
  return path.join(path.dirname(file), `${path.parse(file).name}.xmp`)
}

function representativeRank(file: string) {
  const extension = path.extname(file).toLowerCase()
  if (JPEG_EXTENSIONS.has(extension)) return 0
  if (PSD_EXTENSIONS.has(extension)) return 1
  return 2
}

function metadataRank(file: string) {
  const extension = path.extname(file).toLowerCase()
  if (RAW_EXTENSIONS.has(extension)) return 0
  if (PSD_EXTENSIONS.has(extension)) return 1
  return 2
}

function subjectSearchScore(entry: SubjectCodeEntry, query: string) {
  const normalizedQuery = normalizeMetadataText(query)
  const name = normalizeMetadataText(entry.name)
  const definition = normalizeMetadataText(entry.definition)
  if (!normalizedQuery) return 0
  let score = name === normalizedQuery ? 200 : name.includes(normalizedQuery) ? 100 : 0
  for (const term of normalizedQuery.split(/[^a-z0-9]+/).filter((item) => item.length > 1)) {
    if (name.split(/[^a-z0-9]+/).includes(term)) score += 20
    else if (name.includes(term)) score += 10
    if (definition.includes(term)) score += 3
  }
  return score
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
      if (signal.aborted) return reject(new Error("Metadata update was cancelled."))
      if (code === 0) return resolve()
      reject(new Error((stderr || stdout || `Photoshop exited with code ${code}`).trim()))
    })
  })
}

async function prepareAsset(pluginDirectory: string, job: Job, signal: AbortSignal) {
  const asset = job.assets[job.index]
  const metadataOutput = path.join(job.work, `metadata-${job.index}.tsv`)
  await runPhotoshop(pluginDirectory, "metadata.jsx", {
    inputs: [...asset.files].sort((a, b) => metadataRank(a) - metadataRank(b)),
    output: metadataOutput,
  }, signal)
  const lines = (await readFile(metadataOutput, "utf8")).split(/\r?\n/)
  for (const line of lines) {
    if (!line) continue
    const [, latitudeText = "", longitudeText = "", descriptionText = "", creatorText = ""] = line.split("\t")
    const latitude = Number(latitudeText)
    const longitude = Number(longitudeText)
    if (!asset.gps && latitudeText && longitudeText && Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      asset.gps = { latitude, longitude }
    }
    if (!asset.sourceDescription && descriptionText.trim()) asset.sourceDescription = descriptionText.trim()
    if (!asset.creator && creatorText.trim()) asset.creator = creatorText.trim()
  }
  asset.gps ??= null
  asset.sourceDescription ??= null
  asset.creator ??= null
  await rm(metadataOutput, { force: true })
  await runPhotoshop(pluginDirectory, "preview.jsx", {
    input: asset.representative,
    output: asset.preview,
  }, signal)
  await stat(asset.preview)
}

function metadataPrompt(job: Job, asset: Asset) {
  const gps = asset.gps ? `${asset.gps.latitude.toFixed(6)}, ${asset.gps.longitude.toFixed(6)}` : "none"
  return `Identify the attached image for job ${job.id}. Before updating, call raw_photo_metadata_processor_search_subject_codes with concise queries for every visible subject category, event, activity, industry, sport, or concept that may apply. Then call raw_photo_metadata_processor_update. The metadata will be written identically to: ${asset.files.map((file) => path.basename(file)).join(", ")}. Source GPS: ${gps}. Source Description: ${asset.sourceDescription ?? "none"}. Creator: ${asset.creator ?? "none"}. Research this image independently. Any named place requires locationDecision=verified and complete location fields; without source GPS/Description, also provide >90% inferredLocation. Otherwise use unverified and emit no place names. Never identify people or put coordinates in Description. Select every applicable Scene code, not merely one, from this complete official catalog: ${IPTC_SCENE_CATALOG}. Select every applicable active Subject Code returned by the bundled local search, preferring specific codes.`
}

async function queueAsset(ctx: any, job: Job, message: string) {
  const asset = job.assets[job.index]
  await ctx.session.prompt({
    sessionID: job.sessionID,
    delivery: "queue",
    text: `${message}\n${metadataPrompt(job, asset)}\nThe JPEG preview is attached as actual image content. Inspect its pixels, not its pathname.`,
    files: [{ uri: pathToFileURL(asset.preview).href }],
  })
}

function validateMetadata(job: Job, asset: Asset, metadata: Metadata, activeSubjectCodes: Set<string>) {
  const keywords = [...new Set((metadata.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean))]
  if (!keywords.length) throw new Error("Provide at least one non-identifying, photo-specific keyword.")
  const inferred = metadata.inferredLocation
  if (inferred && asset.gps) throw new Error("Do not infer landmark GPS when source metadata already contains GPS.")
  if (inferred && (!(inferred.confidence > 0.9) || !Number.isFinite(inferred.latitude) || !Number.isFinite(inferred.longitude))) {
    throw new Error("Inferred landmark location requires confidence above 90% and valid verified coordinates.")
  }
  const location = metadata.location
  if (metadata.locationDecision === "verified" && !location) {
    throw new Error("A verified location decision requires complete structured location metadata.")
  }
  if (metadata.locationDecision === "verified" && !asset.gps && !asset.sourceDescription?.trim() && !inferred) {
    throw new Error("A visually verified location without source GPS/Description requires inferredLocation above 90% confidence.")
  }
  if (metadata.locationDecision === "unverified" && (location || inferred || metadata.description?.trim())) {
    throw new Error("An unverified location must omit inferredLocation, structured location, and generated Description.")
  }
  if (inferred && !location?.sublocation?.trim()) {
    throw new Error("A verified inferred landmark requires its specific name in Sublocation.")
  }
  if (location) {
    if ([location.city, location.stateProvince, location.country, location.isoCountryCode].some((field) => !field?.trim())) {
      throw new Error("Location requires City, State/Province, Country, and ISO Country Code.")
    }
    if (!/^[A-Za-z]{3}$/.test(location.isoCountryCode.trim())) {
      throw new Error("ISO Country Code must be an ISO 3166-1 alpha-3 code.")
    }
    if (!asset.gps && !asset.sourceDescription?.trim() && !inferred) {
      throw new Error("Do not add location fields without source GPS, source Description, or a verified inferred landmark.")
    }
    const sublocation = location.sublocation?.trim()
    if (sublocation && !(typeof location.sublocationConfidence === "number" && location.sublocationConfidence > 0.9)) {
      throw new Error("Sublocation recognition confidence must be strictly greater than 90%.")
    }
    if (!sublocation && location.sublocationConfidence !== undefined) {
      throw new Error("Do not provide sublocationConfidence without a Sublocation.")
    }
  }
  const hasKnownLocation = Boolean(location && (asset.gps || inferred || asset.sourceDescription))
  if (hasKnownLocation && !metadata.description?.trim()) throw new Error("A verified location requires a location-informed Description.")
  if (!hasKnownLocation && metadata.description?.trim()) throw new Error("Omit Description when exact location is unverified.")
  if (metadata.description && descriptionContainsCoordinates(metadata.description)) {
    throw new Error("Description must not contain coordinates or latitude/longitude notation.")
  }
  if ((metadata.iptcSceneCodes ?? []).some((code) => !IPTC_SCENE_CODES.has(code))) {
    throw new Error("Every IPTC Scene Code must come from the complete official local catalog.")
  }
  if (!asset.subjectSearchCount) {
    throw new Error("Search the bundled IPTC Subject Code catalog for this asset before updating metadata.")
  }
  if ((metadata.iptcSubjectCodes ?? []).some((code) => !activeSubjectCodes.has(code))) {
    throw new Error("Every IPTC Subject Code must be an active code from the bundled local catalog.")
  }
  return { keywords, inferred, location }
}

export default definePlugin({
  id: "raw-photo-metadata-processor",
  async setup(ctx) {
    const pluginDirectory = path.dirname(fileURLToPath(import.meta.url))
    const subjectCatalog = JSON.parse(
      await readFile(path.join(pluginDirectory, "data", "iptc-subject-codes.json"), "utf8"),
    ) as SubjectCodeCatalog
    const subjectCodesByCode = new Map(subjectCatalog.entries.map((entry) => [entry.code, entry]))
    const activeSubjectEntries = subjectCatalog.entries.filter((entry) => !entry.retired)
    const activeSubjectCodes = new Set(activeSubjectEntries.map((entry) => entry.code))
    const configuredModel = process.env.RAW_PHOTO_METADATA_PROCESSOR_MODEL
      || (typeof ctx.options.model === "string" ? ctx.options.model : "openai/gpt-6-luna")
    const [requestedProvider, ...modelParts] = configuredModel.split("/")
    const requestedModel = modelParts.join("/")

    await ctx.session.hook("context", (event) => {
      const jobID = sessionJobs.get(event.sessionID)
      const allowed = new Set(jobID
        ? ["raw_photo_metadata_processor_search_subject_codes", "raw_photo_metadata_processor_update", "raw_photo_metadata_processor_cancel"]
        : ["raw_photo_metadata_processor_start"])
      for (const name of Object.keys(event.tools)) {
        if (name.startsWith("raw_photo_metadata_processor_") && !allowed.has(name)) delete event.tools[name]
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "raw-photo-metadata-processor",
        description: "Identify RAW, PSD, and JPEG images and update only their metadata.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const folder = prompt.text.trim()
          if (!folder) throw new Error("Provide an absolute folder path, for example: /raw-photo-metadata-processor C:\\Photos")
          try {
            await ctx.session.switchModel({ sessionID, model: { providerID: requestedProvider, id: requestedModel } })
          } catch {
            await ctx.session.switchModel({ sessionID, model: { providerID: "openai", id: "gpt-5.6-terra" } })
          }
          await ctx.session.prompt({
            sessionID,
            delivery,
            text: `Update only metadata for supported images directly in ${JSON.stringify(folder)}. Call raw_photo_metadata_processor_start once. For each queued preview, independently identify and research it, search the bundled Subject Code catalog, assign all applicable IPTC Scene and Subject codes, call update, then end the turn when another preview is queued. Never edit pixels, identify people, reuse another image's metadata, restart, or cancel unless explicitly asked. Continue until complete.`,
          })
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "raw_photo_metadata_processor",
        description: "AI-guided metadata-only updates for local RAW, PSD, and JPEG images.",
      })

      editor.add({
        name: "start",
        description: "Start a non-recursive metadata-only job for RAW, PSD, and JPEG files and queue the first preview.",
        options: { namespace: "raw_photo_metadata_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: { folder: { type: "string", description: "Absolute path to one folder containing RAW, PSD, and/or JPEG images." } },
          required: ["folder"],
        },
        execute: async (input: { folder: string }, context) => {
          const activeJobID = sessionJobs.get(context.sessionID)
          if (activeJobID && jobs.has(activeJobID)) throw new Error("This session already has an active metadata job.")
          if (!path.isAbsolute(input.folder)) throw new Error("The image folder path must be absolute.")
          const folder = path.resolve(input.folder)
          const info = await stat(folder)
          if (!info.isDirectory()) throw new Error(`Not a folder: ${folder}`)
          const names = (await readdir(folder))
            .filter((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          if (!names.length) throw new Error(`No supported RAW, PSD, or JPEG images were found directly in ${folder}`)

          const grouped = new Map<string, string[]>()
          for (const name of names) {
            const key = path.parse(name).name.toLocaleLowerCase()
            const files = grouped.get(key) ?? []
            files.push(path.join(folder, name))
            grouped.set(key, files)
          }
          const id = randomUUID()
          const work = path.join(tmpdir(), "Raw_Photo_Metadata_Processor", id)
          await mkdir(work, { recursive: true })
          const assets = [...grouped.entries()].map(([stem, files], index) => ({
            stem,
            files,
            representative: [...files].sort((a, b) => representativeRank(a) - representativeRank(b))[0],
            preview: path.join(work, `${String(index + 1).padStart(5, "0")}.jpg`),
          }))
          const job: Job = {
            id, sessionID: context.sessionID, folder, work, assets, index: 0,
            completed: [],
          }
          jobs.set(id, job)
          sessionJobs.set(context.sessionID, id)
          try {
            await context.progress({ status: `Reading metadata and creating preview 1 of ${assets.length}` })
            await prepareAsset(pluginDirectory, job, context.signal)
            const message = `Found ${names.length} file(s) in ${assets.length} basename-matched asset group(s). Files sharing a basename receive identical metadata.`
            await queueAsset(ctx, job, message)
            return { content: "Queued the first image preview. End this turn and wait for the queued image message; do not call another tool yet." }
          } catch (error) {
            jobs.delete(id)
            sessionJobs.delete(context.sessionID)
            await rm(work, { recursive: true, force: true })
            throw error
          }
        },
      })

      editor.add({
        name: "search_subject_codes",
        description: "Search all 1,404 locally bundled IPTC Subject NewsCodes. Returns active matching codes with definitions and hierarchy; retired codes are retained locally but never returned for assignment.",
        options: { namespace: "raw_photo_metadata_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobID: { type: "string" },
            queries: {
              type: "array",
              minItems: 1,
              maxItems: 12,
              uniqueItems: true,
              items: { type: "string", minLength: 2, maxLength: 80 },
              description: "Concise English subject searches based on visible content, such as architecture, mountain, tourism, association football, or religious festival.",
            },
            limitPerQuery: { type: "integer", minimum: 1, maximum: 20, description: "Maximum matches per query; defaults to 8." },
          },
          required: ["jobID", "queries"],
        },
        execute: async (input: { jobID: string; queries: string[]; limitPerQuery?: number }, context) => {
          const job = jobs.get(input.jobID)
          if (!job) throw new Error("Unknown or completed metadata job.")
          if (job.sessionID !== context.sessionID) throw new Error("This metadata job belongs to another session.")
          const asset = job.assets[job.index]
          asset.subjectSearchCount = (asset.subjectSearchCount ?? 0) + 1
          const limit = Math.min(20, Math.max(1, input.limitPerQuery ?? 8))
          const sections = input.queries.map((query) => {
            const matches = activeSubjectEntries
              .map((entry) => ({ entry, score: subjectSearchScore(entry, query) }))
              .filter((item) => item.score > 0)
              .sort((a, b) => b.score - a.score || a.entry.code.localeCompare(b.entry.code))
              .slice(0, limit)
            const lines = matches.map(({ entry }) => {
              const parent = entry.broader ? subjectCodesByCode.get(entry.broader) : undefined
              const hierarchy = parent ? `; broader ${parent.code} ${parent.name}` : ""
              return `${entry.code} ${entry.name}${hierarchy} — ${entry.definition}`
            })
            return `Query: ${query}\n${lines.length ? lines.join("\n") : "No active matches. Try a broader synonym."}`
          })
          return {
            content: `${sections.join("\n\n")}\n\nUse only returned eight-digit active codes. Search again with synonyms or broader/narrower concepts if these results do not cover every clearly applicable subject.`,
          }
        },
      })

      editor.add({
        name: "update",
        description: "Write verified descriptive, location, rights, GPS fallback, and all applicable IPTC Scene and Subject Code metadata without changing pixels. Search the local Subject Code catalog first.",
        options: { namespace: "raw_photo_metadata_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: { jobID: { type: "string" }, metadata: METADATA_SCHEMA },
          required: ["jobID", "metadata"],
        },
        execute: async (input: { jobID: string; metadata: Metadata }, context) => {
          const job = jobs.get(input.jobID)
          if (!job) throw new Error("Unknown or completed metadata job.")
          if (job.sessionID !== context.sessionID) throw new Error("This metadata job belongs to another session.")
          const asset = job.assets[job.index]
          const validated = validateMetadata(job, asset, input.metadata, activeSubjectCodes)
          const resultFile = path.join(job.work, `update-${job.index}.tsv`)
          await context.progress({ status: `Updating metadata for ${asset.files.length} file(s): ${path.basename(asset.representative)}` })
          await runPhotoshop(pluginDirectory, "update-metadata.jsx", {
            items: asset.files.map((file) => ({ input: file, sidecar: sidecarFor(file) })),
            result: resultFile,
            description: input.metadata.description?.trim() || null,
            keywords: validated.keywords.slice(0, 30),
            iptcSceneCodes: [...new Set(input.metadata.iptcSceneCodes)].filter((code) => IPTC_SCENE_CODES.has(code)),
            iptcSubjectCodes: [...new Set(input.metadata.iptcSubjectCodes)].filter((code) => activeSubjectCodes.has(code)),
            gps: validated.inferred ? { latitude: validated.inferred.latitude, longitude: validated.inferred.longitude } : null,
            location: validated.location ? {
              sublocation: validated.location.sublocation?.trim() || null,
              city: validated.location.city.trim(),
              stateProvince: validated.location.stateProvince.trim(),
              country: validated.location.country.trim(),
              isoCountryCode: validated.location.isoCountryCode.trim().toUpperCase(),
            } : null,
            creator: asset.creator,
          }, context.signal)
          const storage = (await readFile(resultFile, "utf8")).split(/\r?\n/).filter(Boolean)
          await rm(resultFile, { force: true })
          job.completed.push({ stem: asset.stem, files: asset.files, storage })
          job.index += 1
          if (job.index >= job.assets.length) {
            jobs.delete(job.id)
            sessionJobs.delete(job.sessionID)
            await rm(job.work, { recursive: true, force: true })
            const sidecars = job.completed.flatMap((item) => item.storage).filter((line) => /\tsidecar$/i.test(line)).length
            return { content: `Metadata update complete: ${job.completed.length} asset group(s), ${job.completed.reduce((sum, item) => sum + item.files.length, 0)} file(s). ${sidecars} file update(s) used XMP sidecar storage; all others were embedded.` }
          }
          await context.progress({ status: `Reading metadata and creating preview ${job.index + 1} of ${job.assets.length}` })
          await prepareAsset(pluginDirectory, job, context.signal)
          await queueAsset(ctx, job, `Updated ${asset.files.map((file) => path.basename(file)).join(", ")}.`)
          return { content: "Metadata updated and the next preview was queued. End this turn and wait for the queued image message." }
        },
      })

      editor.add({
        name: "cancel",
        description: "Cancel only when the user explicitly requests cancellation.",
        options: { namespace: "raw_photo_metadata_processor", codemode: true },
        input: {
          type: "object", additionalProperties: false,
          properties: { jobID: { type: "string" } }, required: ["jobID"],
        },
        execute: async (input: { jobID: string }, context) => {
          const job = jobs.get(input.jobID)
          if (!job) return { content: "Job is already completed, cancelled, or unknown." }
          if (job.sessionID !== context.sessionID) throw new Error("This metadata job belongs to another session.")
          jobs.delete(job.id)
          sessionJobs.delete(job.sessionID)
          await rm(job.work, { recursive: true, force: true })
          return { content: `Cancelled job ${job.id}. Metadata already written was retained.` }
        },
      })
    })

    return async () => {
      await Promise.all([...jobs.values()].map((job) => rm(job.work, { recursive: true, force: true })))
      jobs.clear()
      sessionJobs.clear()
    }
  },
})
