// Changes to the official Grok Bot 1.2.3 app.asar (Windows x64, macOS arm64, macOS x64,
// Linux x64 and Linux arm64), built into recipes by build.mjs. Each anchor must occur
// exactly once in its source; a different official build is refused instead of being half patched.
// Code that the recipes append lives in extensions/ (it is the source, not dead code).
//
// Edits: { prepend | append | replaceAll: text }, { insertBefore | insertAfter: anchor, text },
// { replace: anchor, text }, { cutFrom: anchor, text } (drops the rest of the file),
// { removeThrough: [startAnchor, endAnchor], text }.
import { readFileSync } from 'node:fs';

const extension = name => readFileSync(new URL(`./extensions/${name}`, import.meta.url), 'utf8');
const asset = name => `dist/renderer/assets/${name}`;
const edit = (name, edits) => ({ path: asset(name), source: asset(name), edits });
const I18N = "import { grokText } from './grok-local-i18n.js';\n";

export const PLATFORM_CHUNKS = {
  windows: {
    sentry: 'chunk-sentry-sdk-3vEdLH0q.js',
    eagerCommon: 'index.eager-common-D2eZn7JB.js',
    eagerApp: 'index.eager-app-DodVIpEt.js',
    connectedApps: 'chunk-view-CAIvK0CV.js',
    sharepointWrite: 'chunk-plugin-detail-sharepoint-write-BtyaeWb3.js',
    library: 'chunk-bot-store-files-library-BNT_Yru2.js',
    generalPane: 'chunk-general-pane-DQZ54SyA.js',
    computerView: 'chunk-view-B9ngRQ84.js',
    updateView: 'chunk-view-xV8CbwrQ.js',
    marketplaceBrowse: 'chunk-marketplace-browse-model-BlgGQ3lx.js',
    pluginDetail: 'chunk-plugin-detail-view-XqXPQSt0.js',
  },
  'mac-arm64': {
    sentry: 'chunk-sentry-sdk-CcmPN8dv.js',
    eagerCommon: 'index.eager-common-D2eZn7JB.js',
    eagerApp: 'index.eager-app-C3AkkLux.js',
    connectedApps: 'chunk-view-BG_fyL97.js',
    sharepointWrite: 'chunk-plugin-detail-sharepoint-write-BPwrNCMu.js',
    library: 'chunk-bot-store-files-library-cLISLDBk.js',
    generalPane: 'chunk-general-pane-GzzbbXEN.js',
    computerView: 'chunk-view-DBvIFHc9.js',
    updateView: 'chunk-view-BuQdbmNp.js',
    marketplaceBrowse: 'chunk-marketplace-browse-model-DkSCYsML.js',
    pluginDetail: 'chunk-plugin-detail-view-Jm29_C8X.js',
  },
  'mac-x64': {
    sentry: 'chunk-sentry-sdk-HCUyCkaO.js',
    eagerCommon: 'index.eager-common-D2eZn7JB.js',
    eagerApp: 'index.eager-app-BiroyIsg.js',
    connectedApps: 'chunk-view-C3j3Yy0H.js',
    sharepointWrite: 'chunk-plugin-detail-sharepoint-write-kXktwxEL.js',
    library: 'chunk-bot-store-files-library-C-Oexg5k.js',
    generalPane: 'chunk-general-pane-mzQRAJcg.js',
    computerView: 'chunk-view-CLKzvWVb.js',
    updateView: 'chunk-view-BRGRN7FA.js',
    marketplaceBrowse: 'chunk-marketplace-browse-model-BzNg1DeV.js',
    pluginDetail: 'chunk-plugin-detail-view-CRBo_LQw.js',
  },
  'linux-x64': {
    sentry: 'chunk-sentry-sdk-DiwFlyhv.js',
    eagerCommon: 'index.eager-common-D2eZn7JB.js',
    eagerApp: 'index.eager-app-B6gpFfGB.js',
    connectedApps: 'chunk-view-DAeC92nA.js',
    sharepointWrite: 'chunk-plugin-detail-sharepoint-write-DFY_To7o.js',
    library: 'chunk-bot-store-files-library-BabNGuF3.js',
    generalPane: 'chunk-general-pane-DwiXZcuU.js',
    computerView: 'chunk-view-ipXdZQ2n.js',
    updateView: 'chunk-view-J3AxaK3E.js',
    marketplaceBrowse: 'chunk-marketplace-browse-model-BZ0OEIU-.js',
    pluginDetail: 'chunk-plugin-detail-view-KtsNlj6B.js',
  },
  'linux-arm64': {
    sentry: 'chunk-sentry-sdk-DyX8qAMX.js',
    eagerCommon: 'index.eager-common-D2eZn7JB.js',
    eagerApp: 'index.eager-app-BaELD0Hn.js',
    connectedApps: 'chunk-view-BpGb0Cce.js',
    sharepointWrite: 'chunk-plugin-detail-sharepoint-write-CBhMdwnE.js',
    library: 'chunk-bot-store-files-library-DaTQnkTW.js',
    generalPane: 'chunk-general-pane-RrKGBYtS.js',
    computerView: 'chunk-view-D4BwHc8w.js',
    updateView: 'chunk-view-BH345BsV.js',
    marketplaceBrowse: 'chunk-marketplace-browse-model-CvCP2hBV.js',
    pluginDetail: 'chunk-plugin-detail-view-DYGvXJQx.js',
  },
};

