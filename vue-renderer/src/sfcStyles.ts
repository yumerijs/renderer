import { compileStyle, SFCDescriptor } from '@vue/compiler-sfc';

export function compileSfcStyles(descriptor: SFCDescriptor, filename: string, id: string): string {
  if (!descriptor.styles || descriptor.styles.length === 0) {
    return '';
  }

  const cssParts: string[] = [];
  for (const styleBlock of descriptor.styles) {
    if (!styleBlock) continue;
    if (styleBlock.src) {
      throw new Error(`[yumeri][vue-renderer] External style imports are not supported yet in "${filename}".`);
    }
    if (styleBlock.lang && styleBlock.lang !== 'css') {
      throw new Error(`[yumeri][vue-renderer] <style lang="${styleBlock.lang}"> is not supported in "${filename}".`);
    }
    const result = compileStyle({
      id,
      filename,
      source: styleBlock.content,
      scoped: styleBlock.scoped,
    });

    if (result.errors.length > 0) {
      throw result.errors[0];
    }
    cssParts.push(result.code);
  }

  return cssParts.join('\n');
}
