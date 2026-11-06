import type { ParserType } from './types';
import { base64Decode, base64Encode } from 'cloudflare-tools';
import { HTTPException } from 'hono/http-exception';
import { load } from 'js-yaml';
import { Convert } from '../convert';
import { AnytlsParser } from './protocol/anytls';
import { Hysteria2Parser } from './protocol/hysteria2';
import { SsParser } from './protocol/ss';
import { SsrParser } from './protocol/ssr';
import { TrojanParser } from './protocol/trojan';
import { TuicParser } from './protocol/tuic';
import { VlessParser } from './protocol/vless';
import { VmessParser } from './protocol/vmess';
import { getYamlProxies } from './yaml';
import { downloadSubscription, subscriptionRegex, type SourceProvider } from './subscription';

export * from './protocol/anytls';
export * from './protocol/hysteria2';
export * from './protocol/ss';
export * from './protocol/ssr';
export * from './protocol/trojan';
export * from './protocol/tuic';
export * from './protocol/vless';
export * from './protocol/vmess';

export class Parser extends Convert {
    private urlSet: Set<string> = new Set<string>();
    private vpsStore: Map<string, ParserType> = new Map();
    private originUrls: Set<string> = new Set<string>();

    private vps: string[] = [];
    private includeProtocol: string[] = [];
    private excludeTag: string[] = [];
    public readonly stats = { raw: 0, parsed: 0, filtered: 0, parseFailed: 0, restoreFailed: 0, final: 0, subscriptions: 0, inputProviders: 0 };
    public readonly providers: SourceProvider[] = [];
    private readonly names = new Set<string>(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);
    private readonly providerNames = new Set<string>();
    private includeRegex: RegExp | null;
    private excludeRegex: RegExp | null;
    private readonly nativeYaml: boolean;
    constructor(vps: string[], existedVps: string[] = [], protocol: string | null = '', exclude: string | null = '', include: string | null = '', nativeYaml = false) {
        super(existedVps);
        this.vps = vps;
        this.nativeYaml = nativeYaml;
        this.includeRegex = subscriptionRegex(include);
        this.includeProtocol = protocol ? JSON.parse(protocol) : [];
        // OpenClash sends a SubConverter regex, while the Web UI sends tags.
        // Apply regex filters before marker decoration.
        if (exclude) {
            try {
                const tags = JSON.parse(exclude);
                this.excludeTag = Array.isArray(tags) ? tags : [];
            } catch {
                this.excludeTag = [];
            }
        }
        this.excludeRegex = this.excludeTag.length || (exclude && Array.isArray(this.tryJson(exclude))) ? null : subscriptionRegex(exclude);
    }

    private tryJson(value: string): any { try { return JSON.parse(value); } catch { return null; } }

    public async parse(vps: string[] = this.vps): Promise<void> {
        for (let index = 0; index < vps.length; index++) {
            const source = index + 1;
            const ids: string[] = [];
            try {
                const input = vps[index].trim();
                if (/^https?:\/\//.test(input)) {
                    this.stats.subscriptions++;
                    await this.parseContent(await downloadSubscription(input), source, ids);
                } else {
                    this.addNode(input, source, ids);
                }
                if (ids.length) this.addProvider('订阅 ' + source, ids);
            } catch (error) {
                if (error instanceof HTTPException) throw error;
                throw new HTTPException(422, { message: 'Subscription ' + source + ' failed; counts=' + JSON.stringify(this.stats) });
            }
        }
        if (!this.vpsStore.size) throw new HTTPException(422, { message: 'No unfiltered supported proxies; counts=' + JSON.stringify(this.stats) });
    }

    private addProvider(name: string, ids: string[], definition?: Record<string, any>): void {
        const base = name;
        let suffix = 2;
        while (this.providerNames.has(name)) name = base + ' [' + suffix++ + ']';
        this.providerNames.add(name);
        this.providers.push({ name, ids, definition });
    }

