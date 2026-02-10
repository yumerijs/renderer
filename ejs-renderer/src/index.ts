import type { IRenderer, RenderOptions } from '@yumerijs/types'
import ejs from 'ejs';

/**
 * EjsRenderer 实现
 * 满足 IRenderer 接口，用于处理 .ejs 模板渲染
 */
export default class EjsRenderer implements IRenderer {
    public name = 'ejs';

    /**
     * 渲染一个 EJS 模板字符串
     * @param component EJS 模板内容字符串
     * @param data 模板数据
     * @param options 渲染选项 (当前主要使用 ejs 默认行为)
     */
    async render(component: string, data: Record<string, any>, options?: RenderOptions): Promise<string> {
        try {
            // ejs.render 是同步的，直接返回
            return ejs.render(component, data, {
                // 如果有需要，可以从 options 中提取 ejs 原生支持的选项
                filename: options?.clientEntry // ejs 中 filename 对 include 路径解析很重要
            });
        } catch (err) {
            throw new Error(`[EjsRenderer] Failed to render string: ${err}`);
        }
    }

    /**
     * 渲染一个 EJS 文件
     * @param path 文件绝对路径
     * @param data 模板数据
     * @param options 渲染选项
     */
    async renderFile(path: string, data: Record<string, any>, options?: RenderOptions): Promise<string> {
        return new Promise((resolve, reject) => {
            ejs.renderFile(path, data, {}, (err, str) => {
                if (err) {
                    return reject(new Error(`[EjsRenderer] Failed to render file at ${path}: ${err}`));
                }
                resolve(str);
            });
        });
    }
}
