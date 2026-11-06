import type { ClashType, VpsMap } from '../../../types';
import type { Parser } from '../../parser';
import { HTTPException } from 'hono/http-exception';
import { isHighMultiplier } from '../../parser/subscription';

export class ClashClient {
    constructor(private confuseConfig: ClashType, private state?: Parser) {}

    public getOriginConfig(vpsMap: VpsMap): ClashType {
        const config = this.confuseConfig;
        const names = new Set<string>(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL', ...(config['proxy-groups'] ?? []).map(g => g.name)]);
        const references = new Map<string, string>();
        const restored = new Map<string, Record<string, any>>();
        const fail = (count = 1): never => {
            if (this.state) this.state.stats.restoreFailed += count;
            throw new HTTPException(502, { message: 'Proxy restoration/count mismatch; counts=' + JSON.stringify(this.state?.stats ?? { expected: vpsMap.size, final: restored.size }) });
        };
        for (const proxy of config.proxies ?? []) {
            const oldName = proxy.name;
            const match = oldName?.match(/\^LINK_TO\^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
            const id = match?.[1];
            if (!id || !vpsMap.has(id) || restored.has(id)) fail();
            const parser = vpsMap.get(id!)!;
            // Keep backend Emoji/type decoration but remove only the marker.
            let name = oldName.replace(match![0], '').replace(/^#/, '');
            const base = name;
            let suffix = 2;
            while (names.has(name)) name = base + ' [' + suffix++ + ']';
            names.add(name);
            try {
                parser.restoreClash(proxy, name);
                if (!proxy.type || !proxy.server || !Number.isInteger(Number(proxy.port)) || Number(proxy.port) < 1 || Number(proxy.port) > 65535) fail();
            } catch (error) {
                if (error instanceof HTTPException) throw error;
                fail();
            }
            references.set(oldName, name);
            restored.set(id!, proxy);
        }
        const missing = [...vpsMap.keys()].filter(id => !restored.has(id));
        if (missing.length) fail(missing.length);
        const nodeNames = new Set(config.proxies.map(p => p.name));
        for (const group of config['proxy-groups'] ?? []) {
            if (group.proxies) group.proxies = group.proxies.map(name => references.get(name) ?? name);
        }
        const providers = config['proxy-providers'] ?? {};
        const providerNames = new Set<string>([...Object.keys(providers), ...names]);
        const sourceProviders: string[] = [];
        for (const source of this.state?.providers ?? []) {
            let name = source.name;
            let suffix = 2;
            while (providerNames.has(name)) name = source.name + ' [' + suffix++ + ']';
            providerNames.add(name);
            const payload = source.ids.map(id => restored.get(id) ?? fail());
            if (!payload.length) throw new HTTPException(422, { message: 'An input provider has no unfiltered nodes' });
            providers[name] = {
                type: 'inline', payload,
                'health-check': structuredClone(source.definition?.['health-check'] ?? { enable: false }),
                ...(source.definition ? { 'x-original-provider': structuredClone(source.definition) } : { 'x-subscription-source': source.name })
            };
            sourceProviders.push(name);
        }
        if (Object.keys(providers).length) config['proxy-providers'] = providers;
        // The same real objects are exposed under their sources for Mihomo's
        // provider panel; no extra top-level proxy or invented endpoint is added.
        const manual = config['proxy-groups']?.find(g => g.name === '🚀 手动选择');
        if (manual) {
            // Providers already expose these same nodes. Avoid listing each one
            // twice in the manual selector while retaining its policy choices.
            manual.proxies = sourceProviders.length
                ? (manual.proxies ?? []).filter(name => !nodeNames.has(name))
                : [...new Set([...(manual.proxies ?? []), ...nodeNames])];
            manual.use = [...new Set([...(manual.use ?? []), ...sourceProviders])];
        }
        const high = new Set(config.proxies.filter(p => isHighMultiplier(p.name)).map(p => p.name));
        for (const group of config['proxy-groups'] ?? []) {
            if (group.name === '🔥 高倍率节点') group.proxies = config.proxies.filter(p => high.has(p.name)).map(p => p.name);
            if (group.name === '♻️ 自动选择') group.proxies = (group.proxies ?? []).filter(name => nodeNames.has(name) && !high.has(name));
            if ((group.name.endsWith('节点') || group.name === '🌐 其他地区') && group.type === 'url-test') {
                // SubConverter fills each empty chunk with DIRECT. Merge first,
                // then remove all non-node filler; populated chunks remain intact.
                group.proxies = (group.proxies ?? []).filter(name => nodeNames.has(name));
                delete group.use;
                delete group['include-all'];
                delete group['include-all-proxies'];
                delete group['include-all-providers'];
                delete group['empty-fallback'];
            }
        }
        const removed = new Set<string>();
        // User authorized removing empty node-only groups and their references.
        for (const group of config['proxy-groups'] ?? []) {
            if ((group.type === 'url-test' && (group.name.endsWith('节点') || group.name === '🌐 其他地区' || group.name === '♻️ 自动选择')) && !group.proxies?.length && !group.use?.length) removed.add(group.name);
        }
        config['proxy-groups'] = (config['proxy-groups'] ?? []).filter(g => !removed.has(g.name));
        for (const group of config['proxy-groups']) {
            if (group.proxies) group.proxies = group.proxies.filter(name => !removed.has(name));
        }
        // A removed region referenced directly by a rule has no valid replacement.
        // Fail instead of silently sending it to another country or DIRECT.
        for (const rule of config.rules ?? []) {
            const parts = rule.split(',');
            const target = parts.at(-1) === 'no-resolve' ? parts.at(-2) : parts.at(-1);
            if (removed.has(target)) throw new HTTPException(422, { message: 'Rule references an empty region group' });
        }
        const valid = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', ...nodeNames, ...config['proxy-groups'].map(g => g.name)]);
        for (const group of config['proxy-groups']) {
            if (!(group.proxies?.length || group.use?.length)) throw new HTTPException(422, { message: 'Empty business policy group' });
            if (group.proxies?.some(name => !valid.has(name)) || group.use?.some((name: string) => !Object.hasOwn(providers, name))) throw new HTTPException(502, { message: 'Invalid group reference after restoration' });
        }
        if (this.state) {
            this.state.stats.final = config.proxies.length;
            if (this.state.stats.parsed - this.state.stats.filtered !== this.state.stats.final) fail();
            config['x-sub-convert'] = { ...this.state.stats, providers: Object.keys(providers).length, removedEmptyGroups: [...removed] };
        }
        return config;
    }
}