    private async parseContent(text: string, source: number, ids: string[], depth = 0): Promise<void> {
        if (depth > 4) throw new Error('Nested subscription limit');
        text = text.trim();
        let config: any;
        try { config = load(text); } catch { /* Try node list below. */ }
        if (config && typeof config === 'object' && (Array.isArray(config.proxies) || config['proxy-providers'])) {
            for (const node of config.proxies ?? []) this.addNode(node, source, ids);
            for (const [name, raw] of Object.entries(config['proxy-providers'] ?? {})) {
                this.stats.inputProviders++;
                const provider = raw as Record<string, any>;
                const providerIds: string[] = [];
                // Definitions stay on the Worker; provider nodes use the same
                // request-local mapping as ordinary subscription nodes.
                if (provider.type === 'inline') {
                    if (!Array.isArray(provider.payload)) throw new Error('Invalid inline provider');
                    for (const node of provider.payload) this.addProviderNode(node, provider, source, providerIds);
                } else if (provider.type === 'http') {
                    const headers = Object.fromEntries(Object.entries(provider.header ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]));
                    const payload = await downloadSubscription(provider.url, headers);
                    const parsed: any = load(payload);
                    if (!Array.isArray(parsed?.proxies)) throw new Error('Provider must contain a proxies list');
                    for (const node of parsed.proxies) this.addProviderNode(node, provider, source, providerIds);
                } else {
                    throw new Error('Worker cannot load file or unknown providers');
                }
                this.addProvider(name, providerIds, structuredClone(provider));
            }
            return;
        }
        if (!text.includes('://')) {
            const decoded = base64Decode(text.replace(/\s/g, ''));
            if (decoded === text) throw new Error('Invalid subscription content');
            return this.parseContent(decoded, source, ids, depth + 1);
        }
        for (const line of text.split(/\r?\n/).map(v => v.trim()).filter(Boolean)) this.addNode(line, source, ids);
    }

    private addProviderNode(node: any, provider: Record<string, any>, source: number, ids: string[]): void {
        // Complex expression/name rewrites require Mihomo's own interpreter.
        // Never claim to have applied an override we cannot evaluate exactly.
        const override = provider.override ?? {};
        if (override['override-expr'] || override['proxy-name']) throw new Error('Unsupported provider expression override');
        const copy = { ...structuredClone(node) };
        for (const [key, value] of Object.entries(override)) {
            if (!['additional-prefix', 'additional-suffix'].includes(key)) copy[key] = value;
        }
        copy.name = (override['additional-prefix'] ?? '') + copy.name + (override['additional-suffix'] ?? '');
        const filtered = (subscriptionRegex(provider.filter)?.test(copy.name) === false)
            || (subscriptionRegex(provider['exclude-filter'])?.test(copy.name) === true)
            || String(provider['exclude-type'] ?? '').split('|').includes(copy.type);
        this.addNode(copy, source, ids, filtered);
    }

    private addNode(input: string | Record<string, any>, source: number, ids: string[], providerFiltered = false): void {
        this.stats.raw++;
        let parser: ParserType | null = null;
        const native = typeof input !== 'string' ? structuredClone(input) : null;
        try {
            if (native && (!native.name || !native.type || !native.server || !Number.isInteger(Number(native.port)) || Number(native.port) < 1 || Number(native.port) > 65535)) throw new Error('Invalid native proxy');
            let link: string;
            if (native && this.nativeYaml) {
                // Keep the native object intact. The existing VMess mapping is
                // a transport carrier only; it is replaced with this exact
                // object after the INI backend returns, never returned as VMess.
                link = 'vmess://' + base64Encode(JSON.stringify({ v: '2', ps: native.name, add: 'example.invalid', port: '443', id: crypto.randomUUID(), aid: '0', scy: 'auto', net: 'tcp', type: 'none', tls: '' }));
            } else {
                link = typeof input === 'string' ? input : getYamlProxies([input as any])[0];
            }
            if (!link) throw new Error('Unsupported proxy');
            if (link.startsWith('vmess://')) parser = new VmessParser(link);
            else if (link.startsWith('vless://')) parser = new VlessParser(link);
            else if (link.startsWith('trojan://')) parser = new TrojanParser(link);
            else if (link.startsWith('ss://')) parser = new SsParser(link);
            else if (link.startsWith('ssr://')) parser = new SsrParser(link);
            else if (link.startsWith('anytls://')) parser = new AnytlsParser(link);
            else if (this.isHysteria2(link)) parser = new Hysteria2Parser(link);
            else if (link.startsWith('tuic://')) parser = new TuicParser(link);
            if (!parser) throw new Error('Unsupported proxy');
            const originalName = native?.name ?? (link.startsWith('vmess://')
                ? parser.originPs
                : decodeURIComponent(parser.originPs).replace(/^#/, ''));
            const protocol = native?.type ?? link.split(':')[0];
            this.stats.parsed++;
            if (providerFiltered || (this.includeProtocol.length && !this.includeProtocol.includes(protocol) && !(protocol === 'ss' && this.includeProtocol.includes('shadowsocks')) && !(protocol === 'ssr' && this.includeProtocol.includes('shadowsocksr')))
                || (parser.tag && this.excludeTag.includes(parser.tag)) || (this.includeRegex && !this.includeRegex.test(originalName)) || this.excludeRegex?.test(originalName)) {
                this.stats.filtered++;
                return;
            }
            let name = String(originalName).replace(/\^LINK_TO\^/g, '-').replace(/\|/g, '-');
            if (!name) name = '节点 ' + source + '-' + this.stats.raw;
            const base = name;
            let suffix = 1;
            while (this.names.has(name)) name = base + ' [S' + source + '-' + suffix++ + ']';
            this.names.add(name);
            parser.updateOriginConfig(name);
            if (native && this.nativeYaml) {
                parser.restoreClash = (proxy: Record<string, any>, ps: string) => {
                    for (const key of Object.keys(proxy)) delete proxy[key];
                    Object.assign(proxy, structuredClone(native), { name: ps });
                    return proxy;
                };
            }
            this.urlSet.add(parser.confuseLink);
            this.originUrls.add(parser.originLink);
            this.vpsStore.set(parser.confusePs, parser);
            ids.push(parser.confusePs);
        } catch {
            this.stats.parseFailed++;
            throw new Error('Proxy parse failed');
        }
    }

    private isHysteria2(vps: string): boolean {
        return vps.startsWith('hysteria2://') || vps.startsWith('hysteria://') || vps.startsWith('hy2://');
    }

    public get urls(): string[] {
        return Array.from(this.urlSet);
    }

    public get vpsMap(): Map<string, ParserType> {
        return this.vpsStore;
    }

    public get originVps(): string[] {
        return Array.from(this.originUrls);
    }
}

