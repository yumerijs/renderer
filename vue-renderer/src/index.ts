import { IRenderer, RenderOptions } from '@yumerijs/types'
import { createApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { ClientBundleManager } from './clientBundleManager'
import { ComponentStyleCache } from './styleCache'

const bundleManager = new ClientBundleManager()
const styleCache = new ComponentStyleCache()

export default class VueRenderer implements IRenderer {
  public name = 'vue'

  async render(component: any, data: Record<string, any>, options: RenderOptions = {}): Promise<string> {
    const app = createApp(component, data)
    const appHtml = await renderToString(app)

    const initialState = JSON.stringify(data)
    let clientEntry = options.clientEntry
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

    const clientScript = clientEntry
      ? `<script type="module" src="${clientEntry}"></script>`
      : ''

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Yumeri App</title>
          ${inlineCss}
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
