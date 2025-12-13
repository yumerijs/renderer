import fs from 'fs/promises';
import crypto from 'crypto';
import { parse } from '@vue/compiler-sfc';
import { compileSfcStyles } from './sfcStyles';

type StyleRecord = {
  css: string;
  mtimeMs: number;
};

function getScopeId(filename: string): string {
  return crypto.createHash('md5').update(filename).digest('hex').slice(0, 8);
}

export class ComponentStyleCache {
  private cache = new Map<string, StyleRecord>();

  async getCss(componentPath: string): Promise<string> {
    const stat = await fs.stat(componentPath);
    const cached = this.cache.get(componentPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.css;
    }

    const source = await fs.readFile(componentPath, 'utf8');
    const { descriptor } = parse(source, { filename: componentPath });
    const id = getScopeId(componentPath);
    const css = compileSfcStyles(descriptor, componentPath, id);

    this.cache.set(componentPath, { css, mtimeMs: stat.mtimeMs });
    return css;
  }
}
