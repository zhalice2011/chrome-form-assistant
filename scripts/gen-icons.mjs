#!/usr/bin/env node
/**
 * 把 public/icons/icon.svg 渲染成 16/32/48/128 PNG。
 * 依赖系统命令 `magick`（ImageMagick 7+）。
 *
 * 运行：pnpm gen:icons
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_SVG = resolve(ROOT, 'public/icons/icon.svg');
const OUT_DIR = resolve(ROOT, 'public/icons');
const SIZES = [16, 32, 48, 128];

function checkMagick() {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
  } catch {
    console.error(
      '[gen-icons] 需要系统命令 `magick`（ImageMagick 7+）。\n' +
        '  macOS:   brew install imagemagick\n' +
        '  Ubuntu:  sudo apt install imagemagick',
    );
    process.exit(1);
  }
}

function main() {
  if (!existsSync(SRC_SVG)) {
    console.error(`[gen-icons] 源文件不存在：${SRC_SVG}`);
    process.exit(1);
  }
  checkMagick();
  mkdirSync(OUT_DIR, { recursive: true });

  for (const size of SIZES) {
    const outFile = resolve(OUT_DIR, `icon-${size}.png`);
    // -background none 保持透明、-density 提高 SVG 渲染分辨率防糊
    execFileSync(
      'magick',
      [
        '-background',
        'none',
        '-density',
        String(size * 4),
        SRC_SVG,
        '-resize',
        `${size}x${size}`,
        outFile,
      ],
      { stdio: 'inherit' },
    );
    console.log(`[gen-icons] ✓ ${outFile}`);
  }
}

main();
