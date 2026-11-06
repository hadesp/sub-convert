import type { ExcludeRule } from '../types';

export class Exclude {
    static #EXCLUDE_RULES: ExcludeRule[] = [
        { label: '中国香港', value: 'ZH_HK', rules: '港|HK|Hong Kong|HongKong|HKG' },
        { label: '中国台湾', value: 'ZH_TW', rules: '台|新北|彰化|TW|Taiwan|TPE|KHH' },
        { label: '中国澳门', value: 'ZH_MO', rules: '澳|MAC|Macao|macau|MACAU' },
        { label: '韩国', value: 'KR', rules: 'KR|Korea|KOR|Seoul|首尔|春川|韩|韓|ICN' },
        { label: '日本', value: 'JP', rules: '日本|川日|东京|大阪|泉日|埼玉|沪日|深日|[^-]日|JP|Japan|Tokyo|NRT|KIX' },
        { label: '新加坡', value: 'SG', rules: '新加坡|坡|狮城|SG|Singapore|SIN' },
        {
            label: '美国',
            value: 'US',
            rules: '美|波特兰|达拉斯|俄勒冈|凤凰城|费利蒙|硅谷|拉斯维加斯|洛杉矶|圣何塞|圣克拉拉|西雅图|芝加哥|US|United States|ATL|BUF|DFW|EWR|IAD|LAX|MCI|MIA|ORD|PHX|PDX|SEA|SJC'
        }
    ];

    static #compiledCache: { value: string; regexp: RegExp }[] | null = null;

    /**
     * 将规则字符串编译为不区分大小写的正则。
     * 纯 ASCII 字母/数字的关键词（如 US、HK、Singapore）会加上单词边界 \b，
     * 避免作为子串误命中（例如 US 命中 "PLUS"、"Nexus"）；中文关键词与正则片段保持原样。
     */
    static #compileRule(rules: string): RegExp {
        const pattern = rules
            .split('|')
            .map(token => (/^[A-Z0-9][A-Z0-9 ]*$/i.test(token) ? `\\b${token}\\b` : token))
            .join('|');
        return new RegExp(pattern, 'i');
    }

    static #getCompiledRules(): { value: string; regexp: RegExp }[] {
        if (!Exclude.#compiledCache) {
            Exclude.#compiledCache = Exclude.#EXCLUDE_RULES.map(rule => ({ value: rule.value, regexp: Exclude.#compileRule(rule.rules) }));
        }
        return Exclude.#compiledCache;
    }

    public getTag(vpsHash?: string): string | null {
        if (!vpsHash) {
            return null;
        }
        // VMess/native YAML names are plain text and can contain a literal %.
        // URI hashes are encoded; tolerate plain names without changing them.
        let _vpsHash = vpsHash;
        try { _vpsHash = decodeURIComponent(vpsHash); } catch { /* Plain node name. */ }

        for (const { value, regexp } of Exclude.#getCompiledRules()) {
            if (regexp.test(_vpsHash)) {
                return value;
            }
        }

        return null;
    }

    public get excludeRules(): ExcludeRule[] {
        return Exclude.#EXCLUDE_RULES;
    }
}

