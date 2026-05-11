// test/precision-strike.test.ts
// 要害攻击集成测试：部位判定 + 暴击 + 截断 + 破坏

import { BodyPartResolver } from '../packages/backend/src/core/systems/BodyPartResolver.js';
import type { Entity, ActionTemplate, ActionEffectPayload, BodyPartState, HitLocationEntry, CritConfig } from '@hard-vtt/shared';

// ==========================================
// 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}
function assertEqual<T>(actual: T, expected: T, label: string) {
  testCount++;
  if (actual === expected) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label} (期望=${expected}, 实际=${actual})`); process.exitCode = 1; }
}

// 标准部位表
const standardHitTable: HitLocationEntry[] = [
  { part: 'HEAD', weight: 10, damageCap: 30, critMultiplier: 3.0 },
  { part: 'TORSO', weight: 40, damageCap: 80 },
  { part: 'LEFT_ARM', weight: 15, damageCap: 25, critMultiplier: 1.5 },
  { part: 'RIGHT_ARM', weight: 15, damageCap: 25, critMultiplier: 1.5 },
  { part: 'LEFT_LEG', weight: 10, damageCap: 30 },
  { part: 'RIGHT_LEG', weight: 10, damageCap: 30 },
];

function freshParts(): Record<string, BodyPartState> {
  return {
    HEAD: { currentHp: 30, maxHp: 30, destroyed: false },
    TORSO: { currentHp: 100, maxHp: 100, destroyed: false },
    LEFT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
    RIGHT_ARM: { currentHp: 30, maxHp: 30, destroyed: false },
    LEFT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
    RIGHT_LEG: { currentHp: 35, maxHp: 35, destroyed: false },
  };
}

// ==========================================
// 场景模拟
// ==========================================
console.log('=== ElysianVTT 要害攻击集成测试 ===\n');

// ---- Scenario A: 要害优先路线 - 完整战斗流程 ----
console.log('[Scenario A] 要害优先 — 普通命中躯干');
{
  const parts = freshParts();
  const critConfig: CritConfig = { range: 18, defaultMultiplier: 2.0 };

  // 战士攻击: 基础伤害25, d100=45(躯干), d20=10(未暴击)
  const hit = BodyPartResolver.resolveHit(25, standardHitTable, 45, 10, critConfig, parts);
  assertEqual(hit.part as string, 'TORSO', '命中躯干');
  assert(!hit.isCrit, '未暴击');
  assertEqual(hit.cappedDamage, 25, '伤害25 < 躯干上限80 → 无截断');

  const partRes = BodyPartResolver.applyPartDamage(parts, hit.part, hit.cappedDamage);
  assertEqual(partRes.newHp, 75, '躯干HP: 100-25=75');
  assert(!partRes.destroyed, '躯干未破坏');
}

// ---- Scenario B: 要害优先 — 暴击头部 + 截断 ----
console.log('\n[Scenario B] 要害优先 — 暴击头部 + 伤害截断');
{
  const parts = freshParts();
  const critConfig: CritConfig = { range: 17, defaultMultiplier: 2.0 };

  // 盗贼攻击: 基础伤害15, d100=3(头部), d20=19(暴击!)
  const hit = BodyPartResolver.resolveHit(15, standardHitTable, 3, 19, critConfig, parts);
  assertEqual(hit.part as string, 'HEAD', '命中头部');
  assert(hit.isCrit, 'd20=19 ≥ 17 → 暴击!');
  assertEqual(hit.critMultiplier, 3.0, '头部专属倍率 3.0');
  assertEqual(hit.rawDamage, 45, '15 × 3.0 = 45');
  assertEqual(hit.cappedDamage, 30, '45 > 头部上限30 → 截断至30');
  assertEqual(hit.overflowDamage, 15, '溢出15');

  const partRes = BodyPartResolver.applyPartDamage(parts, hit.part, hit.cappedDamage);
  assertEqual(partRes.newHp, 0, '头部HP 30→0');
  assert(partRes.destroyed, '头部被破坏!');
}

// ---- Scenario C: 要害优先 — 已破坏部位打空 ----
console.log('\n[Scenario C] 要害优先 — 后续攻击命中已破坏部位');
{
  const parts = freshParts();
  parts.HEAD.destroyed = true;
  parts.HEAD.currentHp = 0;
  const critConfig: CritConfig = { range: 18, defaultMultiplier: 2.0 };

  // 攻击命中已破坏的头部 → 打空
  const hit = BodyPartResolver.resolveHit(50, standardHitTable, 5, 12, critConfig, parts);
  assertEqual(hit.cappedDamage, 0, '头部已破坏 → 伤害=0');
  assert(hit.partDestroyed, '标记打空');
}

// ---- Scenario D: 损伤优先 — 无部位判定 ----
console.log('\n[Scenario D] 损伤优先 — 全额伤害, 无部位参与');
{
  // 火焰风暴: 固定伤害25, 不经过部位系统
  const rawDamage = 25;
  const dr = 5;
  const effective = Math.max(0, rawDamage - dr);
  assertEqual(effective, 20, '损伤路线: 25-5=20 (仅DR减免)');
}

// ---- Scenario E: 连续攻击双臂 → 逐个破坏 ----
console.log('\n[Scenario E] 连续攻击手臂 → 逐个破坏');
{
  const parts = freshParts();
  const critConfig: CritConfig = { range: 20, defaultMultiplier: 1.5 };

  // 第一击: 命中左臂, 伤害30 → 截断至25, 剩余HP=5
  const h1 = BodyPartResolver.resolveHit(30, standardHitTable, 55, 10, critConfig, parts);
  assertEqual(h1.part as string, 'LEFT_ARM', '命中左臂');
  assertEqual(h1.cappedDamage, 25, '截断至上限25');

  const r1 = BodyPartResolver.applyPartDamage(parts, h1.part, h1.cappedDamage);
  assertEqual(r1.newHp, 5, '左臂HP: 30-25=5');
  assert(!r1.destroyed, '左臂未破坏(HP>0)');

  // 第二击: 再次命中左臂, 伤害10 → 未超上限, HP归零
  const h2 = BodyPartResolver.resolveHit(10, standardHitTable, 55, 12, critConfig, parts);
  assertEqual(h2.part as string, 'LEFT_ARM', '再次命中左臂');
  assertEqual(h2.cappedDamage, 10, '未超上限');

  const r2 = BodyPartResolver.applyPartDamage(parts, h2.part, h2.cappedDamage);
  assertEqual(r2.newHp, 0, '左臂HP归零');
  assert(r2.destroyed, '左臂被破坏!');
  assert(parts.LEFT_ARM.destroyed, 'state标记破坏');

  // 第三击: 命中已破坏左臂 → 打空
  const h3 = BodyPartResolver.resolveHit(40, standardHitTable, 55, 15, critConfig, parts);
  assertEqual(h3.cappedDamage, 0, '左臂已破坏 → 打空');
}

// ---- Scenario F: CRIT_SUCCESS 标签强暴击 ----
console.log('\n[Scenario F] CRIT_SUCCESS 标签强制暴击');
{
  const parts = freshParts();
  const critConfig: CritConfig = { range: 20, defaultMultiplier: 2.0 };

  // d20=5 (远小于20), 但 CRIT_SUCCESS 标签触发暴击
  const hit = BodyPartResolver.resolveHit(20, standardHitTable, 40, 5, critConfig, parts, ['CRIT_SUCCESS']);
  assert(hit.isCrit, 'CRIT_SUCCESS 标签 → 强暴击');
  assertEqual(hit.rawDamage, 40, '20 × 2.0 = 40 (躯干默认倍率)');
}

// ---- Scenario G: CRIT_FAILURE 不阻止自然暴击 ----
console.log('\n[Scenario G] CRIT_FAILURE 不阻止自然暴击');
{
  const parts = freshParts();
  const critConfig: CritConfig = { range: 18, defaultMultiplier: 2.0 };

  const hit = BodyPartResolver.resolveHit(15, standardHitTable, 50, 19, critConfig, parts, ['CRIT_FAILURE']);
  assert(hit.isCrit, 'd20=19 ≥ 18 → 自然暴击 (CRIT_FAILURE 不阻止)');
  assertEqual(hit.critMultiplier, 2.0, '躯干默认暴击倍率');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`结果: ${passCount}/${testCount} 通过`);
if (passCount === testCount) console.log('✅ 所有要害攻击测试通过!');
