import type { ClashType } from '../../../types';
import { downloadSubscription, SubscriptionDownloadError } from '../../parser/subscription';
import { HTTPException } from 'hono/http-exception';
import { load } from 'js-yaml';

export class ClashClient {
    public async getConfig(urls: string[]): Promise<ClashType> {
        if (!urls.length) return {} as ClashType;
        const configs: ClashType[] = [];
        // Bound active connections and do not retry/skip failed batches.
        for (let i = 0; i < urls.length; i += 2) {
            const batch = await Promise.all(urls.slice(i, i + 2).map(async (url, offset) => {
                try {
                    const config = load(await downloadSubscription(url)) as ClashType;
                    if (!config || !Array.isArray(config.proxies) || !Array.isArray(config['proxy-groups'])) throw new Error();
                    return config;
                } catch (error) {
                    const reason = error instanceof SubscriptionDownloadError ? error.code : 'INVALID_YAML_OR_SCHEMA';
                    throw new HTTPException(502, { message: 'Clash conversion batch ' + (i + offset + 1) + ' failed; reason=' + reason });
                }
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
