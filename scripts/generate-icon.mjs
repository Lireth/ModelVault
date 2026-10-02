import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

/**
 * 应用图标生成脚本（D7）：产出 build/icon.ico（256×256，PNG 压缩格式 ICO）。
 * 设计：「模匣 / 模型保险箱」隐喻——深色圆角底板上的白色保险箱轮廓，
 * 中心为强调色（品牌蓝）转盘。512×512 渲染后 2× 盒式滤波降采样抗锯齿。
 * 重新生成：node scripts/generate-icon.mjs
 */

const SIZE = 256 // ico 逻辑尺寸
const SS = 2 // 超采样倍率
const N = SIZE * SS // 渲染尺寸 512

/* ---------------- 几何与配色 ---------------- */

// 背景垂直渐变（深蓝灰）
const BG_TOP = [38, 44, 56]
const BG_BOTTOM = [22, 26, 34]
// 前景
const FG = [242, 245, 249] // 白色箱体轮廓 / 转盘环
const ACCENT = [79, 156, 249] // 品牌蓝转盘核心（与 UI --accent 一致）

/** 点 (x,y) 是否在圆角矩形内 */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.max(x0 + r, Math.min(x, x1 - r))
  const cy = Math.max(y0 + r, Math.min(y, y1 - r))
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** 点 (x,y) 是否在圆环内（半径 [R - t, R]） */
function inRing(x, y, cx, cy, R, t) {
  const dx = x - cx
  const dy = y - cy
  const d2 = dx * dx + dy * dy
  const outer = R
  const inner = R - t
  return d2 <= outer * outer && d2 >= inner * inner
}

/**
 * 计算渲染坐标下像素颜色（RGBA，预乘前的直通色）。
 * @returns {[number, number, number, number]}
 */
function shade(x, y) {
  // 背景圆角底板
  if (!inRoundRect(x, y, 0, 0, N, N, 112)) return [0, 0, 0, 0]
  const t = y / N
  const bg = [
    Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
    Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
    Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
  ]
  // 保险箱箱体轮廓：白色圆角方框
  const boxR = 46
  const boxStroke = 24
  if (
    inRoundRect(x, y, 128, 128, N - 128, N - 128, boxR) &&
    !inRoundRect(x, y, 128 + boxStroke, 128 + boxStroke, N - 128 - boxStroke, N - 128 - boxStroke, boxR)
  ) {
    return [...FG, 255]
  }
  // 转盘：白色圆环 + 品牌蓝核心
  if (inRing(x, y, N / 2, N / 2, 60, 13)) return [...FG, 255]
  const dx = x - N / 2
  const dy = y - N / 2
  if (dx * dx + dy * dy <= 28 * 28) return [...ACCENT, 255]
  return [...bg, 255]
}

/* ---------------- 渲染 + 降采样 ---------------- */

const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [pr, pg, pb, pa] = shade(x * SS + sx + 0.5, y * SS + sy + 0.5)
        r += pr
        g += pg
        b += pb
        a += pa
      }
    }
    const n = SS * SS
    const o = (y * SIZE + x) * 4
    rgba[o] = Math.round(r / n)
    rgba[o + 1] = Math.round(g / n)
    rgba[o + 2] = Math.round(b / n)
    rgba[o + 3] = Math.round(a / n)
  }
}

/* ---------------- PNG 编码（RGBA8） ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(rgbaBuf, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  // 逐行 filter 0 前置字节
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgbaBuf.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------------- ICO 容器（PNG 压缩条目，Vista+ 支持） ---------------- */

const png = encodePNG(rgba, SIZE)
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // count
const entry = Buffer.alloc(16)
entry[0] = 0 // width: 0 表示 256
entry[1] = 0 // height
entry[2] = 0 // 调色板数
entry[3] = 0 // reserved
entry.writeUInt16LE(1, 4) // planes
entry.writeUInt16LE(32, 6) // bpp
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(22, 12) // 数据偏移 = 6 + 16

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.ico', Buffer.concat([header, entry, png]))
console.log('已生成 build/icon.ico（256×256）')
