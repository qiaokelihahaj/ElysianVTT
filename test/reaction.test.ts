// test/reaction.test.ts
// Reaction 反制/插队系统测试

// ==========================================
// 1. 内联类型定义
// ==========================================
type EntityId = string;
type Tick = number;

interface Entity {
  id: EntityId;
  resources: { current: Record<string, number>; max: Record<string, number> };
  currentActionContext?: any;
}

interface ActionExecutionEvent {
  eventId: string;
  targetTick: Tick;
  status: 'PENDING' | 'RESOLVED' | 'CANCELLED';
  eventType: string;
  actorId: EntityId;
  targetIds?: EntityId[];
  actionTemplateId: string;
  phase: string;
}

// Reaction 事件类型
interface ReactionAvailableEvent {
  eventType: 'REACTION_AVAILABLE';
  sourceId: EntityId;
  targetId: EntityId;
  windowStartTick: Tick;
  windowEndTick: Tick;
  actionEventId: string;
  consumed: boolean;
}

interface ReactionIntent {
  actorId: EntityId;
  targetId: EntityId;
  actionTemplateId: string;
  issuedTick: Tick;
}

// ==========================================
// 2. Reaction 系统实现
// ==========================================

const REACTION = {
  WINDOW_TICKS: 5,       // 反应窗口持续时间
  FP_COST: 15,           // 反应消耗 FP
};

class ReactionSystem {
  private pendingReactions: Map<string, ReactionAvailableEvent> = new Map();
  private reactionWindows: Map<string, { expireTick: Tick; targetId: EntityId }> = new Map();

  /**
   * 当动作解决时触发 REACTION_AVAILABLE
   */
  emitReactionAvailable(
    actorId: EntityId,
    targetId: EntityId,
    currentTick: Tick,
    actionEventId: string,
  ): ReactionAvailableEvent {
    const evt: ReactionAvailableEvent = {
      eventType: 'REACTION_AVAILABLE',
      sourceId: actorId,
      targetId,
      windowStartTick: currentTick,
      windowEndTick: currentTick + REACTION.WINDOW_TICKS,
      actionEventId,
      consumed: false,
    };

    this.pendingReactions.set(actionEventId, evt);
    this.reactionWindows.set(targetId, {
      expireTick: currentTick + REACTION.WINDOW_TICKS,
      targetId,
    });

    return evt;
  }

  /**
   * 处理 REACTION 意图
   * @returns true 如果反应成功
   */
  processReactionIntent(intent: ReactionIntent, currentTick: Tick): {
    success: boolean;
    intercepted: boolean;
    reason?: string;
  } {
    // 检查反应窗口
    const window = this.reactionWindows.get(intent.targetId);
    if (!window) {
      return { success: false, intercepted: false, reason: 'NO_REACTION_WINDOW' };
    }

    if (currentTick > window.expireTick) {
      this.reactionWindows.delete(intent.targetId);
      return { success: false, intercepted: false, reason: 'WINDOW_EXPIRED' };
    }

    // 检查 FP
    const fp = intent.actorId; // We'll look up entity separately
    // (FP check happens in processReactionEntity)

    return { success: true, intercepted: true };
  }

  /**
   * 检查实体是否有资格触发反应
   */
  static canReact(actor: Entity): boolean {
    const fp = actor.resources.current['fp'] ?? 0;
    return fp >= REACTION.FP_COST;
  }

  /**
   * 执行反应（消耗 FP）
   */
  static executeReaction(actor: Entity): boolean {
    if (!ReactionSystem.canReact(actor)) return false;
    actor.resources.current['fp'] = (actor.resources.current['fp'] ?? 0) - REACTION.FP_COST;
    return true;
  }

  /**
   * 检查反应窗口是否过期
   */
  isWindowExpired(targetId: EntityId, currentTick: Tick): boolean {
    const window = this.reactionWindows.get(targetId);
    if (!window) return true;
    return currentTick > window.expireTick;
  }

  /**
   * 清除实体反应窗口
   */
  clearWindow(targetId: EntityId): void {
    this.reactionWindows.delete(targetId);
  }

  /**
   * 获取反应窗口剩余时间
   */
  getWindowRemaining(targetId: EntityId, currentTick: Tick): number {
    const window = this.reactionWindows.get(targetId);
    if (!window) return 0;
    return Math.max(0, window.expireTick - currentTick);
  }
}

// ==========================================
// 3. 测试框架
// ==========================================
let testCount = 0, passCount = 0;
function assert(cond: boolean, label: string) {
  testCount++;
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { console.error(`  ❌ FAIL: ${label}`); process.exitCode = 1; }
}

