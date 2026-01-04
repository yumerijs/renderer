import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { build } from 'esbuild';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { compileSfcStyles } from './sfcStyles.js';
import { registerVirtualAssetResolver } from '@yumerijs/types';

type BundleRecord = {
  publicPath: string;
  mtimeMs: number;
  code: string;
};

interface BundleOptions {
  pluginName?: string;
}

const SUPPORTED_LOADERS = new Set(['js', 'ts', 'tsx', 'jsx'] as const);
const PROJECT_ROOT = process.cwd();

function inferLoader(lang?: string): 'js' | 'ts' | 'tsx' | 'jsx' {
  if (!lang) return 'js';
  return SUPPORTED_LOADERS.has(lang as any) ? (lang as any) : 'js';
}

function hashComponent(filePath: string, mtimeMs: number): string {
  return crypto.createHash('md5').update(`${filePath}:${mtimeMs}`).digest('hex').slice(0, 12);
}

function sanitizeFragment(value?: string): string {
  if (!value) return 'default';
  return value.replace(/[^a-z0-9-_]/gi, '_');
}

function getScopeId(filename: string): string {
  return crypto.createHash('md5').update(filename).digest('hex').slice(0, 8);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function vueComponentPlugin() {
  return {
    name: 'yumeri-vue-sfc',
    setup(build: any) {
      build.onLoad({ filter: /\.vue$/ }, async (args: any) => {
        const source = await fs.readFile(args.path, 'utf8');
        const { descriptor } = parse(source, { filename: args.path });
        const id = getScopeId(args.path);

        let contents = '';
        const lang = descriptor.scriptSetup?.lang || descriptor.script?.lang;

        if (descriptor.script || descriptor.scriptSetup) {
          const compiled = compileScript(descriptor, {
            id,
            inlineTemplate: true,
            templateOptions: {
              ssr: false,
            },
          });
          contents = compiled.content;
        } else if (descriptor.template) {
          const templateResult = compileTemplate({
            id,
            filename: args.path,
            source: descriptor.template.content,
            ssr: false,
          });
          contents = `
import { defineComponent } from 'vue';
${templateResult.code}
export default defineComponent({ render });
`;
        } else {
          contents = 'export default {};';
        }

        try {
          const styles = compileSfcStyles(descriptor, args.path, id);
          if (styles.trim().length > 0) {
            const styleId = `yumeri-vue-style-${id}`;
            contents += `
if (typeof document !== 'undefined' && !document.getElementById('${styleId}')) {
  const style = document.createElement('style');
  style.id = '${styleId}';
  style.textContent = ${JSON.stringify(styles)};
  document.head.appendChild(style);
}
`;
          }
        } catch (error) {
          console.error('[yumeri][vue-renderer] Failed to compile component styles for client bundle:', error);
        }

        return {
          contents,
          loader: inferLoader(lang),
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };
}

const BUNDLE_PREFIX = '/__yumeri_vue';
const bundleStore = new Map<string, BundleRecord>();
let resolverRegistered = false;

function ensureResolverRegistered() {
  if (resolverRegistered) return;
  registerVirtualAssetResolver(async (pathname) => {
    if (!pathname.startsWith(`${BUNDLE_PREFIX}/`)) return null;
    const record = bundleStore.get(pathname);
    if (!record) return null;
    return {
      body: record.code,
      contentType: 'application/javascript',
    };
  });
  resolverRegistered = true;
}

export class ClientBundleManager {
  private cache = new Map<string, BundleRecord>();
  private building = new Map<string, Promise<BundleRecord>>();

  constructor() {
    ensureResolverRegistered();
  }

  async ensureBundle(componentPath: string, options: BundleOptions = {}): Promise<string> {
    const stat = await fs.stat(componentPath);
    const cached = this.cache.get(componentPath);

    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.publicPath;
    }

    if (this.building.has(componentPath)) {
      const existing = this.building.get(componentPath)!;
      const result = await existing;
      return result.publicPath;
    }

    const buildPromise = this.buildBundle(componentPath, stat.mtimeMs, options).finally(() => {
      this.building.delete(componentPath);
    });
    this.building.set(componentPath, buildPromise);

    const record = await buildPromise;
    this.cache.set(componentPath, record);
    return record.publicPath;
  }

  private async buildBundle(componentPath: string, mtimeMs: number, options: BundleOptions): Promise<BundleRecord> {
    const hash = hashComponent(componentPath, mtimeMs);
    const fragment = sanitizeFragment(options.pluginName);
    const publicPath = `${BUNDLE_PREFIX}/${fragment}/${hash}.js`;

    const relativeImport = toPosix(path.relative(PROJECT_ROOT, componentPath));

    const entry = `
      import { createApp } from 'vue';
      import Component from ${JSON.stringify('./' + relativeImport)};
      const target = document.getElementById('app');
      const state = window.__INITIAL_STATE__ || {};
      if (target) {
        const app = createApp(Component, state);
        app.mount(target);
      }
    `;

    const result = await build({
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2018',
      sourcemap: false,
      write: false,
      absWorkingDir: PROJECT_ROOT,
      stdin: {
        contents: entry,
        sourcefile: 'entry-client.js',
        resolveDir: PROJECT_ROOT,
        loader: 'ts',
      },
      plugins: [vueComponentPlugin()],
      loader: {
        '.ts': 'ts',
        '.tsx': 'tsx',
        '.js': 'js',
        '.jsx': 'jsx',
      },
    });

    const outputContent = result.outputFiles?.[0]?.text || '';
    const record: BundleRecord = {
      publicPath,
      mtimeMs,
      code: outputContent,
    };
    bundleStore.set(publicPath, record);
    return record;
  }
}
