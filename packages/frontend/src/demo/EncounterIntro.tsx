import { Compass, Layers3, Swords, Users } from 'lucide-react';

/** Decorative encounter illustration, deliberately separate from the live map. */
export function EncounterIntro() {
  return <section className="demo-encounter-intro" aria-labelledby="encounter-title">
    <div className="demo-intro-kicker"><span />多人战术遭遇 <span className="demo-intro-kicker-line" /> ENCOUNTER</div>
    <h1 id="encounter-title">战术遭遇<span>TACTICAL ENCOUNTER</span></h1>
    <p className="demo-intro-description">集结你的队伍，在每一次交锋中做出选择。<br />行动、空间与裁决，交汇于同一条时间轴。</p>
    <div className="demo-intro-map" aria-hidden="true">
      <div className="demo-intro-map-caption"><Compass size={14} /> Elysian VTT · 战术沙盘 <span>场景示意</span></div>
      <svg viewBox="0 0 560 250" fill="none">
        <defs>
          <pattern id="intro-hex" width="52" height="45" patternUnits="userSpaceOnUse"><path d="M13 0H39L52 22.5 39 45H13L0 22.5Z" stroke="#7aafa2" strokeOpacity=".13" /></pattern>
          <linearGradient id="intro-river" x1="310" y1="0" x2="270" y2="250" gradientUnits="userSpaceOnUse"><stop stopColor="#1b4b56" /><stop offset="1" stopColor="#102c38" /></linearGradient>
          <radialGradient id="intro-glow"><stop stopColor="#72d9b5" stopOpacity=".15" /><stop offset="1" stopColor="#72d9b5" stopOpacity="0" /></radialGradient>
        </defs>
        <ellipse cx="185" cy="145" rx="210" ry="140" fill="url(#intro-glow)" />
        <path d="M281-20C227 48 352 71 288 126S239 202 291 270H361C307 211 344 187 367 151S349 61 365-20Z" fill="url(#intro-river)" />
        <path d="M281-20C227 48 352 71 288 126S239 202 291 270M365-20C349 61 390 110 367 151S307 211 361 270" stroke="#508184" strokeOpacity=".5" />
        <path d="M317 8C276 60 376 89 326 138S286 203 328 248" stroke="#5f9b9c" strokeDasharray="5 9" strokeOpacity=".3" />
        <path d="M0 0H560V250H0Z" fill="url(#intro-hex)" />
        <path d="M120 186L172 139 224 139 277 94 380 94" stroke="#7cd4b8" strokeWidth="1.5" strokeDasharray="5 6" />
        <g stroke="#a39168" fill="#242f30"><path d="M270 78H379V110H270Z" /><path d="M278 78V110M289 78V110M300 78V110M311 78V110M322 78V110M333 78V110M344 78V110M355 78V110M366 78V110" strokeOpacity=".5" /><path d="M268 75H382M268 114H382" strokeWidth="2" /></g>
        <g stroke="#768277" strokeOpacity=".5" fill="#25302e"><path d="M83 48H128V78H83Z" /><path d="M92 37H136V67H92Z" /><path d="M416 150H451V194H416Z" /><path d="M426 141H461V183H426Z" /></g>
        <g fill="#0d2426" stroke="#80d5b5"><circle cx="172" cy="139" r="25" strokeOpacity=".25" /><circle cx="172" cy="139" r="16" /><path d="M165 132L179 146M179 132L165 146M164 140L171 147M173 131L180 138" strokeWidth="1.8" /><circle cx="120" cy="186" r="13" /><path d="M115 186L120 180 125 186 120 192Z" /><circle cx="223" cy="183" r="13" /><path d="M223 176V190M216 183H230" /></g>
        <g stroke="#d4a46f" fill="#302721"><circle cx="410" cy="94" r="18" /><path d="M410 84L418 94 410 104 402 94Z" /><circle cx="460" cy="49" r="12" /><path d="M455 49H465M460 44V54" /></g>
        <g fill="#a6c6be" fontFamily="sans-serif" fontSize="10" letterSpacing="2"><text x="143" y="105">YOUR PARTY</text><text x="389" y="130" fill="#bb9e7b">CROSSING</text></g>
        <path d="M24 24H45M24 24V45M536 24H515M536 24V45M24 226H45M24 226V205M536 226H515M536 226V205" stroke="#719489" strokeOpacity=".5" />
      </svg>
      <div className="demo-intro-map-legend"><span><i />玩家队伍</span><span><i />敌方单位</span><span>谋定 · 而后动</span></div>
    </div>
    <div className="demo-intro-features">
      <div><Users size={17} /><span><strong>1 位主持 · 3 位玩家</strong><small>协作进入同一场遭遇</small></span></div>
      <div><Layers3 size={17} /><span><strong>离散时间轴</strong><small>每次行动都有时机</small></span></div>
      <div><Swords size={17} /><span><strong>即时反应</strong><small>把握交锋中的决策</small></span></div>
    </div>
  </section>;
}
