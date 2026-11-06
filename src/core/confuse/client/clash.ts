import type { ClashType } from '../../../types';
import { downloadSubscription } from '../../parser/subscription';
import { load } from 'js-yaml';

export class ClashClient {
    public async getConfig(urls: string[]): Promise<ClashType> {
        if (!urls.length) return {} as ClashType;
        const configs: ClashType[] = [];
        // Bound active connections and do not retry/skip failed batches.
        for (let i = 0; i < urls.length; i += 4) {
            const batch = await Promise.all(urls.slice(i, i + 4).map(async url => {
                try {
                    const config = load(await downloadSubscription(url)) as ClashType;
                    if (!config || !Array.isArray(config.proxies) || !Array.isArray(config['proxy-groups'])) throw new Error();
                    return config;
                } catch { throw new Error('Clash conversion batch failed'); }
            }));
            configs.push(...batch);
        }
        return this.mergeClashConfig(configs);
    }

    private mergeClashConfig(configs: ClashType[]): ClashType {
        const merged = { ...configs[0], proxies: [], 'proxy-groups': [] } as ClashType;
        const groups = new Map<string, ClashType['proxy-groups'][number]>();
        const providers: Record<string, any> = {};
        for (let index = 0; index < configs.length; index++) {
            const config = configs[index];
            const providerNames = new Map<string, string>();
            for (const [original, provider] of Object.entries(config['proxy-providers'] ?? {})) {
                let name = original;
                let suffix = 1;
                // Identical definitions refer to one provider; distinct definitions
                // must have distinct names and local use references.
                if (Object.hasOwn(providers, name) && JSON.stringify(providers[name]) !== JSON.stringify(provider)) {
                    do { name = original + ' [B' + (index + 1) + '-' + suffix++ + ']'; } while (Object.hasOwn(providers, name));
                }
                providers[name] = structuredClone(provider);
                providerNames.set(original, name);
            }
            merged.proxies.push(...(config.proxies ?? []));
            for (const raw of config['proxy-groups'] ?? []) {
                const group = structuredClone(raw);
                if (group.use) group.use = group.use.map((name: string) => providerNames.get(name) ?? name);
                const previous = groups.get(group.name);
                if (!previous) groups.set(group.name, group);
                else {
                    for (const key of ['proxies', 'use'] as const) {
                        if (group[key]) previous[key] = [...new Set([...(previous[key] ?? []), ...group[key]])];
                    }
                }
            }
        }
        merged['proxy-groups'] = [...groups.values()];
        if (Object.keys(providers).length) merged['proxy-providers'] = providers;
        else delete merged['proxy-providers'];
        return merged;
    }
}
