/** Presentation-only styles kept with the demo's TypeScript UI sources. */
export function DemoAppearance() {
  return <style>{`
    :root {
      color-scheme: dark;
      --demo-bg: #0c1318;
      --demo-bg-deep: #080e12;
      --demo-panel: #131f27;
      --demo-panel-soft: #192a32;
      --demo-line: rgba(168, 194, 196, .14);
      --demo-line-strong: rgba(168, 194, 196, .27);
      --demo-text: #e7eeeb;
      --demo-muted: #9bb0b6;
      --demo-teal: #8ad6b9;
      --demo-amber: #d9b87c;
      font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    }
    .demo-app, .demo-login-page { line-height: 1.5; }
    .demo-app :is(button, input, select, textarea):focus-visible,
    .demo-login-page :is(button, input):focus-visible { outline: 2px solid var(--demo-teal); outline-offset: 3px; }
    .demo-app :is(button, input, select, textarea), .demo-login-page :is(button, input) { transition: border-color .16s, background .16s, box-shadow .16s; }
    .demo-app ::selection, .demo-login-page ::selection { background: #8ad6b938; }
    .demo-app ::-webkit-scrollbar { width: 6px; height: 6px; }
    .demo-app ::-webkit-scrollbar-thumb { background: #425c62; border-radius: 6px; }
    .demo-app ::-webkit-scrollbar-track { background: transparent; }
    .demo-eyebrow { font-size: 10px; letter-spacing: .15em; }
    .demo-muted, .demo-empty { font-size: 12px; line-height: 1.65; }
    .demo-panel, .demo-shell-card { border-radius: 12px; box-shadow: 0 12px 32px #0002; }
    .demo-button { min-height: 36px; padding: 0 13px; font-size: 12px; font-weight: 500; border-radius: 6px; }
    .demo-button:hover:not(:disabled) { transform: none; }
    .demo-button.primary { background: #8ad6b9; border-color: #8ad6b9; color: #102b24; font-weight: 650; }
    .demo-button.primary:hover:not(:disabled) { background: #a6e8cc; border-color: #a6e8cc; }
    .demo-button:disabled { opacity: .48; }
    .demo-button.tiny { min-height: 30px; font-size: 11px; }
    .demo-button small { font-size: 10px; }
    .demo-input, .demo-select { height: 36px; font-size: 12px; border-radius: 6px; background: #0c161d; }
    .demo-input::placeholder, .demo-textarea::placeholder { color: #7f979f; opacity: 1; }
    .demo-select.compact { height: 32px; }
    .demo-textarea { font-size: 12px; }
    .demo-pill { min-height: 25px; font-size: 11px; }
    .demo-form-error, .demo-inline-error, .demo-notice { font-size: 12px; }
    .demo-header { background: #0b131bf2; padding: 0 24px; gap: 16px; }
    .demo-brand { min-width: 190px; }
    .demo-brand strong { font-size: 14px; letter-spacing: .17em; }
    .demo-brand strong span { margin-left: 6px; font-weight: 400; }
    .demo-brand small { font-size: 9px; letter-spacing: .12em; }
    .demo-brand-mark { border-radius: 4px; box-shadow: none; width: 34px; height: 34px; }
    .demo-header-center { min-width: 0; gap: 12px; font-size: 11px; }
    .demo-header-room { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px; }
    .demo-header-tick { color: var(--demo-amber); font: 600 13px ui-monospace, monospace; white-space: nowrap; }
    .demo-header-connection { display: flex; gap: 8px; align-items: center; white-space: nowrap; }
    .demo-header-user { min-width: 0; flex-shrink: 0; }
    .demo-header-user b { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .demo-header-user small { font-size: 10px; }
    .demo-user-avatar { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--demo-line-strong); color: var(--demo-amber); background: #27302e; font-size: 12px; font-weight: 650; }

    /* Encounter entrance */
    .demo-login-page { display: flex; flex-direction: column; justify-content: center; min-height: 100dvh; padding: 32px 5vw; background: #0c1419; }
    .demo-login-backdrop { pointer-events: none; background: radial-gradient(ellipse at 22% 43%, #254b402a, transparent 55%), linear-gradient(120deg, transparent 65%, #b4996020 160%); }
    .demo-login-topbar, .demo-login-layout, .demo-login-footer { position: relative; width: min(1136px, 100%); margin-inline: auto; }
    .demo-login-topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 55px; gap: 16px; }
    .demo-login-edition { display: flex; align-items: center; gap: 8px; color: var(--demo-muted); font: 10px ui-monospace, monospace; letter-spacing: .1em; }
    .demo-login-edition span { width: 5px; height: 5px; border-radius: 50%; background: var(--demo-teal); }
    .demo-login-layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(330px, .9fr); gap: clamp(36px, 6vw, 90px); align-items: center; }
    .demo-encounter-intro { min-width: 0; }
    .demo-intro-kicker { display: flex; align-items: center; gap: 10px; color: var(--demo-amber); font-size: 10px; letter-spacing: .14em; }
    .demo-intro-kicker > span:first-child { width: 5px; height: 5px; background: var(--demo-amber); transform: rotate(45deg); }
    .demo-intro-kicker-line { width: 24px; height: 1px; background: #d9b87c50; }
    .demo-encounter-intro h1 { margin: 18px 0 17px; color: #e9efe6; font: 500 clamp(38px, 4.4vw, 58px)/1.2 "STSong", "SimSun", Georgia, serif; letter-spacing: .16em; }
    .demo-encounter-intro h1 span { display: block; margin-top: 12px; font: 10px/1.5 ui-monospace, monospace; letter-spacing: .36em; color: #8daba5; }
    .demo-intro-description { margin: 0; color: #a2b7b5; font-size: 13px; line-height: 1.9; }
    .demo-intro-map { margin: 24px 0 20px; overflow: hidden; border: 1px solid #91b9a921; border-radius: 8px; background: #10201f70; }
    .demo-intro-map-caption { display: flex; align-items: center; gap: 7px; padding: 11px 15px; border-bottom: 1px solid #91b9a914; color: #b4c7be; font-size: 10px; letter-spacing: .05em; }
    .demo-intro-map-caption span { margin-left: auto; color: #7e9992; }
    .demo-intro-map > svg { display: block; width: 100%; max-height: 238px; }
    .demo-intro-map-caption svg { flex-shrink: 0; }
    .demo-intro-map-legend { display: flex; gap: 18px; padding: 10px 15px; border-top: 1px solid #91b9a914; color: #9eb6ad; font-size: 10px; }
    .demo-intro-map-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .demo-intro-map-legend i { width: 5px; height: 5px; border-radius: 50%; background: var(--demo-teal); }
    .demo-intro-map-legend span:nth-child(2) i { background: var(--demo-amber); }
    .demo-intro-map-legend span:last-child { margin-left: auto; color: #80968e; letter-spacing: .1em; }
    .demo-intro-features { display: flex; justify-content: space-between; gap: 12px; }
    .demo-intro-features > div { display: flex; align-items: flex-start; gap: 8px; color: var(--demo-teal); }
    .demo-intro-features svg { margin-top: 3px; flex-shrink: 0; }
    .demo-intro-features strong, .demo-intro-features small { display: block; font-size: 11px; font-weight: 500; }
    .demo-intro-features strong { color: #c6d3cd; }
    .demo-intro-features small { margin-top: 4px; color: #809b94; font-size: 10px; }
    .demo-login-card { width: 100%; padding: 32px; border-color: #a9c9bd26; border-radius: 12px; background: linear-gradient(145deg, #1a292c, #132127 70%); box-shadow: 0 24px 64px #0003; }
    .demo-login-title { display: block; margin-bottom: 24px; }
    .demo-login-title h2 { margin: 10px 0 8px; font-size: 24px; letter-spacing: .02em; font-weight: 600; }
    .demo-login-title p { margin: 0; font-size: 12px; line-height: 1.7; }
    .demo-login-tabs { gap: 5px; padding: 4px; margin-bottom: 24px; background: #0b161b; border: 1px solid var(--demo-line); border-radius: 7px; }
    .demo-login-tabs button { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 40px; padding: 8px 0; font-size: 12px; border: 1px solid transparent; border-radius: 4px; }
    .demo-login-tabs button.active { border-color: #8ad6b935; background: #223b37; color: #bdebd6; }
    .demo-login-tabs button:disabled { cursor: wait; }
    .demo-login-card .demo-field { gap: 9px; margin-bottom: 19px; font-size: 12px; }
    .demo-login-card .demo-input { height: 44px; padding: 0 13px; font-size: 13px; background: #0c181e; }
    .demo-login-card .demo-field small { font-size: 11px; line-height: 1.65; color: #90a7aa; }
    .demo-login-card .demo-button.large-button { min-height: 46px; justify-content: space-between; margin-top: 3px; padding: 0 16px; font-size: 13px; }
    .demo-login-note { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 20px; color: #91a9a9; font-size: 10px; }
    .demo-login-footer { display: flex; justify-content: space-between; gap: 12px; padding-top: 24px; margin-top: 32px; border-top: 1px solid #91b9a91c; color: #79918d; font-size: 10px; letter-spacing: .05em; }
    .demo-login-page > .demo-login-card { max-width: 430px; }

    /* Lobby: encounter brief, room access and roster */
    .demo-lobby-stage { gap: 24px; max-width: 1480px; margin: 32px auto; padding: 0 24px; grid-template-columns: minmax(0, 1.4fr) minmax(340px, 1fr); }
    .demo-lobby-hero { padding: 28px; gap: 18px; align-items: flex-start; background: linear-gradient(110deg, #28423b65, transparent 85%); }
    .demo-lobby-hero h1 { margin-top: 12px; font-family: "STSong", "SimSun", Georgia, serif; font-size: 36px; letter-spacing: .1em; }
    .demo-lobby-hero p { font-size: 13px; line-height: 1.8; }
    .demo-lobby-status { margin-top: 3px; border: 1px solid #d9b87c33; padding: 5px 10px; border-radius: 20px; background: #d9b87c08; }
    .demo-lobby-steps { display: flex; gap: 16px; padding: 16px 28px; border-bottom: 1px solid var(--demo-line); flex-wrap: wrap; }
    .demo-lobby-steps span { display: flex; align-items: center; gap: 7px; color: var(--demo-muted); font-size: 11px; }
    .demo-lobby-steps b { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--demo-line-strong); font: 10px ui-monospace, monospace; }
    .demo-lobby-steps .is-current { color: var(--demo-teal); }
    .demo-lobby-steps .is-current b { background: #8ad6b918; border-color: #8ad6b966; }
    .demo-lobby-grid { grid-template-columns: minmax(0, 1fr); gap: 18px; padding: 24px; }
    .demo-room-card { display: grid; grid-template-columns: 1fr auto; gap: 10px 18px; }
    .demo-room-card > .demo-eyebrow { grid-column: 1 / -1; }
    .demo-room-card h2 { margin: 0; align-self: center; }
    .demo-room-code { grid-column: 2; grid-row: 2 / 4; align-self: start; min-width: 170px; padding: 14px 16px; border: 1px solid #8ad6b940; background: #8ad6b908; font-size: 22px; letter-spacing: .13em; }
    .demo-room-card p { min-height: 0; margin: 0; font-size: 12px; }
    .demo-room-card > button { justify-self: start; grid-column: 1 / -1; }
    .demo-card { padding: 18px; border-radius: 8px; background: #ffffff02; }
    .demo-roster-row { min-height: 58px; padding: 10px 12px; border-radius: 6px; }
    .demo-roster-name strong { font-size: 13px; }
    .demo-roster-name small, .demo-roster-role { font-size: 11px; }
    .demo-roster-row .demo-select { max-width: 45%; }
    .demo-roster-vacancy { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 10px 12px; border: 1px dashed var(--demo-line-strong); border-radius: 6px; color: var(--demo-muted); font-size: 12px; }
    .demo-roster-vacancy > span:first-child { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: #9bb0b610; font: 12px ui-monospace, monospace; }
    .demo-roster-vacancy small { margin-left: auto; font-size: 10px; color: #8a9e9f; }
    .demo-lobby-footer { padding: 18px 24px; gap: 14px; flex-wrap: wrap; font-size: 12px; }
    .demo-lobby-footer .demo-button { min-height: 40px; }
    .demo-lobby-setup { gap: 20px; }
    .demo-lobby-setup .demo-panel { padding: 18px; }

    /* Live workspace: quieter chrome and legible controls */
    .workspace-toolbar { background: #111e25; gap: 12px; }
    .workspace-toolbar-label { font-size: 12px; }
    .workspace-toolbar-label small { color: #95aaad; }
    .workspace-toolbar button { border-radius: 5px; font-size: 11px; }
    .workspace-map { background: #0d1a20; }
    .demo-battlefield-panel { position: relative; }
    .workspace-map .demo-battlefield-panel { position: relative; padding: 0; }
    .workspace-map .demo-battlefield-wrap { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; }
    .workspace-map .demo-battlefield { display: block; width: 100%; height: 100%; }
    .demo-battlefield-panel .demo-targeting-banner,
    .demo-battlefield-panel .demo-legacy-notice { position: absolute; z-index: 55; }
    .demo-battlefield-panel .demo-targeting-banner { top: 12px; bottom: auto; left: 50%; z-index: 50; width: min(560px, calc(100% - 32px)); margin: 0; transform: translateX(-50%); box-shadow: 0 10px 28px #0008; pointer-events: auto; }
    .demo-battlefield-panel .demo-legacy-notice { top: 12px; left: 12px; max-width: min(380px, calc(100% - 68px)); margin: 0; padding: 5px 8px; border: 1px solid #94a9ad2d; border-radius: 6px; background: #13232bd9; box-shadow: 0 8px 20px #0006; pointer-events: none; }
    .workspace-window { border-color: #73939155; border-radius: 9px; background: #132129; }
    .workspace-window.is-floating { box-shadow: 0 12px 40px #0007, 0 1px 0 #c8e9dc0a inset; }
    .workspace-window-bar { background: linear-gradient(100deg, #22343b, #192a32); }
    .workspace-drag > span { color: var(--demo-teal); font-size: 10px; }
    .workspace-drag > strong { font-size: 12px; letter-spacing: .02em; }
    .workspace-window.needs-attention { border-color: var(--demo-amber); box-shadow: 0 0 0 2px #d9b87c22, 0 12px 40px #0007; }
    .workspace-toolbar .needs-attention { color: var(--demo-amber); border-color: #d9b87c70; }
    .workspace-window-body > .demo-panel { padding: 16px; }
    .workspace-window .demo-section-title h2 { font-size: 15px; }
    .crpg-hotbar .demo-actor-strip strong { font-size: 14px; }
    .crpg-hotbar .demo-actor-strip small { font-size: 11px; }
    .crpg-hotbar .demo-resource-strip > span { min-width: 75px; font-size: 12px; border-radius: 4px; }
    .hotbar-categories { flex-wrap: wrap; }
    .hotbar-categories button { min-height: 32px; font-size: 12px; padding-inline: 11px; }
    .hotbar-categories > span { font-size: 11px; }
    .crpg-hotbar .demo-action-card { min-height: 88px; border-radius: 6px; }
    .crpg-hotbar .demo-action-copy strong { font-size: 12px; }
    .hotbar-description { font-size: 12px; line-height: 1.65; min-height: 42px; }
    .hotbar-selected { font-size: 10px; }
    .demo-ready-row { align-items: flex-start; }
    .demo-ready-row .demo-status-dot { flex-shrink: 0; margin-top: 5px; }
    .demo-ready-name, .demo-ready-state { font-size: 11px; line-height: 1.6; }
    .demo-log-row { padding: 9px 10px; grid-template-columns: 45px minmax(0, 1fr); }
    .demo-log-row > span { font-size: 10px; line-height: 1.6; }
    .demo-log-row p { font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
    .demo-log-row code, .demo-log-details { font-size: 10px; }
    .demo-gm-block h3 { font-size: 12px; }
    .demo-gm-toolbar { gap: 8px; }
    .demo-check { font-size: 12px; }
    .demo-targeting-banner { background: #193631; border-color: #8ad6b980; }
    .demo-timeline-subtitle, .demo-timeline-legend { font-size: 11px; }
    .demo-timeline-lane-label small, .demo-timeline-ruler-label { font-size: 10px; }
    .demo-timeline-tools { gap: 6px; }
    .demo-notice { padding: 11px 13px; border-radius: 7px; }
    .demo-notice span { flex-shrink: 0; }

    @media (min-width: 761px) and (max-height: 800px) {
      .demo-login-page { padding-block: 24px; }
      .demo-login-topbar { margin-bottom: 30px; }
      .demo-intro-map > svg { max-height: 180px; }
      .demo-intro-map { margin-block: 18px; }
      .demo-login-footer { margin-top: 24px; padding-top: 16px; }
    }
    @media (min-width: 761px) and (max-width: 1080px) {
      .demo-lobby-stage { gap: 16px; padding-inline: 16px; grid-template-columns: minmax(0, 1.2fr) minmax(320px, 1fr); }
      .demo-lobby-hero { padding: 22px; flex-wrap: wrap; }
      .demo-lobby-grid { padding: 16px; }
      .demo-room-card { display: block; }
      .demo-room-card h2, .demo-room-card p, .demo-room-code { margin-bottom: 12px; }
      .demo-room-code { margin-top: 14px; min-width: 0; }
      .demo-header-room { max-width: 170px; }
    }
    @media (max-width: 760px) {
      .demo-header { padding-inline: 14px; gap: 10px; }
      .demo-brand { min-width: 0; gap: 8px; }
      .demo-brand strong { font-size: 12px; }
      .demo-header-user { gap: 8px; }
      .demo-header-user b { max-width: 90px; }
      .demo-user-avatar { display: none; }
      .demo-header-center { display: flex; margin-left: auto; }
      .demo-header-room, .demo-header-divider, .demo-header-connection, .demo-header-user small { display: none; }
      .demo-login-page { padding: 24px 20px; justify-content: flex-start; }
      .demo-login-topbar { margin-bottom: 30px; }
      .demo-login-edition { font-size: 9px; letter-spacing: 0; }
      .demo-login-layout { grid-template-columns: minmax(0, 1fr); gap: 26px; max-width: 460px; }
      .demo-encounter-intro h1 { margin-block: 12px; font-size: 38px; }
      .demo-intro-description { font-size: 12px; }
      .demo-intro-map, .demo-intro-features { display: none; }
      .demo-login-card { padding: 24px; }
      .demo-login-title { margin-bottom: 20px; }
      .demo-login-title h2 { font-size: 22px; }
      .demo-login-footer { max-width: 460px; margin-top: 24px; padding-top: 18px; flex-wrap: wrap; }
      .demo-lobby-stage { display: grid; grid-template-columns: minmax(0, 1fr); margin-block: 16px; padding-inline: 12px; gap: 16px; }
      .demo-lobby-stage .demo-lobby { margin: 0; }
      .demo-lobby-hero { padding: 22px; }
      .demo-lobby-status { margin-top: 18px; }
      .demo-lobby-grid { display: grid; padding: 16px; }
      .demo-lobby-steps { padding: 14px 22px; gap: 12px; }
      .demo-room-card { margin: 0; }
      .demo-roster-row { gap: 7px; }
      .demo-lobby-footer { padding: 18px; }
      .demo-lobby-footer > div { overflow-wrap: anywhere; }
      .demo-panel-heading { gap: 12px; flex-wrap: wrap; }
      .demo-map-selection { justify-content: flex-start; }
      .workspace.is-compact { position: relative; inset: auto; overflow: visible; display: flex; flex-direction: column; gap: 12px; padding: 0 12px 24px; }
      .workspace.is-compact .workspace-toolbar { position: sticky; top: 68px; z-index: 50; margin-inline: -12px; height: auto; min-height: 48px; padding: 8px 12px; flex-wrap: wrap; overflow: visible; white-space: normal; }
      .workspace.is-compact .workspace-module-buttons { flex: 1; flex-wrap: wrap; gap: 5px; }
      .workspace.is-compact .workspace-toolbar button { min-height: 34px; font-size: 11px; }
      .workspace.is-compact .workspace-reset { margin-left: auto; }
      .workspace.is-compact .workspace-map { position: relative; inset: auto; min-height: 330px; border: 1px solid var(--demo-line); border-radius: 9px; overflow: hidden; scroll-margin-top: 180px; }
      .workspace.is-compact .demo-battlefield-panel { height: 330px; padding: 0; }
      .workspace.is-compact .demo-battlefield-wrap { margin: 0; min-height: 0; }
      .workspace.is-compact .demo-battlefield { height: 100%; max-height: none; min-height: 0; }
      .workspace.is-compact .workspace-window { position: relative; inset: auto; width: 100%; height: auto; flex-shrink: 0; scroll-margin-top: 180px; }
      .workspace.is-compact .workspace-window[hidden] { display: none; }
      .workspace.is-compact .workspace-window-body { max-height: none; overflow: visible; }
      .workspace.is-compact .workspace-window-body[hidden] { display: none; }
      .workspace.is-compact .workspace-window-bar { height: 44px; }
      .workspace.is-compact .workspace-drag:disabled { touch-action: auto; }
      .workspace.is-compact .workspace-window-tools button { width: 32px; height: 32px; }
      .workspace.is-compact .demo-timeline-scroll { max-height: 320px; }
      .workspace.is-compact .crpg-hotbar .demo-resource-strip { width: 100%; margin-left: 0; }
      .workspace.is-compact .crpg-hotbar .demo-action-list { grid-template-columns: repeat(auto-fit, minmax(76px, 1fr)); }
      .demo-app:has(.workspace.is-compact) .demo-notices { z-index: 60; bottom: 12px; max-height: 160px; }
      .demo-app:has(.workspace.is-compact) .demo-result-banner { top: 124px; left: 12px; transform: none; width: calc(100% - 24px); margin: 0; max-height: 40dvh; overflow: auto; flex-wrap: wrap; }
      .demo-app:has(.workspace.is-compact) .demo-settlement-status { left: 12px; bottom: 12px; transform: none; width: calc(100% - 24px); margin: 0; z-index: 65; max-height: 35dvh; overflow: auto; flex-wrap: wrap; }
    }
    @media (max-width: 420px) {
      .demo-login-page { padding-inline: 16px; }
      .demo-login-edition { display: none; }
      .demo-login-card { padding: 22px 20px; }
      .demo-room-card { display: block; }
      .demo-room-card h2 { margin-block: 6px 14px; }
      .demo-room-card p { margin-block: 12px; }
      .demo-roster-vacancy small { display: none; }
    }
    .demo-app { --demo-header-height: 68px; }
    .demo-app.is-header-hidden { --demo-header-height: 0px; }
    .demo-app .workspace:not(.is-compact) { top: var(--demo-header-height); }
    .demo-app .workspace.is-compact .workspace-toolbar { top: var(--demo-header-height); }
    .demo-app .workspace.is-compact :is(.workspace-map, .workspace-window) { scroll-margin-top: calc(var(--demo-header-height) + 112px); }
    .demo-app:has(.workspace) .demo-result-banner { top: calc(var(--demo-header-height) + 56px); }
    .demo-app .demo-inline-error { top: calc(var(--demo-header-height) + 10px); }

    /* High-signal encounter state stays readable while the floating panels stay compact. */
    .action-status-strip { display: grid; grid-template-columns: minmax(150px, 1.05fr) minmax(140px, .85fr) minmax(220px, 1.45fr); gap: 8px; align-items: stretch; margin: -2px 0 10px; padding: 8px; border: 1px solid #8ad6b92c; border-radius: 7px; background: linear-gradient(100deg, #8ad6b90d, #d9b87c09); }
    .action-status-primary, .action-reaction-summary { display: grid; align-content: center; gap: 2px; min-width: 0; padding: 2px 8px; border-left: 2px solid #8ad6b98c; }
    .action-reaction-summary { border-left-color: #d9b87c99; }
    .action-status-primary > span, .action-reaction-summary > span { color: #9ab4b2; font-size: 10px; letter-spacing: .08em; }
    .action-status-primary strong, .action-reaction-summary strong { overflow: hidden; color: #f1dfad; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .action-status-primary small, .action-reaction-summary small { overflow: hidden; color: #94a9ad; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .action-status-strip:not(:has(.action-reaction-summary)) { grid-template-columns: minmax(170px, .75fr) minmax(0, 1.8fr); }
    .demo-ready-row { display: grid; grid-template-columns: 7px 28px minmax(0, 1fr) minmax(100px, auto) 52px; align-items: center; gap: 8px; }
    .demo-ready-avatar { display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid #d9b87c66; border-radius: 50%; color: #f0d79a; background: #d9b87c12; font-size: 15px; }
    .demo-ready-name { min-width: 0; overflow: hidden; color: #dce8e4; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .demo-ready-state { min-width: 0; overflow: hidden; color: #a4b3b4; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .demo-ready-state.is-ready { color: #9de2c3; }
    .demo-ready-progress { display: block; width: 10px; height: 10px; border: 1px solid #879ba055; border-radius: 50%; background: #879ba022; }
    .demo-ready-progress.is-ready { border-color: #8ad6b9; background: #8ad6b9; box-shadow: 0 0 0 3px #8ad6b91c; }
    .demo-ready-progress.is-waiting { border-color: #d9b87c; background: #d9b87c; }
    .demo-ready-progress.is-pending { border-color: #8aafb5; background: transparent; }
    .demo-ready-progress.is-offline { border-color: #77838c; background: #77838c66; }
    .demo-reaction-card > p { font-size: 12px; }
    .demo-reaction-card > p strong { color: #e7d19a; font-size: 13px; }
    .demo-reaction-technical { margin-top: 4px; color: #879da2; font-size: 10px; }
    .demo-reaction-technical summary { cursor: pointer; }
    .demo-reaction-technical code { display: block; margin-top: 4px; overflow-wrap: anywhere; color: #91a9ae; font: 10px/1.5 ui-monospace, monospace; }
    .demo-map-cell-polygon { stroke: rgba(145, 170, 190, .14); }
    .demo-entity-token.is-friendly .demo-entity-role-symbol { fill: #a9fff0; }
    .demo-entity-token.is-hostile .demo-entity-role-symbol { fill: #ffb2a8; }
    .demo-entity-token.is-neutral .demo-entity-role-symbol { fill: #f1d090; }
    .demo-entity-role-symbol { paint-order: stroke; stroke: #071016; stroke-width: .035; font-size: .19px; font-weight: 700; }
    .demo-entity-token.is-friendly .demo-entity-token-core { stroke: #a9fff0; stroke-width: .02; }
    .demo-entity-token.is-hostile .demo-entity-token-core { stroke: #ff9b9f; stroke-width: .02; }
    .demo-entity-token:focus-visible .demo-entity-token-core { stroke: var(--demo-teal); stroke-width: .07; }
    .demo-entity-token.is-selected .demo-entity-ring-selected { stroke-width: .06; }
    .demo-entity-token.is-target .demo-entity-ring-target { stroke-width: .055; stroke-dasharray: .08 .045; }
    .tactical-clock.timeline-view-compact .demo-timeline-lane-label small,
    .tactical-clock.timeline-view-compact .demo-timeline-action-meta { display: none; }
    .tactical-clock.timeline-view-compact .demo-timeline-action,
    .tactical-clock.timeline-view-compact .demo-timeline-unknown { height: 28px; }
    .tactical-clock.timeline-view-compact .demo-timeline-action-name { top: 1px; font-size: 10px; }
    .tactical-clock.timeline-view-compact .demo-timeline-segments,
    .tactical-clock.timeline-view-compact .timeline-result-marker,
    .tactical-clock.timeline-view-compact .demo-timeline-pulse-point { top: 14px; }
    .workspace-window[data-panel="timeline"] .demo-timeline-lane-label strong { font-size: 12px; }
    .workspace-window[data-panel="timeline"] .demo-timeline-action-name { font-size: 12px; line-height: 1.1; }
    .demo-gm-section { margin-top: 10px; border: 1px solid var(--demo-line); border-radius: 7px; background: #0d192055; }
    .demo-gm-section > summary { cursor: pointer; padding: 9px 11px; color: #dce8e4; font-size: 12px; font-weight: 650; list-style: none; }
    .demo-gm-section > summary::-webkit-details-marker { display: none; }
    .demo-gm-section > summary::before { display: inline-block; width: 14px; color: var(--demo-amber); content: '▸'; }
    .demo-gm-section[open] > summary::before { content: '▾'; }
    .demo-gm-section > .demo-gm-grid { margin: 0; padding: 0 10px 10px; }
    .demo-ready-disclosure { border-top: 1px solid var(--demo-line); }
    .demo-ready-disclosure > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 36px; padding: 4px 0; cursor: pointer; list-style: none; }
    .demo-ready-disclosure > summary::-webkit-details-marker { display: none; }
    .demo-ready-disclosure > summary > span:first-child { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin-right: auto; }
    .demo-ready-disclosure > summary > span:first-child strong { color: #dce8e4; font-size: 12px; }
    .demo-ready-disclosure > summary::before { display: inline-block; width: 12px; color: var(--demo-amber); content: '▸'; }
    .demo-ready-disclosure[open] > summary::before { content: '▾'; }
    @media (min-width: 761px) {
      .workspace-window[data-panel="actions"] .workspace-window-body > .demo-panel { padding: 4px 8px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .hotbar-character { flex-wrap: nowrap; gap: 8px; padding-bottom: 5px; }
      .workspace-window[data-panel="actions"] .hotbar-portrait { width: 28px; height: 28px; font-size: 14px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-actor-strip { gap: 1px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-actor-strip strong { font-size: 13px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-actor-strip .demo-muted { font-size: 11px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-resource-strip { gap: 3px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-resource-strip > span { min-width: 60px; padding: 3px 5px 6px; font-size: 12px; }
      .workspace-window[data-panel="actions"] .action-status-strip { gap: 4px; min-height: 30px; height: 30px; max-height: none; margin-bottom: 4px; padding: 3px; overflow: hidden; }
      .workspace-window[data-panel="actions"] .action-status-primary,
      .workspace-window[data-panel="actions"] .action-reaction-summary { display: flex; align-items: center; gap: 5px; padding-inline: 5px; white-space: nowrap; }
      .workspace-window[data-panel="actions"] .action-status-primary > span,
      .workspace-window[data-panel="actions"] .action-reaction-summary > span { flex-shrink: 0; }
      .workspace-window[data-panel="actions"] .action-status-primary small,
      .workspace-window[data-panel="actions"] .action-reaction-summary small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .workspace-window[data-panel="actions"] .action-status-primary strong,
      .workspace-window[data-panel="actions"] .action-reaction-summary strong { font-size: 12px; }
      .workspace-window[data-panel="actions"] .action-status-primary small,
      .workspace-window[data-panel="actions"] .action-reaction-summary small { font-size: 9px; }
      .workspace-window[data-panel="actions"] .hotbar-categories { margin: 2px 0; }
      .workspace-window[data-panel="actions"] .hotbar-categories button { min-height: 20px; padding: 1px 7px; font-size: 11px; }
      .workspace-window[data-panel="actions"] .hotbar-categories > span { font-size: 10px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-action-list { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-action-card { min-height: 48px; gap: 1px; padding: 3px 2px 2px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-action-icon { width: 20px; height: 20px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-action-copy strong { font-size: 12px; }
      .workspace-window[data-panel="actions"] .hotbar-timing { top: 2px; right: 3px; font-size: 9px; }
      .workspace-window[data-panel="actions"] .hotbar-selected { font-size: 8px; }
      .workspace-window[data-panel="actions"] .hotbar-description { display: flex; min-height: 26px; max-height: 28px; padding: 2px 0; gap: 3px 7px; overflow: hidden; font-size: 11px; line-height: 1.35; }
      .workspace-window[data-panel="actions"] .hotbar-description strong { font-size: 12px; }
      .workspace-window[data-panel="actions"] .hotbar-description em { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-action-secondary { margin-top: 0; padding-top: 2px; gap: 4px; }
      .workspace-window[data-panel="actions"] .crpg-hotbar .demo-action-secondary .demo-button { min-height: 24px; padding: 2px 8px; font-size: 12px; }
      .workspace-window[data-panel="actions"] .demo-ready-panel { padding: 0 8px !important; }
      .workspace-window[data-panel="actions"] .demo-ready-disclosure > summary { min-height: 28px; padding: 0; }
      .workspace-window[data-panel="actions"] .workspace-window-body { padding-bottom: 0; }
    }
    @media (max-width: 780px) {
      .action-status-strip { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); height: auto; max-height: none; overflow: visible; }
      .action-status-strip:not(:has(.action-reaction-summary)) { grid-template-columns: minmax(0, 1fr); }
      .demo-ready-row { grid-template-columns: 7px 28px minmax(0, 1fr) minmax(70px, auto); }
      .demo-ready-progress { display: none; }
    }
    /* Keep the workspace chrome available without making every panel read like a numbered card. */
    .workspace-window { border-color: #73939135; box-shadow: 0 10px 34px #0006, 0 1px 0 #c8e9dc08 inset; }
    .workspace-window-bar { border-bottom-color: #9bb7b51f; background: #172830e8; }
    .workspace-window-bar.is-titleless { min-height: 30px; height: 30px; padding-left: 7px; }
    .workspace-drag.is-grip-only { gap: 0; }
    .workspace-drag-grip { display: inline-block; flex: 0 0 22px; width: 22px; height: 18px; color: #7f9da1; font-size: 17px; line-height: 18px; text-align: center; }
    .workspace-drag-grip::before { content: '⋮⋮'; letter-spacing: -2px; }
    .workspace-window-bar.is-titleless .workspace-drag > b { margin-left: 6px; }
    .workspace-window[data-panel="actions"] .workspace-window-bar.is-titleless .workspace-drag { min-height: 28px; }
    .workspace-window[data-panel="actions"] .workspace-window-bar.is-titleless .workspace-window-tools button { width: 26px; height: 26px; }
    .workspace-window[data-panel="actions"] .workspace-window-bar.is-titleless { position: absolute; inset: 0 0 auto; z-index: 8; min-height: 0; height: 0; padding: 0; border: 0; background: transparent; pointer-events: none; }
    .workspace-window[data-panel="actions"] .workspace-window-bar.is-titleless .workspace-drag { position: absolute; top: 4px; left: 6px; width: 28px; height: 26px; pointer-events: auto; }
    .workspace-window[data-panel="actions"] .workspace-window-bar.is-titleless .workspace-window-tools { position: absolute; top: 4px; right: 6px; pointer-events: auto; }
    .workspace-window[data-panel="actions"] .action-status-strip { padding-left: 38px; padding-right: 72px; }
    .workspace-window[data-panel="actions"] .workspace-window-body > .demo-reaction-panel:first-child { padding-top: 42px; }
    .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay { position: absolute; inset: 0 0 auto; z-index: 8; min-height: 0; height: 0; padding: 0; border: 0; background: transparent; pointer-events: none; }
    .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay .workspace-drag { position: absolute; top: 4px; left: 6px; width: 26px; height: 26px; flex: 0 0 26px; pointer-events: auto; }
    .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay .workspace-window-tools { position: absolute; top: 4px; left: 36px; pointer-events: auto; }
    .workspace-window[data-panel="timeline"] .workspace-window-body { position: relative; }
    .workspace-window[data-panel="timeline"] .tactical-clock .demo-timeline-header { gap: 8px; min-height: 28px; padding-left: 104px; }
    .workspace-window[data-panel="timeline"] .tactical-clock .demo-timeline-header { flex-wrap: nowrap; min-width: 0; }
    .workspace-window[data-panel="timeline"] .timeline-clock { min-width: auto; display: flex; align-items: baseline; gap: 4px; padding: 2px 8px; }
    .workspace-window[data-panel="timeline"] .timeline-clock small { font-size: 9px; }
    .workspace-window[data-panel="timeline"] .timeline-clock strong { font-size: 18px; }
    .workspace-window[data-panel="timeline"] .timeline-summary { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; gap: 8px; }
    .workspace-window[data-panel="timeline"] .timeline-summary h2 { display: flex; align-items: baseline; flex: 0 1 auto; min-width: 0; gap: 8px; }
    .workspace-window[data-panel="timeline"] .timeline-panel-title { flex: 0 0 auto; color: #dce8e4; font-size: 13px; font-weight: 650; }
    .workspace-window[data-panel="timeline"] .timeline-global-status { min-width: 0; overflow: hidden; color: #9ab4b2; font-size: 10px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    .workspace-window[data-panel="timeline"] .demo-timeline-subtitle { display: none; }
    .workspace-window[data-panel="timeline"] .demo-timeline-tools .demo-button:not(.active-mode) { border-color: #94a9ad1c; color: #82999f; background: transparent; }
    .workspace-window[data-panel="timeline"] .demo-timeline-tools .demo-button:hover:not(:disabled),
    .workspace-window[data-panel="timeline"] .demo-timeline-tools .demo-button:focus-visible { border-color: #8ad6b966; color: #cce9df; background: #8ad6b912; }
    .workspace-window[data-panel="timeline"].is-collapsed .workspace-window-bar.is-overlay { position: relative; height: 42px; min-height: 42px; pointer-events: auto; background: #172830e8; }
    .workspace-window[data-panel="timeline"].is-collapsed .workspace-window-bar.is-overlay .workspace-drag { position: relative; top: auto; left: auto; width: auto; height: auto; flex: 1; }
    .workspace-window[data-panel="timeline"].is-collapsed .workspace-window-bar.is-overlay .workspace-window-tools { position: relative; top: auto; left: auto; }
    .workspace-window-tools button, .workspace-resize { color: #82999f; }
    .workspace-window-tools button:hover:not(:disabled), .workspace-resize:hover { color: var(--demo-teal); background: #8ad6b912; }
    .workspace-window :is(button, summary):focus-visible, .workspace-toolbar button:focus-visible { outline: 2px solid var(--demo-teal); outline-offset: 2px; }
    .workspace-window[data-panel="actions"] .action-status-strip { grid-template-columns: minmax(0, 1fr); border-color: #8ad6b91f; }
    .workspace-window[data-panel="actions"] .action-status-strip:has(.action-reaction-summary) { grid-template-columns: minmax(0, 1fr) minmax(0, .85fr); }
    .workspace-window[data-panel="actions"] .action-status-primary,
    .workspace-window[data-panel="actions"] .action-reaction-summary { border-left-color: #8ad6b95f; }
    .workspace-window[data-panel="actions"] .demo-ready-disclosure { border-top-color: #94a9ad1c; }
    .workspace-window[data-panel="logs"], .workspace-window[data-panel="gm"] { border-color: #73939135; }
    .demo-faction-controls { grid-column: 1 / -1; display: grid; gap: 12px; min-width: 0; padding: 8px; border: 1px solid #94a9ad25; border-radius: 6px; }
    .demo-faction-controls-section { min-width: 0; }
    .demo-faction-controls-section h3 { margin: 0 0 6px; color: #c5d8d5; font-size: 12px; }
    .demo-faction-controls .demo-inline-controls { flex-wrap: wrap; }
    .demo-faction-controls .demo-input, .demo-faction-controls .demo-select { flex: 1 1 130px; min-width: 0; max-width: 100%; }
    .demo-entity-roster { min-height: 0; padding: 4px 8px !important; }
    .workspace-window[data-panel="entities"] .workspace-window-body { padding-bottom: 4px; }
    .demo-entity-roster-columns { display: grid; grid-template-columns: minmax(105px, 1.4fr) repeat(3, minmax(59px, .7fr)) minmax(32px, .4fr) minmax(121px, 1.45fr) 30px; align-items: center; min-width: 470px; min-height: 20px; color: #82999f; font-size: 9px; line-height: 1; }
    .demo-entity-roster-columns > span { min-width: 0; overflow: hidden; padding: 0 4px; text-overflow: ellipsis; white-space: nowrap; }
    .demo-entity-roster-columns > span:not(:first-child) { border-left: 1px solid #94a9ad12; }
    .demo-entity-roster-column-resource { display: flex; align-items: center; gap: 3px; }
    .demo-entity-roster-column-resource i { color: #d9b87c; font-size: 11px; font-style: normal; }
    .demo-entity-roster-list { display: grid; gap: 0; min-height: 0; padding-top: 5px; overflow: auto; }
    .demo-entity-roster-row { min-width: 470px; border: 1px solid #94a9ad2b; border-radius: 0; background: #0b151b66; }
    .demo-entity-roster-row.is-selected { border-color: #8ad6b988; background: #17312e66; box-shadow: inset 2px 0 0 #8ad6b9; }
    .demo-entity-roster-row.is-down { border-color: #9b718055; }
    .demo-entity-roster-main { display: grid; grid-template-columns: minmax(105px, 1.4fr) repeat(3, minmax(59px, .7fr)) minmax(32px, .4fr) minmax(121px, 1.45fr) 30px; align-items: stretch; min-height: 30px; }
    .demo-entity-roster-select { display: grid; grid-template-columns: 8px minmax(0, 1fr); align-items: center; gap: 5px; min-width: 0; min-height: 30px; padding: 3px 5px; border: 0; color: #dce8e4; background: transparent; cursor: pointer; text-align: left; }
    .demo-entity-roster-select:hover { background: #8ad6b90d; }
    .demo-entity-roster-select:disabled { cursor: wait; opacity: .65; }
    .demo-entity-roster-select:focus-visible, .demo-entity-roster-details summary:focus-visible { outline: 2px solid var(--demo-teal); outline-offset: -2px; }
    .demo-entity-roster-faction-dot { display: block; width: 6px; height: 6px; border: 1px solid currentColor; border-radius: 50%; color: #92a4ba; background: currentColor; }
    .demo-entity-roster-name { display: grid; min-width: 0; gap: 1px; }
    .demo-entity-roster-name strong { overflow: hidden; color: #e7eee9; font-size: 11px; line-height: 1.1; text-overflow: ellipsis; white-space: nowrap; }
    .demo-entity-roster-name small { display: flex; gap: 4px; min-width: 0; color: #91a9ae; font-size: 9px; line-height: 1.1; white-space: nowrap; }
    .demo-entity-roster-name small > span { overflow: hidden; text-overflow: ellipsis; }
    .demo-entity-roster-relation { flex: 0 0 auto; font-size: 10px; font-style: normal; }
    .demo-entity-roster-relation.is-hostile { color: #ffb2a8; }
    .demo-entity-roster-relation.is-ally { color: #9de2c3; }
    .demo-entity-roster-meter { display: grid; align-content: center; min-width: 0; padding: 2px 3px; color: #dce8e4; font-size: 11px; line-height: 1; }
    .demo-entity-roster-meter-reading { display: flex; align-items: center; min-width: 0; gap: 2px; white-space: nowrap; }
    .demo-entity-roster-meter-reading > span { min-width: 0; white-space: nowrap; }
    .demo-entity-roster-meter-track { display: block; height: 2px; margin-top: 2px; overflow: hidden; border-radius: 2px; background: #94a9ad25; }
    .demo-entity-roster-meter-track > span { display: block; height: 100%; border-radius: inherit; background: #8ad6b9a8; }
    .demo-entity-roster-meter.is-hp .demo-entity-roster-meter-track > span { background: #d98a86; }
    .demo-entity-roster-meter.is-poise .demo-entity-roster-meter-track > span { background: #d9b87c; }
    .demo-entity-roster-meter.is-focus .demo-entity-roster-meter-track > span { background: #8ad6b9; }
    .demo-entity-roster-slot { display: grid; place-items: center; min-width: 0; overflow: hidden; padding: 0 4px; color: #a6b8b9; font-size: 16px; line-height: 1; }
    .demo-entity-roster-slot.is-ready { color: #9de2c3; }
    .demo-entity-roster-slot.is-waiting { color: #f0d79a; }
    .demo-entity-roster-slot.is-blocked { color: #ffb2a8; }
    .demo-entity-roster-status-symbol { display: grid; place-items: center; width: 22px; height: 22px; border: 1px solid currentColor; border-radius: 50%; font-size: 13px; font-weight: 700; }
    .demo-entity-roster-status-symbol.is-reaction { border-color: #ffb2a8; color: #ffb2a8; background: #ffb2a81a; }
    .demo-entity-roster-action { display: flex; align-items: center; min-width: 0; gap: 4px; overflow: hidden; padding: 0 5px; border-left: 1px solid #94a9ad1c; color: #a8b9ba; font-size: 11px; white-space: nowrap; }
    .demo-entity-roster-phase-symbol { flex: 0 0 auto; color: #d9b87c; font-size: 13px; }
    .demo-entity-roster-action strong { min-width: 0; overflow: hidden; color: #e7d19a; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .demo-entity-roster-action small { flex: 0 0 auto; color: #9db0b2; font-size: 11px; }
    .demo-entity-roster-action.is-current { background: #d9b87c0b; }
    .demo-entity-roster-action.is-current strong { color: #f0d79a; }
    .demo-entity-roster-details { min-width: 0; }
    .demo-entity-roster-details[open] { grid-column: 1 / -1; border-top: 1px solid #94a9ad1c; }
    .demo-entity-roster-details summary { display: grid; place-items: center; min-height: 30px; padding: 0 4px; cursor: pointer; color: #a6b8b9; font-size: 10px; list-style: none; }
    .demo-entity-roster-details summary:hover { color: #d9e3dd; background: #8ad6b90d; }
    .demo-entity-roster-details summary::-webkit-details-marker { display: none; }
    .demo-entity-roster-details[open] summary { display: flex; justify-content: flex-end; min-height: 23px; padding: 0 7px; border-bottom: 1px solid #94a9ad1c; }
    .demo-entity-roster-detail-grid { display: grid; gap: 3px 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 5px 7px 6px; color: #9db0b2; font-size: 10px; }
    .demo-entity-roster-resources { display: flex; flex-wrap: wrap; grid-column: 1 / -1; gap: 3px; }
    .demo-entity-roster-resources > span { flex: 1 1 58px; min-width: 58px; padding: 2px 4px; border: 1px solid #94a9ad20; border-radius: 4px; color: #b3c4c3; background: #08111666; font-size: 10px; white-space: nowrap; }
    .demo-entity-roster-resources b { color: #d9e3dd; font-weight: 600; }
    .demo-entity-roster-detail-grid code { grid-column: 1 / -1; overflow-wrap: anywhere; color: #7f989e; font: 9px/1.4 ui-monospace, monospace; }
    .demo-entity-roster-connection.is-online { color: #9de2c3; }
    .demo-entity-roster-connection.is-offline { color: #ffb2a8; }
    .demo-entity-roster-connection.is-managed { color: #f0d79a; }
    @media (max-width: 760px) {
      .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay { position: relative; inset: auto; height: 36px; min-height: 36px; padding: 0 7px 0 12px; border-bottom: 1px solid #9bb7b51f; background: #172830e8; pointer-events: auto; }
      .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay .workspace-drag,
      .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay .workspace-window-tools { position: relative; inset: auto; width: auto; height: auto; }
      .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay .workspace-drag { flex: 1; }
      .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay .workspace-window-tools { left: auto; top: auto; }
      .workspace-window[data-panel="timeline"] .tactical-clock .demo-timeline-header { padding-left: 0; }
      .workspace-window[data-panel="timeline"] .timeline-summary { gap: 5px; }
      .workspace-window[data-panel="timeline"] .timeline-global-status { font-size: 9px; }
      .workspace-window[data-panel="actions"] .workspace-window-bar.is-titleless { position: relative; inset: auto; height: 36px; min-height: 36px; padding: 0 7px 0 12px; border-bottom: 1px solid #9bb7b51f; background: #172830e8; pointer-events: auto; }
      .workspace-window[data-panel="actions"] .workspace-window-bar.is-titleless .workspace-drag,
      .workspace-window[data-panel="actions"] .workspace-window-bar.is-titleless .workspace-window-tools { position: relative; inset: auto; width: auto; height: auto; }
      .workspace-window[data-panel="actions"] .workspace-window-bar.is-titleless .workspace-drag { flex: 1; }
      .workspace-window[data-panel="actions"] .workspace-window-bar.is-titleless .workspace-window-tools { right: auto; top: auto; }
      .workspace-window[data-panel="actions"] .action-status-strip { padding-inline: 8px; }
      .workspace-window[data-panel="actions"] .workspace-window-body > .demo-reaction-panel:first-child { padding-top: 16px; }
    }
    .workspace-window[data-panel="timeline"] .tactical-clock { position: relative; padding: 0 8px 6px; }
    .workspace-window[data-panel="timeline"] .timeline-options { position: relative; flex: 0 0 auto; right: auto; bottom: auto; z-index: 10; }
    .timeline-options > summary { display: grid; place-items: center; width: 30px; height: 26px; cursor: pointer; list-style: none; color: var(--demo-muted); font-size: 18px; }
    .timeline-options > summary::-webkit-details-marker { display: none; }
    .timeline-options-popover { position: absolute; top: calc(100% + 4px); right: 0; bottom: auto; width: min(430px, calc(100cqw - 24px)); max-width: calc(100vw - 24px); max-height: 130px; overflow: auto; padding: 12px; border: 1px solid var(--demo-line); border-radius: 8px; background: #172830; box-shadow: 0 8px 24px #0008; }
    .timeline-options-popover p { margin: 0 0 8px; font-size: 12px; color: var(--demo-muted); }
    .tactical-clock .timeline-options-popover .demo-timeline-tools { flex-wrap: wrap; }
    .workspace-map { inset: 0; }
    .workspace-menu { position: fixed; right: 12px; z-index: 60; }
    .workspace-menu-toggle { width: 34px; height: 34px; border: 1px solid var(--demo-line); border-radius: 7px; background: #172830e8; color: var(--demo-text); cursor: pointer; }
    .workspace-menu-content { position: absolute; top: 42px; right: 0; width: 190px; padding: 8px; border: 1px solid var(--demo-line); border-radius: 8px; background: #172830; box-shadow: 0 8px 24px #0008; }
    .workspace-menu-content[hidden] { display: none; }
    .workspace-menu-content .workspace-module-buttons { display: grid; margin: 6px 0; gap: 4px; }
    .workspace-menu-content button { display: block; width: 100%; min-height: 36px; padding: 6px 10px; border: 0; border-radius: 4px; background: transparent; color: var(--demo-text); text-align: left; cursor: pointer; }
    .workspace-menu-content button:hover, .workspace-menu-content button:focus-visible { background: #8ad6b91a; }
    .workspace-menu-content button[aria-pressed="true"] { color: var(--demo-teal); }
    /* Desktop panels retreat behind their edge labels without unmounting their contents. */
    .workspace-window.is-floating { visibility: visible; transform: translate(0, 0); transition: transform .18s ease-out, visibility 0s linear; }
    .workspace-window.is-floating.is-auto-hidden { visibility: hidden; pointer-events: none; transition: transform .18s ease-in, visibility 0s linear .18s; }
    .workspace-window.is-floating.is-auto-hidden[data-dock-edge="left"] { transform: translate(var(--dock-shift-x, calc(-100% - 32px)), var(--dock-shift-y, 0px)); }
    .workspace-window.is-floating.is-auto-hidden[data-dock-edge="right"] { transform: translate(var(--dock-shift-x, calc(100% + 32px)), var(--dock-shift-y, 0px)); }
    .workspace-window.is-floating.is-auto-hidden[data-dock-edge="top"] { transform: translate(var(--dock-shift-x, 0px), var(--dock-shift-y, calc(-100% - 32px))); }
    .workspace-window.is-floating.is-auto-hidden[data-dock-edge="bottom"] { transform: translate(var(--dock-shift-x, 0px), var(--dock-shift-y, calc(100% + 32px))); }
    .workspace-dock-rail { position: fixed; z-index: 58; overflow: auto; overscroll-behavior: contain; scrollbar-width: none; pointer-events: none; }
    .workspace-dock-rail::-webkit-scrollbar { display: none; }
    .workspace-dock-track { position: relative; min-width: 100%; min-height: 100%; }
    .workspace-dock-rail[data-dock-edge="top"], .workspace-dock-rail[data-dock-edge="bottom"] { left: 36px; right: 58px; height: 28px; }
    .workspace-dock-rail[data-dock-edge="top"] .workspace-dock-track, .workspace-dock-rail[data-dock-edge="bottom"] .workspace-dock-track { height: 28px; }
    .workspace-dock-rail[data-dock-edge="top"] { top: var(--dock-top, 0px); }
    .workspace-dock-rail[data-dock-edge="bottom"] { bottom: 0; }
    .workspace-dock-rail[data-dock-edge="left"], .workspace-dock-rail[data-dock-edge="right"] { width: 28px; bottom: 36px; }
    .workspace-dock-rail[data-dock-edge="left"] .workspace-dock-track, .workspace-dock-rail[data-dock-edge="right"] .workspace-dock-track { width: 28px; }
    .workspace-dock-rail[data-dock-edge="left"] { top: calc(var(--dock-top, 0px) + 36px); left: 0; }
    .workspace-dock-rail[data-dock-edge="right"] { top: calc(var(--dock-top, 0px) + 58px); right: 0; }
    .workspace-dock-tab { position: absolute; top: 0; left: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; width: 96px; height: 28px; padding: 3px 12px; border: 1px solid #73939155; border-radius: 0 0 6px 6px; background: #172830f2; color: #c2d4d2; box-shadow: 0 3px 12px #0005; font-size: 11px; font-weight: 550; line-height: 18px; letter-spacing: .04em; white-space: nowrap; cursor: pointer; pointer-events: auto; }
    .workspace-dock-rail[data-dock-edge="bottom"] .workspace-dock-tab { border-radius: 6px 6px 0 0; }
    .workspace-dock-rail[data-dock-edge="left"] .workspace-dock-tab, .workspace-dock-rail[data-dock-edge="right"] .workspace-dock-tab { writing-mode: vertical-rl; text-orientation: upright; width: 28px; height: 90px; padding: 8px 3px; letter-spacing: .08em; }
    .workspace-dock-rail[data-dock-edge="left"] .workspace-dock-tab { border-radius: 0 6px 6px 0; }
    .workspace-dock-rail[data-dock-edge="right"] .workspace-dock-tab { border-radius: 6px 0 0 6px; }
    .workspace-dock-tab:hover, .workspace-dock-tab[aria-expanded="true"] { border-color: #8ad6b988; background: #25473e; color: #d8f4e7; }
    .workspace-dock-tab[data-pinned="true"] { border-color: #d9b87c88; color: #e7cc9b; }
    .workspace-dock-tab:focus-visible { outline: 2px solid var(--demo-teal); outline-offset: -3px; }
    .workspace-window-tools .workspace-pin { color: #a7bcbd; }
    .workspace-window-tools .workspace-pin[aria-pressed="true"] { color: #f0d79a; background: #d9b87c24; box-shadow: inset 0 0 0 1px #d9b87c45; }
    .workspace-window-tools .workspace-pin[aria-pressed="true"]:hover { color: #ffe7b8; background: #d9b87c35; }
    @media (min-width: 761px) {
      .workspace-window[data-panel="actions"] .action-status-strip { padding-right: 100px; }
      .workspace-window[data-panel="timeline"] .tactical-clock .demo-timeline-header { padding-left: 134px; }
      @container (max-width: 420px) {
        .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay .workspace-drag { left: 4px; width: 20px; flex-basis: 20px; }
        .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay .workspace-window-tools { left: 26px; gap: 0; }
        .workspace-window[data-panel="timeline"] .workspace-window-bar.is-overlay .workspace-window-tools button { width: 22px; }
        .workspace-window[data-panel="timeline"] .tactical-clock .demo-timeline-header { padding-left: 92px; gap: 4px; }
        .workspace-window[data-panel="timeline"] .timeline-summary { gap: 4px; }
        .workspace-window[data-panel="timeline"] .timeline-summary h2 { flex: 0 0 auto; font-size: 11px; }
        .workspace-window[data-panel="timeline"] .timeline-clock { flex-shrink: 0; padding-inline: 4px; gap: 2px; }
        .workspace-window[data-panel="timeline"] .timeline-clock strong { font-size: 16px; }
      }
    }
    @media (max-width: 760px) {
      .workspace-dock-rail, .workspace-window-tools .workspace-pin { display: none; }
    }
    .workspace.is-compact .workspace-map, .workspace.is-compact .workspace-window { scroll-margin-top: 12px; }
    .demo-app:not(.is-header-hidden) .workspace.is-compact .workspace-map, .demo-app:not(.is-header-hidden) .workspace.is-compact .workspace-window { scroll-margin-top: 80px; }
    @media (prefers-reduced-motion: reduce) {
      .demo-app *, .demo-login-page * { transition: none !important; scroll-behavior: auto !important; }
    }
  `}</style>;
}
