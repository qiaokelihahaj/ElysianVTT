const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
  cyan: '\x1b[36m'
};

const MARK = {
  ok: `${COLORS.green}[√]${COLORS.reset}`,
  fail: `${COLORS.red}[x]${COLORS.reset}`,
  warn: `${COLORS.yellow}[!]${COLORS.reset}`
};

let errorCount = 0;

function printHeader(title) {
  console.log(`\n${COLORS.cyan}=== ${title} ===${COLORS.reset}`);
}

function assertCommand(cmd, name) {
  try {
    const version = execSync(`${cmd} --version`, { stdio: 'pipe' }).toString().trim();
    console.log(`${MARK.ok} ${name} 已安装: ${version}`);
  } catch (e) {
    console.log(`${MARK.fail} ${name} 未安装或无法访问`);
    errorCount++;
  }
}

function assertFile(filePath, desc) {
  const fullPath = path.join(__dirname, filePath);
  if (fs.existsSync(fullPath)) {
    console.log(`${MARK.ok} ${desc} (${filePath})`);
  } else {
    console.log(`${MARK.fail} 缺失: ${desc} (${filePath})`);
    errorCount++;
  }
}

function assertPackageJson(pkgPath, expectedName, requiredDeps = []) {
  const fullPath = path.join(__dirname, pkgPath);
  if (!fs.existsSync(fullPath)) {
    console.log(`${MARK.fail} 缺失: package.json (${pkgPath})`);
    errorCount++;
    return;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (pkg.name !== expectedName) {
      console.log(`${MARK.fail} 包名不匹配: 期望 '${expectedName}', 实际为 '${pkg.name}'`);
      errorCount++;
    } else {
      console.log(`${MARK.ok} 包名验证通过: ${pkg.name}`);
    }

    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    requiredDeps.forEach(dep => {
      if (allDeps[dep]) {
        console.log(`${MARK.ok} 依赖包含: ${dep}`);
      } else {
        console.log(`${MARK.fail} 缺失依赖: ${dep} in ${pkgPath}`);
        errorCount++;
      }
    });
  } catch (e) {
    console.log(`${MARK.fail} 解析失败: ${pkgPath}`);
    errorCount++;
  }
}

// ---------------- 执行验证 ----------------

console.log(`${COLORS.cyan}开始执行 ElysianVTT 环境与脚手架审查...${COLORS.reset}`);

printHeader("1. 系统环境与全局工具");
assertCommand('node', 'Node.js');
assertCommand('pnpm', 'pnpm');
assertCommand('docker', 'Docker');

printHeader("2. Monorepo 根目录配置");
assertFile('pnpm-workspace.yaml', 'pnpm 工作区配置');
assertFile('.gitignore', 'Git 忽略配置');
assertFile('docker-compose.yml', 'Docker 容器编排配置');

printHeader("3. Shared 包结构 (@hard-vtt/shared)");
assertPackageJson('packages/shared/package.json', '@hard-vtt/shared', ['typescript']);
assertFile('packages/shared/tsconfig.json', 'Shared TS 编译配置');

printHeader("4. Backend 包结构 (@hard-vtt/backend)");
assertPackageJson('packages/backend/package.json', '@hard-vtt/backend', [
  '@hard-vtt/shared',
  'express',
  'socket.io',
  'prisma',
  '@prisma/client'
]);
assertFile('packages/backend/prisma/schema.prisma', 'Prisma Schema 文件');
assertFile('packages/backend/Dockerfile.dev', 'Backend 本地开发 Dockerfile');

printHeader("5. Frontend 包结构 (@hard-vtt/frontend)");
assertPackageJson('packages/frontend/package.json', '@hard-vtt/frontend', [
  '@hard-vtt/shared',
  'pixi.js',
  'zustand',
  'tailwindcss',
  'socket.io-client'
]);
assertFile('packages/frontend/vite.config.ts', 'Vite 配置文件');
assertFile('packages/frontend/tailwind.config.js', 'Tailwind 配置文件');
assertFile('packages/frontend/Dockerfile.dev', 'Frontend 本地开发 Dockerfile');

console.log('\n----------------------------------------');
if (errorCount === 0) {
  console.log(`${COLORS.green}✅ 验证通过！Monorepo 环境、依赖链接与脚手架均已准备就绪。${COLORS.reset}`);
} else {
  console.log(`${COLORS.red}❌ 验证失败！发现 ${errorCount} 处环境或配置问题，请向上检查日志并修复。${COLORS.reset}`);
}