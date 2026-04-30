// ==========================================
// 前端工具函数单元测试
// 覆盖: setNestedProperty (深层路径赋值)
// ==========================================

function setNestedProperty(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (current[key] === undefined || current[key] === null) {
            current[key] = {};
        }
        current = current[key];
    }
    
    current[keys[keys.length - 1]] = value;
}

// ==========================================
// 测试工具
// ==========================================
let testCount = 0;
let passCount = 0;

function assert(condition: boolean, label: string): void {
    testCount++;
    if (condition) {
        passCount++;
        console.log(`  ✅ ${label}`);
    } else {
        console.error(`  ❌ FAIL: ${label}`);
        process.exitCode = 1;
    }
}

function section(title: string): void {
    console.log(`\n📋 ${title}`);
}

// ==========================================
// 测试: setNestedProperty
// ==========================================

section('setNestedProperty (深层路径赋值)');

// 1. 一级路径赋值
{
    const obj = { name: 'test' };
    setNestedProperty(obj, 'name', 'updated');
    assert(obj.name === 'updated', '一级路径赋值成功');
}

// 2. 多级路径赋值（存在的路径）
{
    const obj = { a: { b: { c: 1 } } };
    setNestedProperty(obj, 'a.b.c', 42);
    assert(obj.a.b.c === 42, '多级路径赋值成功（已存在）');
}

// 3. 多级路径赋值（新建路径）
{
    const obj = { x: {} };
    setNestedProperty(obj, 'x.y.z', 'new');
    assert(obj.x.y.z === 'new', '多级路径赋值成功（新建路径）');
}

// 4. 深层创建中间对象
{
    const obj = {};
    setNestedProperty(obj, 'level1.level2.level3.value', 100);
    assert(obj.level1.level2.level3.value === 100, '深层创建中间对象成功');
    assert(typeof obj.level1 === 'object', '中间路径自动创建为对象');
}

// 5. 覆盖已有值
{
    const obj = { data: { hp: 100, mp: 50 } };
    setNestedProperty(obj, 'data.hp', 75);
    assert(obj.data.hp === 75, '覆盖已有值成功');
    assert(obj.data.mp === 50, '其他值不受影响');
}

// 6. 设置 null 值
{
    const obj = { status: 'active' };
    setNestedProperty(obj, 'status', null);
    assert(obj.status === null, '正确设置 null 值');
}

// 7. 设置布尔值
{
    const obj = { flags: { enabled: false } };
    setNestedProperty(obj, 'flags.enabled', true);
    assert(obj.flags.enabled === true, '正确设置布尔值');
}

// 8. 设置数组值
{
    const obj = {};
    setNestedProperty(obj, 'items', [1, 2, 3]);
    assert(Array.isArray(obj.items) && obj.items.length === 3, '正确设置数组值');
}

// 9. 复杂对象路径（模拟游戏实体状态差分）
{
    const entity = {
        id: 'hero-1',
        transform: { coords: { x: 100, y: 200, z: 0 }, facing: 45 },
        resources: { current: { hp: 80, mp: 60 }, max: { hp: 100, mp: 100 } }
    };
    
    setNestedProperty(entity, 'resources.current.hp', 60);
    assert(entity.resources.current.hp === 60, '游戏状态差分：血量更新');
    assert(entity.resources.current.mp === 60, '游戏状态差分：其他资源不变');
    
    setNestedProperty(entity, 'transform.coords.x', 150);
    assert(entity.transform.coords.x === 150, '游戏状态差分：坐标更新');
    assert(entity.transform.coords.y === 200, '游戏状态差分：Y坐标不变');
}

// ==========================================
// 测试汇总
// ==========================================
console.log(`\n${'='.repeat(50)}`);
console.log(`✅ 通过: ${passCount}/${testCount}`);
console.log(`❌ 失败: ${testCount - passCount}`);
console.log(`${'='.repeat(50)}\n`);

if ((testCount - passCount) > 0) {
    process.exit(1);
}
