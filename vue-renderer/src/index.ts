import { IRenderer, RenderOptions } from '@yumerijs/types'
import { createApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import path from 'path'
import fs from 'fs'
import { ClientBundleManager } from './clientBundleManager'
import { ComponentStyleCache } from './styleCache'
import { registerVirtualAssetResolver } from '@yumerijs/types'

const bundleManager = new ClientBundleManager()
const styleCache = new ComponentStyleCache()
const PROJECT_ROOT = process.cwd()
const manifestCache = new Map<string, ManifestRecord | null>()

type ManifestEntry = { entry: string; file: string; css?: string[] }
type ManifestRecord = { plugin: string; entries: Record<string, ManifestEntry>; css?: string[] }

export default class VueRenderer implements IRenderer {
  public name = 'vue'

  async render(component: any, data: Record<string, any>, options: RenderOptions = {}): Promise<string> {
    const app = createApp(component, data)
    const ssrContext: any = { modules: new Set<string>() }
    const appHtml = await renderToString(app, ssrContext)

    const componentFile = resolveComponentFile(component, ssrContext.modules, options.pluginName)
    if (componentFile && component && !component.__file) {
      component.__file = componentFile
    }

    const initialState = JSON.stringify(data)
    const pluginName = options.pluginName ?? null
    const manifestInfo = await resolveManifestEntry(componentFile, ssrContext.modules, pluginName)
    let clientEntry: string | null = manifestInfo?.entry ?? null
    const manifestCss = manifestInfo?.css ?? []
    if (!clientEntry && options.clientEntry) {
      clientEntry = options.clientEntry
    }
    let inlineCss = ''

    if (!clientEntry && component && component.__file) {
      try {
        clientEntry = await bundleManager.ensureBundle(component.__file, {
          pluginName: options.pluginName,
        })
      } catch (err) {
        console.error('[yumeri][vue-renderer] Failed to generate client bundle:', err)
      }

      try {
        const css = await styleCache.getCss(component.__file)
        if (css) {
          inlineCss = `<style data-yumeri-style>${css}</style>`
        }
      } catch (err) {
        console.error('[yumeri][vue-renderer] Failed to compile component styles:', err)
      }
    }

    const cssLinks = manifestCss
      .map((href) => `<link rel="stylesheet" href="${href}">`)
      .join('')

    const clientScript = clientEntry ? `<script type="module" src="${clientEntry}"></script>` : ''

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Yumeri App</title>
          ${inlineCss}
          ${cssLinks}
        </head>
        <body>
          <div id="app">${appHtml}</div>
          <script>window.__INITIAL_STATE__ = ${initialState};</script>
          ${clientScript}
        </body>
      </html>
    `
  }
}

async function resolveManifestEntry(
  componentFile: string | null,
  modules: Iterable<string> | undefined,
  pluginName: string | null
): Promise<{ entry: string; css?: string[] } | null> {
  if (!pluginName) return null
  const manifest = await loadManifest(pluginName)
  if (!manifest) return null
  const pluginRoot = getPluginRoot(pluginName)

  const moduleIds: string[] = []
  if (componentFile) moduleIds.push(toPosixPath(componentFile))
  if (modules) {
    for (const modId of modules) {
      if (typeof modId === 'string') moduleIds.push(toPosixPath(modId))
    }
  }

  for (const idRaw of moduleIds) {
    const id = toPosixPath(idRaw)
    const entry =
      manifest.entries[id] ||
      manifest.entries[stripDistPrefix(id)] ||
      (pluginRoot ? manifest.entries[stripPrefix(id, pluginRoot)] : undefined)
    if (entry) {
      ensureManifestResolver(manifest.plugin, manifest, pluginRoot)
      return entry
    }
  }

  return null
}

function stripDistPrefix(id: string): string {
  if (id.startsWith('dist/')) return id.slice(5)
  return id
}

function stripPrefix(id: string, base: string): string {
  const normalizedBase = toPosixPath(base.endsWith('/') ? base : `${base}/`)
  if (id.startsWith(normalizedBase)) return id.slice(normalizedBase.length)
  return id
}

function resolveComponentFile(component: any, modules: Iterable<string> | undefined, pluginName?: string): string | null {
  if (component && component.__file) return component.__file
  if (!modules) return null

  const pluginRoot = pluginName ? resolvePluginRoot(pluginName) : null

  for (const modId of modules) {
    if (typeof modId !== 'string') continue
    if (!modId.endsWith('.vue')) continue
    const first = resolveExisting(modId)
    if (first) return first
    if (pluginRoot) {
      const second = resolveExisting(modId, pluginRoot)
      if (second) return second
    }
  }
  return null
}

function resolveExisting(modId: string, baseDir: string = PROJECT_ROOT): string | null {
  const candidate = path.isAbsolute(modId) ? modId : path.resolve(baseDir, modId)
  return fs.existsSync(candidate) ? candidate : null
}

function resolvePluginRoot(pluginName: string): string | null {
  try {
    const pkgPath = require.resolve(`${pluginName}/package.json`)
    return path.dirname(pkgPath)
  } catch {
    return null
  }
}

async function loadManifest(pluginName: string): Promise<ManifestRecord | null> {
  if (manifestCache.has(pluginName)) return manifestCache.get(pluginName)!
  const pluginRoot = getPluginRoot(pluginName)
  if (!pluginRoot) {
    manifestCache.set(pluginName, null)
    return null
  }
  const manifestPath = path.join(pluginRoot, 'dist', 'ui-manifest.json')
  if (!fs.existsSync(manifestPath)) {
    manifestCache.set(pluginName, null)
    return null
  }
  try {
    const json = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (json && json.entries) {
      manifestCache.set(pluginName, json)
      return json
    }
  } catch (err) {
    console.error('[yumeri][vue-renderer] Failed to load UI manifest for plugin', pluginName, err)
  }
  manifestCache.set(pluginName, null)
  return null
}

function getPluginRoot(pluginName: string): string | null {
  try {
    const pkgPath = require.resolve(`${pluginName}/package.json`)
    return path.dirname(pkgPath)
  } catch {
    return null
  }
}

const manifestResolvers = new Set<string>()

function ensureManifestResolver(pluginName: string, manifest: ManifestRecord, pluginRoot: string | null) {
  if (!pluginRoot) return
  if (manifestResolvers.has(pluginName)) return
  const prefix = `/__yumeri_vue_prebuilt/${pluginName}`
  registerVirtualAssetResolver(async (pathname) => {
    if (!pathname.startsWith(prefix)) return null
    const fileName = pathname.slice(prefix.length + 1)
    for (const entry of Object.values(manifest.entries)) {
      const fileCandidates = [entry.file]
      if (entry.css) fileCandidates.push(...entry.css.map((css) => css.replace(prefix + '/', 'client/')))
      for (const rel of fileCandidates) {
        if (rel.endsWith(fileName)) {
          const abs = path.join(pluginRoot, 'dist', rel)
          if (!fs.existsSync(abs)) continue
          const body = await fs.promises.readFile(abs)
          const contentType = rel.endsWith('.css') ? 'text/css' : 'application/javascript'
          return { body, contentType }
        }
      }
    }

    // fallback: serve any file under dist/client or dist root with the given suffix
    const direct = path.join(pluginRoot, 'dist', fileName)
    const clientFile = path.join(pluginRoot, 'dist', 'client', fileName)
    const target = fs.existsSync(direct) ? direct : fs.existsSync(clientFile) ? clientFile : null
    if (target) {
      const body = await fs.promises.readFile(target)
      const contentType = target.endsWith('.css') ? 'text/css' : 'application/javascript'
      return { body, contentType }
    }
    return null
  })
  manifestResolvers.add(pluginName)
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/')
}