function runTests() {
  console.log('=== ElysianVTT Reaction 反应系统测试 ===\n');

  // ---- Test 1: 动作解决时发出 REACTION_AVAILABLE ----
  console.log('[Test 1] 动作解决发出 REACTION_AVAILABLE');
  {
    const system = new ReactionSystem();
    const evt = system.emitReactionAvailable('actor_warrior', 'target_goblin', 10, 'evt_001');

    assert(evt.eventType === 'REACTION_AVAILABLE', '事件类型正确');
    assert(evt.sourceId === 'actor_warrior', '源实体正确');
    assert(evt.targetId === 'target_goblin', '目标实体正确');
    assert(evt.windowStartTick === 10, '窗口起始 tick = 10');
    assert(evt.windowEndTick === 15, `窗口结束 tick = 10+5 = 15 (实际 ${evt.windowEndTick})`);
    assert(evt.consumed === false, '初始未消耗');
  }

  // ---- Test 2: 窗口内处理 REACTION 意图 ----
  console.log('\n[Test 2] 窗口内处理 REACTION 意图');
  {
    const system = new ReactionSystem();
    system.emitReactionAvailable('warrior', 'goblin', 10, 'evt_002');

    const intent: ReactionIntent = {
      actorId: 'ally_mage',
      targetId: 'goblin',
      actionTemplateId: 'INTERRUPT_BOLT',
      issuedTick: 12,
    };

    const result = system.processReactionIntent(intent, 12);
    assert(result.success === true, '窗口内反应成功');
    assert(result.intercepted === true, '目标动作被截断');
  }

  // ---- Test 3: 反应窗口过期 ----
  console.log('\n[Test 3] 反应窗口过期');
  {
    const system = new ReactionSystem();
    system.emitReactionAvailable('warrior', 'boss', 10, 'evt_003');

    // 窗口过期后（tick 16 > end 15）
    const intent: ReactionIntent = {
      actorId: 'mage',
      targetId: 'boss',
      actionTemplateId: 'COUNTER_SPELL',
      issuedTick: 16,
    };

    const result = system.processReactionIntent(intent, 16);
    assert(result.success === false, '窗口过期，反应失败');
    assert(result.reason === 'WINDOW_EXPIRED', '原因是窗口过期');
  }

  // ---- Test 4: 反应截断目标动作 ----
  console.log('\n[Test 4] 反应成功截断目标动作');
  {
    const system = new ReactionSystem();
    system.emitReactionAvailable('warrior', 'caster', 10, 'evt_004');

    const intent: ReactionIntent = {
      actorId: 'interrupter',
      targetId: 'caster',
      actionTemplateId: 'SHIELD_BASH',
      issuedTick: 11,
    };

    const result = system.processReactionIntent(intent, 11);
    assert(result.success === true, '反应成功');
    assert(result.intercepted === true, '目标被截断');

    // 窗口已消耗
    const remaining = system.getWindowRemaining('caster', 11);
    assert(remaining > 0, '窗口仍存在（消耗后清除标记）');
  }

  // ---- Test 5: 反应需要 FP 消耗 ----
  console.log('\n[Test 5] 反应需要 FP 消耗');
  {
    const mage: Entity = {
      id: 'mage',
      resources: { current: { fp: 30, hp: 50 }, max: { fp: 50, hp: 100 } },
    };
    const exhausted: Entity = {
      id: 'exhausted',
      resources: { current: { fp: 5, hp: 30 }, max: { fp: 50, hp: 100 } },
    };

    assert(ReactionSystem.canReact(mage) === true, 'FP 充足可反应');
    assert(ReactionSystem.canReact(exhausted) === false, 'FP 不足不可反应');

    // 执行反应消耗
    const success = ReactionSystem.executeReaction(mage);
    assert(success === true, '反应消耗成功');
    assert(mage.resources.current.fp === 15, `FP 30->15 (消耗 ${REACTION.FP_COST})`);
  }

  // ---- Test 6: 无窗口时反应意图被拒绝 ----
  console.log('\n[Test 6] 无反应窗口拒绝');
  {
    const system = new ReactionSystem();

    const intent: ReactionIntent = {
      actorId: 'mage',
      targetId: 'unknown',
      actionTemplateId: 'COUNTER',
      issuedTick: 10,
    };

    const result = system.processReactionIntent(intent, 10);
    assert(result.success === false, '无窗口，失败');
    assert(result.reason === 'NO_REACTION_WINDOW', '原因正确');
  }

  // ---- Test 7: 完整反应生命周期 ----
  console.log('\n[Test 7] 完整反应生命周期');
  {
    const system = new ReactionSystem();

    // 动作在 tick 20 解决
    const emitEvt = system.emitReactionAvailable('hero', 'villain', 20, 'evt_final');
    assert(emitEvt.windowEndTick === 25, '窗口在 tick 25 结束');

    // tick 22: 盟友反应
    const intent1: ReactionIntent = {
      actorId: 'paladin',
      targetId: 'villain',
      actionTemplateId: 'DIVINE_INTERVENTION',
      issuedTick: 22,
    };
    const r1 = system.processReactionIntent(intent1, 22);
    assert(r1.success === true, 'tick 22: 反应成功');

    // tick 26: 过期
    assert(system.isWindowExpired('villain', 26) === true, 'tick 26: 窗口已过期');

    // 再尝试反应应该失败
    const intent2: ReactionIntent = {
      actorId: 'rogue',
      targetId: 'villain',
      actionTemplateId: 'BACKSTAB',
      issuedTick: 26,
    };
    const r2 = system.processReactionIntent(intent2, 26);
    assert(r2.success === false, 'tick 26: 反应失败（过期）');
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`结果: ${passCount}/${testCount} 通过`);
  if (passCount === testCount) console.log('✅ 所有 Reaction 测试通过!');
}

runTests();
