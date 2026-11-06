import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load, dump } from 'js-yaml';
import { UrlService } from '../src/services/url.service';
import { ClashClient as MergeClient } from '../src/core/confuse/client/clash';
import { ClashClient as RestoreClient } from '../src/core/restore/client/clash';
import { isHighMultiplier } from '../src/core/parser/subscription';

const ini = fs.readFileSync('test/fixtures/full.ini', 'utf8');
const groupLines = ini.split(/\r?\n/).filter(s => s.startsWith('custom_proxy_group='));
assert.equal(groupLines.length, 64);
assert.equal(ini.split(/\r?\n/).filter(s => s.startsWith('ruleset=')).length, 64);
const originalFetch = globalThis.fetch;
const key='11111111-1111-4111-8111-111111111111';
const nodes: any[] = [];
const sources = new Map<string,string>();
const ss=(name: string, i: number) => ({name,type:'ss',server:`node${i}.example.com`,port:443,cipher:'aes-128-gcm',password:`fake-${i}`,udp:true});
for (let i=0;i<14;i++) {
    const proxies=[ss('香港 重复 1x',i*10),ss('美国 重复 200Mbps 2026',i*10+1),ss('日本 重复 2.5x',i*10+2),ss('官网 流量',i*10+3)];
    // Native fields not representable in URI must survive byte-for-byte as data.
    if(i===0) {
        proxies[0].name += ' 剩余99%';
        proxies[1] = {name:proxies[1].name,type:'vless',server:'vless.example.com',port:443,uuid:key,tls:true,servername:'sni.example.com',flow:'xtls-rprx-vision','client-fingerprint':'chrome','reality-opts':{'public-key':'c29tZS1maWtlLXB1YmxpYy1rZXktMzItYnl0ZXMteHg','short-id':'0123456789abcdef'},network:'grpc','grpc-opts':{'grpc-service-name':'service'},udp:true} as any;
    }
    if(i===1) proxies[1] = {name:proxies[1].name,type:'hysteria2',server:'hy2.example.com',port:443,password:'fake-hy2',sni:'sni.example.com',alpn:['h3'],obfs:'salamander','obfs-password':'fake-obfs'} as any;
    if(i===2) proxies[1] = {name:proxies[1].name,type:'tuic',server:'tuic.example.com',port:443,uuid:key,password:'fake-tuic','congestion-controller':'bbr','udp-relay-mode':'native',alpn:['h3'],sni:'sni.example.com'} as any;
    if(i===3) proxies[1] = {name:proxies[1].name,type:'anytls',server:'anytls.example.com',port:443,password:'fake-anytls',sni:'sni.example.com','idle-session-check-interval':30} as any;
    if(i===4) proxies[1] = {name:proxies[1].name,type:'wireguard',server:'wg.example.com',port:51820,ip:'172.16.0.2','private-key':'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=','public-key':'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',reserved:[1,2,3],mtu:1280,udp:true} as any;
    const config:any={proxies};
    if(i<2){const p=ss('加拿大 Provider',i+200);config['proxy-providers']={'同名机场':{type:'inline',payload:[p],'health-check':{enable:false}}};nodes.push(p)}
    nodes.push(...proxies.filter(p=>!p.name.includes('官网')));
    sources.set(`https://source.test/${i}`,dump(config));
}
let mode='mock';
let failSource=false;
let backendCalls=0;
const outputBackend = (url: URL) => {
    backendCalls++;
    assert.equal(url.searchParams.get('exclude'),null);
    assert.equal(url.searchParams.get('include'),null);
    assert.equal(url.searchParams.get('config'),'https://raw.githubusercontent.com/hadesp/Custom_OpenClash_Rules/main/cfg/Custom_Clash_Full.ini');
    const proxies=url.searchParams.get('url')!.split('|').map(link=>{
        const v=JSON.parse(Buffer.from(link.slice('vmess://'.length),'base64').toString());
        return {name:v.ps,type:'vmess',server:v.add,port:Number(v.port),uuid:v.id,alterId:0,cipher:'auto'};
    });
    const groups=groupLines.map(line=>{
        const [name,type,...parts]=line.slice('custom_proxy_group='.length).split('`');
        const members:string[]=[];
        for(const p of parts){
            if(p.startsWith('[]')) members.push(p.slice(2));
            else if(!p.startsWith('http') && !/^\d/.test(p)) {
                const re=new RegExp(p);
                members.push(...proxies.filter(n=>re.test(n.name)).map(n=>n.name));
            }
        }
        return {name,type,proxies:members.length?members:['DIRECT'],...(type==='url-test'?{url:'https://www.gstatic.com/generate_204',interval:300,tolerance:50}:{})};
    });
    return new Response(dump({proxies,'proxy-groups':groups,rules:['DOMAIN,scholar.google.com,🇬 谷歌服务','DOMAIN,nature.com,📚 学术资源','MATCH,🚀 手动选择']}));
};
globalThis.fetch=async(input:any,init?:any)=>{
    const url=new URL(typeof input==='string'?input:input.url??input.toString());
    if(url.hostname==='source.test'){
        if(failSource && url.pathname==='/13')return new Response('failure',{status:503});
        return new Response(sources.get(url.href),{status:sources.has(url.href)?200:404});
    }
    if(mode==='mock'&&url.pathname==='/sub')return outputBackend(url);
    return originalFetch(input,init);
};
const service=new UrlService(null);
const request=()=>{
    const url=new URL('https://worker.test/sub');
    url.searchParams.set('target','clash');
    url.searchParams.set('url',[...sources.keys()].join('|'));
    url.searchParams.set('exclude','(?i)(官网|流量|过期)');
    url.searchParams.set('include','重复|Provider');
    url.searchParams.set('emoji','false');
    url.searchParams.set('append_type','false');
    return new Request(url);
};
const result=await service.toSub(request(),{} as Env,'clash');
assert.match(result.contentType,/yaml/);
const config:any=load(result.body);
assert.equal(backendCalls,3);
assert.deepEqual(config['x-sub-convert'],{raw:58,parsed:58,filtered:14,parseFailed:0,restoreFailed:0,final:44,subscriptions:14,inputProviders:2,providers:16,removedEmptyGroups:config['x-sub-convert'].removedEmptyGroups});
assert.equal(new Set(config.proxies.map((p:any)=>p.name)).size,44);
for(const p of nodes){const match=config.proxies.find((n:any)=>n.server===p.server&&n.type===p.type);assert.ok(match);assert.deepEqual({...match,name:p.name},p)}
const providers=Object.values(config['proxy-providers']) as any[];
assert.equal(providers.length,16);
assert.equal(providers.reduce((sum,p)=>sum+p.payload.length,0),44);
assert.ok(config['proxy-providers']['同名机场']);assert.ok(config['proxy-providers']['同名机场 [2]']);
const removed=new Set(config['x-sub-convert'].removedEmptyGroups);
assert.equal(config['proxy-groups'].length,64-removed.size);
const valid=new Set(config.proxies.map((p:any)=>p.name));
for(const g of config['proxy-groups']){
    assert.ok(g.proxies.every((p:string)=>!removed.has(p)));
    if(g.name.endsWith('节点')||g.name==='🌐 其他地区')assert.ok(g.proxies.length&&g.proxies.every((n:string)=>valid.has(n)));
    const line=groupLines.find(l=>l.split('`')[0]==='custom_proxy_group='+g.name);
    if(line && /(?:香港|美国|日本|新加坡|台湾|韩国|加拿大|英国|法国|德国|荷兰|土耳其|俄罗斯)节点$/.test(g.name)){
        const re=new RegExp(line.split('`')[2]);assert.ok(g.proxies.every((n:string)=>re.test(n)));
    }
}
const high=config['proxy-groups'].find((g:any)=>g.name==='🔥 高倍率节点');assert.equal(high.proxies.length,14);
const auto=config['proxy-groups'].find((g:any)=>g.name==='♻️ 自动选择');assert.ok(auto.proxies.every((n:string)=>!isHighMultiplier(n)));
const manual=config['proxy-groups'].find((g:any)=>g.name==='🚀 手动选择');assert.ok(config.proxies.every((p:any)=>manual.use.some((name:string)=>config['proxy-providers'][name].payload.some((n:any)=>n.name===p.name))));assert.equal(manual.use.length,16);
assert.equal(config['proxy-groups'].find((g:any)=>g.name==='📚 学术资源').proxies[0],'🎯 全球直连');
assert.ok(config['proxy-groups'].find((g:any)=>g.name==='🎯 全球直连').proxies.includes('DIRECT'));
for(const name of ['2026','200Mbps','2Gbps','192.168.2.3:2026','x200Mbps','20Mbps'])assert.equal(isHighMultiplier(name),false,name);
for(const name of ['2x','2.5x','10x','2倍','高倍','倍率:20'])assert.equal(isHighMultiplier(name),true,name);
await assert.rejects(()=>service.toSub(new Request('https://worker.test/sub?url=unknown%3A%2F%2Fbad'),{} as Env,'clash'),/Subscription 1 failed/);
failSource=true;await assert.rejects(()=>service.toSub(request(),{} as Env,'clash'),/Subscription 14 failed/);failSource=false;
const originalSource=sources.get('https://source.test/0')!;sources.set('https://source.test/0','proxies:\n - name: broken');await assert.rejects(()=>service.toSub(request(),{} as Env,'clash'),/Subscription 1 failed/);sources.set('https://source.test/0',originalSource);
await assert.rejects(()=>service.toSub(new Request('https://worker.test/sub?url=ss%3A%2F%2Fa&include=%5B'),{} as Env,'clash'),/regex/);
assert.throws(()=>new RestoreClient({proxies:[{name:'unmapped'}],'proxy-groups':[]} as any).getOriginConfig(new Map()),/restoration/);
const merge=new MergeClient() as any;
const merged=merge.mergeClashConfig([{proxies:[],'proxy-providers':{airport:{type:'inline',payload:[ss('a',1)]}},'proxy-groups':[{name:'G',type:'select',use:['airport']}]},{proxies:[],'proxy-providers':{airport:{type:'inline',payload:[ss('b',2)]}},'proxy-groups':[{name:'G',type:'select',use:['airport']}]}]);
assert.equal(Object.keys(merged['proxy-providers']).length,2);assert.deepEqual(merged['proxy-groups'][0].use,['airport','airport [B2-1]']);
fs.writeFileSync('../regression-mock.yaml',result.body);
console.log(JSON.stringify({phase:'mock',stats:config['x-sub-convert'],groups:config['proxy-groups'].length,backendCalls}));
// Exercise the unchanged real BACKEND with the same 14 synthetic sources.
mode='live';
const live=await service.toSub(request(),{} as Env,'clash');
const real:any=load(live.body);
assert.equal(real.proxies.length,44);assert.equal(Object.keys(real['proxy-providers']).length,16);
for(const g of real['proxy-groups'])if(g.name.endsWith('节点')||g.name==='🌐 其他地区')assert.ok(g.proxies.every((p:string)=>p!=='DIRECT'&&p!=='REJECT'));
assert.equal(real['proxy-groups'].find((g:any)=>g.name==='📚 学术资源').proxies[0],'🎯 全球直连');
fs.writeFileSync('../regression-live.yaml',live.body);
console.log(JSON.stringify({phase:'live-backend',stats:real['x-sub-convert'],groups:real['proxy-groups'].length,rules:real.rules?.length}));
const vmess='vmess://'+Buffer.from(JSON.stringify({v:'2',ps:'美国 URI VMess 剩余99%',add:'vmess.example.com',port:'443',id:key,aid:'0',scy:'auto',net:'tcp',type:'none',tls:'tls',sni:'sni.example.com'})).toString('base64');
const ssuri='ss://'+Buffer.from('aes-128-gcm:fake-ss').toString('base64')+'@ss.example.com:443#'+encodeURIComponent('日本 URI SS');
const trojan='trojan://fake-trojan@trojan.example.com:443?sni=sni.example.com#'+encodeURIComponent('香港 URI Trojan');
sources.set('https://source.test/uri',Buffer.from([vmess,ssuri,trojan].join('\n')).toString('base64'));
const uriRequest=new URL('https://worker.test/sub?target=clash&emoji=false&append_type=false');uriRequest.searchParams.set('url','https://source.test/uri');
const uriResult=await service.toSub(new Request(uriRequest),{} as Env,'clash');
const uriConfig:any=load(uriResult.body);assert.equal(uriConfig.proxies.length,3);assert.equal(uriConfig['x-sub-convert'].raw,3);
assert.equal(uriConfig.proxies.find((p:any)=>p.type==='vmess').servername,'sni.example.com');
assert.equal(uriConfig.proxies.find((p:any)=>p.type==='ss').password,'fake-ss');
assert.equal(uriConfig.proxies.find((p:any)=>p.type==='trojan').password,'fake-trojan');
fs.writeFileSync('../regression-uri.yaml',uriResult.body);
console.log(JSON.stringify({phase:'uri-base64-live-backend',stats:uriConfig['x-sub-convert']}));
globalThis.fetch=originalFetch;