export function buildSpec(target = 'windows') {
  const chunks = PLATFORM_CHUNKS[target];
  if (!chunks) throw new Error(`Unknown desktop recipe target: ${target}`);

  return [
    // The local client (mac/clients/desktop) reuses a few original main-process modules. Each
    // copy stops before the original entry point runs and exports what the client needs.
    {
      path: 'dist/electron-main/local-browser.cjs', source: 'dist/electron-main/main-app.cjs',
      edits: [
        { prepend: 'require("./local-shared.cjs");\n' },
        { cutFrom: 'var Wvt=S(vh()),qvt=S(fvt()),be=(0,Vvt.readMainCoreHandoff)();',
          text: '\nmodule.exports={requestPasskey:NVe,requestPin:DVe,updatePasskey:aXt,finishPasskey:s8};\n' },
      ],
    },
    {
      path: 'dist/electron-main/local-shared.cjs', source: 'dist/electron-main/main-core.cjs',
      edits: [
        { cutFrom: 'w9({killSwitch:process.env.CURSOR_DISABLE_HALF_OPEN_ASYNC_ITERATOR_FIX});var NJ=dNe(),OHe=U9({scope:"sand-desktop"});',
          text: '\nmodule.exports={activateLocale:Gp};\n' },
      ],
    },
    {
      path: 'dist/local-exec-daemon/main.cjs', source: 'dist/local-exec-daemon/main.cjs',
      edits: [
        { removeThrough: ['$Ht().catch(r=>{let e=r instanceof Error?r:new Error(String(r));process.stderr.write(`[sand-local-exec-daemon] fatal:',
          'finally(()=>process.exit(1))});'],
          text: 'module.exports={Provider:Xw,ComputerUse:Zw,findComputerHelper:vc,decideLocalUse:jW,isLocalUseBlocked:p9e,retireApproval:d9e,parseApproval:Rct};' },
      ],
    },
    {
      path: 'dist/node-agent-coordinator/local-browser.cjs', source: 'dist/node-agent-coordinator/main.cjs',
      edits: [
        { cutFrom: 'oRe().catch(n=>{process.stderr.write(`node-agent-coordinator: composition failure:',
          text: '\nmodule.exports={passkeyProvider:WH,signer:e2,findSigner:QH,relyingParty:zH,interval:Is,reconnect:rRe,deadline:nt,watchdog:zr,delivery:Jt,expiry:Pi};\n' },
      ],
    },

    { path: asset('grok-local-i18n.js'), source: null, edits: [{ append: extension('grok-local-i18n.js') }] },

    // No crash reports leave the local client.
    edit(chunks.sentry, [
      { replaceAll: 'const noop=()=>{};export function initSandSentrySdk(){return{captureException:noop,captureMessage:noop,setTag:noop,withScope:noop}}' },
    ]),
    edit(chunks.eagerCommon, [
      { insertBefore: 'if(Yt(e[0])){if(Wt.size===0)qt({kind:`exception`,args:e})', text: 'return;' },
      { insertBefore: 'if(Wt.size===0)qt({kind:`message`,args:e})', text: 'return;' },
    ]),

    // Connected apps: only apps the Host can serve, a local empty state and the Host's share link.
    edit(chunks.connectedApps, [
      { replace: 'c=r?n.filter(il):n;', text: 'c=n.filter(il);' },
      { replace: 'onSelect:()=>y(hn(O)),children:F', text: 'onSelect:()=>y(n.shareUrl),children:F' },
    ]),
    edit(chunks.sharepointWrite, [
      { prepend: I18N },
      { replace: ':e(ye)}function yt(e){', text: ':grokText(`暂无连接应用`,`No connected apps`)}function yt(e){' },
    ]),

    // Bot library: the Host accepts 20 MiB per file, 100 files and 100 MiB per Bot. Host Bots
    // keep one shared library and no per-user store; files can be picked as well as dropped.
    edit(chunks.library, [
      { prepend: I18N + `import { yT as GrokButton } from './${chunks.eagerApp}';\n` },
      { replace: 'ie=26214400,j=1073741824', text: 'ie=20971520,j=104857600' },
      { replace: 'e.sizeBytes>26214400?{kind:`too-large`}:t.fileCount>=200?{kind:`too-many-files`}:t.totalBytes+e.sizeBytes>1073741824?',
        text: 'e.sizeBytes>20971520?{kind:`too-large`}:t.fileCount>=100?{kind:`too-many-files`}:t.totalBytes+e.sizeBytes>104857600?' },
      { replace: 'let he;return t[57]!==J||t[58]!==$?(he=(0,V.jsxs)(V.Fragment,{children:[J,$]}),t[57]=J,t[58]=$,t[59]=he):he=t[59],he}',
        text: 'return(0,V.jsxs)(V.Fragment,{children:[j?(0,V.jsx)(GrokLibraryUpload,{upload:N,disabled:P}):null,$]})}' },
      { append: extension('library.js') },
    ]),

    // Settings > General: the account card shows this Host and opens the connection dialog;
    // realtime voice is a local setting; no security key proxy.
    edit(chunks.generalPane, [
      { prepend: I18N },
      { replace: '(W=(0,$.jsx)(`span`,{className:U,children:F}),',
        text: '(W=typeof F==`string`?(0,$.jsx)(GrokAccountName,{className:U,name:F,onCommit:name=>n.updateName(name)}):(0,$.jsx)(`span`,{className:U,children:F}),' },
      { replace: '(ie=(0,$.jsx)(`span`,{className:re,children:j}),',
        text: '(ie=(0,$.jsx)(`span`,{className:re,children:(0,$.jsx)(GrokAccountHost,{})}),' },
      { replace: '(se=k?(0,$.jsx)(q,{disabled:I,onClick:i?()=>void n.cancelLoginFlight():()=>void c(),size:`md`,style:gr.actionWeakBorder,variant:`secondary`,children:i?(0,$.jsx)(Y,{id:`dEgA5A`}):(0,$.jsx)(Y,{id:`MPPZ54`})}):null,',
        text: '(se=(0,$.jsx)(GrokHostConnection,{}),' },
      // Notification sounds are a development-only section upstream; show it without DEV markers.
      { replace: '(n=t?(0,$.jsx)(Zi,{}):null,', text: '(n=(0,$.jsx)(Zi,{}),' },
      { replace: '(f=(0,$.jsx)(rt,{children:d}),', text: '(f=d,' },
      { replace: 'label:ke(n({id:`6EhUT7`}))', text: 'label:n({id:`6EhUT7`})' },
      { replace: '"aria-label":ke(n({id:`wm7RV4`}))', text: '"aria-label":n({id:`wm7RV4`})' },
      // Auto-review: a short description, and no team-rule hints.
      { replace: '(g=a(l==null?{id:`De8ppO`}:{id:`QqKsGg`}),',
        text: '(g=l==null?grokText(`运行操作前检查，需要时询问。`,`Review actions and ask when needed.`):a({id:`QqKsGg`}),' },
      { replace: '(0,$.jsx)(Un,{children:(0,$.jsx)(Y,{id:`NFRGrQ`})})', text: 'null' },
      { replace: '(0,$.jsx)(it,{as:`span`,color:`tertiary`,level:`body2`,children:h})]}):null', text: 'null]}):null' },
      { replace: 'children:[l,f,p,m,b,x,h,g,_,v,y,S,C,w,T,E]',
        text: 'children:[l,f,(0,$.jsx)(GrokRealtimeVoiceSettings,{}),p,m,b,x,h,g,_,v,y,S,w,T,E]' },
      { append: extension('general-pane.js') },
    ]),

    // Settings > Computer: the Host manages the Bot's computer; this computer's access stays.
    edit(chunks.computerView, [
      { prepend: I18N },
      { replace: '(0,Q.jsxs)(`div`,{...n,children:[i,a,o,s]})',
        text: '(0,Q.jsxs)(`div`,{...n,children:[(0,Q.jsx)(GrokRemoteDesktop,{}),i,a,o]})' },
      { append: extension('computer-view.js') },
    ]),

    // Settings > Updates: the local build has no updater.
    edit(chunks.updateView, [
      { prepend: I18N },
      { replace: '(t=(0,x.jsx)(_,{children:(0,x.jsx)(T,{})}),',
        text: '(t=(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalVersion,{})}),' },
      { append: extension('update-view.js') },
    ]),

    // Marketplace: Host apps form their own category; hide public links for both Host and LOGIN_AND_CREDENTIAL_MANAGEMENT entries.
    edit(chunks.marketplaceBrowse, [
      { replace: 'var u=[`credentials`,', text: 'var u=[`host`,`credentials`,' },
      { replace: 'd={LOGIN_AND_CREDENTIAL_MANAGEMENT:`credentials`,', text: 'd={HOST:`host`,LOGIN_AND_CREDENTIAL_MANAGEMENT:`credentials`,' },
      { replace: 'var T={credentials:{id:`P+nzjE`},', text: 'var T={host:{id:`Host`,message:`Host`},credentials:{id:`P+nzjE`},' },
    ]),
    edit(chunks.pluginDetail, [
      { replace: 'function kt(e,t){if(e.marketplace?.ownership===`user`)return null;',
        text: 'function kt(e,t){if(e.category===`Host`||e.category===`LOGIN_AND_CREDENTIAL_MANAGEMENT`)return null;if(e.marketplace?.ownership===`user`)return null;' },
    ]),

    edit(chunks.eagerApp, [
      { prepend: I18N + `const GROK_LIBRARY_CHUNK = './${chunks.library}';\n` },
      { replace: 'vV={FEATURED:{id:`FkMol5`},', text: 'vV={HOST:{id:`Host`,message:`Host`},FEATURED:{id:`FkMol5`},' },
      // Account menu: connection settings instead of adding a cloud account; no mobile app offer.
      { replace: '(ht=(0,Z.jsxs)(zw.Section,{children:[ut,dt,mt]}),', text: '(ht=(0,Z.jsxs)(zw.Section,{children:[dt,mt]}),' },
      { replace: 'onSelect:et,children:(0,Z.jsx)(qo,{id:`MPPZ54`})}):null,',
        text: 'onSelect:()=>{window.__grokLocalConnectionRequested=true;c(`general`);window.dispatchEvent(new Event(`grokbot-local:connect-request`))},children:grokText(`连接设置`,`Connection settings`)}):null,' },
      // Signing out disconnects from the Host; nothing stays on a cloud computer.
      { replace: 'description:_ae(e)===null?na._({id:`5qRD8O`}):na._({id:`W51kAS`}),', text: 'description:``,' },
      // Bot settings: title, instructions and library files are kept on the Host; the Host
      // chooses the voice, so neither the Bot nor a call offers voice settings.
      { replace: '(c=(0,Z.jsxs)(`div`,{...r,children:[i,o,s]}),',
        text: '(c=(0,Z.jsxs)(`div`,{...r,children:[i,o,s,(0,Z.jsx)(GrokLocalSettings,{agent:n})]}),' },
      { insertAfter: 'function aTt(e){', text: 'return null;' },
      { replace: 'let M=j;!M&&(g===`settings`||v===`settings`)', text: 'let M=!1;!M&&(g===`settings`||v===`settings`)' },
      // Connected apps: hide built-in official 1Password native entry; no link to the cloud Bot templates.
      { replace: 'n=oc({onepassword:!0,email:t})', text: 'n=oc({onepassword:!1,email:t})' },
      { insertAfter: 'function k1t(){', text: 'return null;' },
      // No crash reporter, heap samples or idle sampling.
      { insertAfter: 'function f6e(e,t,n=d6e){', text: 'return{load:async()=>{},setTag:()=>{}};' },
      { insertAfter: 'function AZr(e,t,n={}){', text: 'return()=>{};' },
      { insertAfter: 'function LZr(e,t=document){', text: 'return{sampleIdleMinutes:()=>void 0,stop:()=>{}};' },
      // Realtime calls go to the Host relay (host/server/voice-session.mjs), which transcribes,
      // runs the Bot, speaks and records the call. The client sends no presence, nudges,
      // written turns, greeting or tool results, keeps no call journal and never resumes.
      { replace: 'ue=(t,n)=>e.source.setVoiceCallPresence({id:t.agentId,callId:t.callId,isOnTheLine:n,acceptsOverheard:t.acceptsOverheard})',
        text: 'ue=(t,n)=>Promise.resolve()' },
      { insertAfter: 'De=async(t,n,r,i)=>{if(!hK.canHangUp(t.phase))return;', text: 'n===`hung-up`&&t.session?.localVoiceEndCall?.();' },
      { replace: 'I=e=>e.didConnect?(e.journalLine??=', text: 'I=e=>!1?(e.journalLine??=' },
      { insertBefore: 'let n=j();if(n===null||n.phase===`ending`||n.agentId!==t.agentId||n.callId!==t.callId', text: 'return;' },
      { insertBefore: 'let i=j();if(i===null||!hK.isCallerOnTheLine(i.phase)||i.agentId!==t||n!==i.thread.sessionId)return;Ae(i,r);', text: 'return;' },
      // Turning realtime voice off in Settings ends the current call.
      { insertAfter: 'Ne=e.transcript.observeEntriesFeed({onAppended:je,onBaseline:Me,onFetched:({agentId:e,sessionId:t,read:n})=>Me({agentId:e,sessionId:t,entries:n})})',
        text: ',grokVoicePreferenceRelease=window.localBot.onVoicePreferenceChanged(enabled=>{enabled||void re()})' },
      { replace: 'dispose(){Ne();', text: 'dispose(){grokVoicePreferenceRelease(),Ne();' },
      // The local client mints a short-lived ticket for this Host; only that address is dialable.
      { replace: 'let r=await e.desktop.mintVoiceCallCredential();',
        text: 'let r=await window.localBot.mintVoiceCredential(this.dial.agentId);grokVoiceEndpoint=r.ok?r.credential.websocketUrl:null;' },
      { replace: 'function _Xr(e){return gXr(e.desktop,hXr(e))}',
        text: 'function _Xr(e){return{session:async()=>({instructions:``,tools:[],hasOverheard:!1,greeting:{direction:``,withLandedWork:``}}),callTool:async()=>{throw Error(`Voice tools are managed by the Host`)}}}' },
      { replace: 'var r1r=class e{static DIALABLE_ORIGIN=`wss://api.x.ai/`;static isDialableURL(t){return t.startsWith(e.DIALABLE_ORIGIN)}',
        text: 'let grokVoiceEndpoint=null;var r1r=class e{static isDialableURL(t){return typeof t==`string`&&t===grokVoiceEndpoint}' },
      // Speech plays through a media element, and the Host hears when each reply finished
      // playing (response.playback.done) and when the caller hangs up (session.close).
      { replace: 'let s=r.createMediaStreamDestination(),c=new e(r,a,o,s,t);return c.hold(n,i),c}',
        text: 'let s=r.createMediaStreamDestination(),speaker=new Audio;speaker.autoplay=!0,speaker.srcObject=s.stream,await speaker.play();let c=new e(r,a,o,s,t);return c.localOutput=speaker,c.hold(n,i),c}' },
      { replace: 'n.connect(this.context.destination),n.connect(this.speakerTap);', text: 'n.connect(this.speakerTap);' },
      { replace: 'teardown(){this.dropScheduledSpeech(),',
        text: 'teardown(){this.localOutput?.pause(),this.localOutput&&(this.localOutput.srcObject=null),this.dropScheduledSpeech(),' },
      { replace: 'responseHeard=[];socket;router;responses;',
        text: 'responseHeard=[];localVoiceHeard=new Set;localVoiceGeneration=0;socket;router;responses;' },
      { replace: 'onCallerInterrupted:()=>{this.cancelUserFirstOpen(),',
        text: 'onCallerInterrupted:()=>{this.localVoiceGeneration++,this.localVoiceHeard.clear(),this.cancelUserFirstOpen(),' },
      { replace: 'onAssistantResponseEnded:e=>{this.sendTruncations(',
        text: 'onAssistantResponseEnded:e=>{e||void this.localVoicePlaybackDone(),this.sendTruncations(' },
      { replace: 't.speak(e,this.responses.speaksForNudgeId),this.args.handlers.onAudioReceived?.()',
        text: 't.speak(e,this.responses.speaksForNudgeId),e.itemId!==null&&this.localVoiceHeard.add(e.itemId),this.args.handlers.onAudioReceived?.()' },
      { insertAfter: 'thisResponseHasBeenHeard(){for(let e of this.responseHeard.splice(0))e()}',
        text: 'async localVoicePlaybackDone(){let items=[...this.localVoiceHeard],generation=this.localVoiceGeneration,audio=this.audio;if(audio===null||items.length===0)return;try{await audio.whenScheduledSpeechEnds()}catch{return}if(this.phase.kind!==`live`||generation!==this.localVoiceGeneration||this.router.callerIsSpeaking||this.socketSilentlyDiscardsFrames())return;for(let item_id of items)this.socket.send(JSON.stringify({type:`response.playback.done`,item_id}));this.localVoiceHeard.clear()}localVoiceEndCall(){this.socketSilentlyDiscardsFrames()||this.socket.send(JSON.stringify({type:`session.close`}))}' },
      { replace: 't.kind===`event`&&this.router.route(t.event)',
        text: 't.kind===`event`&&((t.event.type===`response.created`||t.event.type===`response.cancelled`)&&(this.localVoiceGeneration++,this.localVoiceHeard.clear()),this.router.route(t.event))' },
      { replace: 'openAfterUserFirstGrace(){let e=this.pendingConnectGreeting;e!==null&&(this.pendingConnectGreeting=null,this.responses.greet(e))}',
        text: 'openAfterUserFirstGrace(){this.cancelUserFirstOpen()}' },
      { replace: 'resumption:{enabled:!0}', text: 'resumption:{enabled:!1}' },
      { append: extension('eager-app.js') },
    ]),

    // The render-trace hook installs a React DevTools stub for the vendor's render sampling,
    // which this client does not run.
    { path: 'dist/renderer/index.html', source: 'dist/renderer/index.html', edits: [
      { replace: '    <script src="./assets/dune-render-trace-hook-265eb7be.js"></script>\n', text: '' },
    ] },
  ];
}

export const SPEC = buildSpec('windows');
