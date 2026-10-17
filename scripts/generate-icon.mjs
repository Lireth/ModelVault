import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'

/**
 * 应用图标生成脚本（D7）：读取 build/icon.png（源图，建议 512×512 以上），
 * 缩放出多尺寸（16–256）后打包为 build/icon.ico（PNG 压缩条目，Vista+ 支持）。
 * 支持源图格式：8-bit、非隔行、灰度(0)/RGB(2)/RGBA(6) PNG。
 * 重新生成：node scripts/generate-icon.mjs
 */

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const SOURCE = 'build/icon.png'
const TARGET = 'build/icon.ico'

/* ---------------- PNG 解码（8-bit 非隔行，color type 0/2/6） ---------------- */

/** 校验并解析 chunk 流，返回 { width, height, colorType, idat } */
function parsePNG(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('不是有效的 PNG 文件')
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  let pos = 8
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8)
        throw new Error(`不支持的位深 ${data[8]}（仅支持 8-bit）`)
      colorType = data[9]
      if (![0, 2, 6].includes(colorType))
        throw new Error(`不支持的颜色类型 ${colorType}（仅支持灰度/RGB/RGBA）`)
      if (data[12] !== 0) throw new Error('不支持隔行扫描（interlace）PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (!width || !height || idat.length === 0)
    throw new Error('PNG 缺少 IHDR/IDAT 数据')
  return { width, height, colorType, idat: Buffer.concat(idat) }
}

/** Paeth 预测器（PNG filter type 4） */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** 解码为 RGBA8 缓冲 */
function decodePNG(buf) {
  const { width, height, colorType, idat } = parsePNG(buf)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const stride = width * channels
  const raw = inflateSync(idat)
  if (raw.length !== (stride + 1) * height)
    throw new Error('PNG 像素数据长度不符')

  const rgba = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    const filter = raw[rowStart]
    raw.copy(line, 0, rowStart + 1, rowStart + 1 + stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff
      line[x] = v
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      rgba[o] = colorType === 0 ? line[x] : line[x * channels]
      rgba[o + 1] =
        colorType === 0 ? line[x] : line[x * channels + (channels > 1 ? 1 : 0)]
      rgba[o + 2] =
        colorType === 0 ? line[x] : line[x * channels + (channels > 1 ? 2 : 0)]
      rgba[o + 3] = colorType === 6 ? line[x * channels + 3] : 255
    }
    line.copy(prev)
  }
  return { rgba, width, height }
}

/* ---------------- 盒式降采样（面积加权平均，抗锯齿） ---------------- */

function resize(rgba, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = (dy * sh) / dh
    const sy1 = ((dy + 1) * sh) / dh
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = (dx * sw) / dw
      const sx1 = ((dx + 1) * sw) / dw
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let area = 0
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
        if (wy <= 0) continue
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0)
          if (wx <= 0) continue
          const w = wx * wy
          const o = (sy * sw + sx) * 4
          r += rgba[o] * w
          g += rgba[o + 1] * w
          b += rgba[o + 2] * w
          a += rgba[o + 3] * w
          area += w
        }
      }
      const o = (dy * dw + dx) * 4
      out[o] = Math.round(r / area)
      out[o + 1] = Math.round(g / area)
      out[o + 2] = Math.round(b / area)
      out[o + 3] = Math.round(a / area)
    }
  }
  return out
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
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------------- ICO 容器（PNG 压缩条目，Vista+ 支持） ---------------- */

const { rgba, width, height } = decodePNG(readFileSync(SOURCE))
const pngs = SIZES.map((size) => ({
  size,
  png: encodePNG(resize(rgba, width, height, size, size), size),
}))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(pngs.length, 4) // count
const entries = []
let offset = 6 + 16 * pngs.length
for (const { size, png } of pngs) {
  const entry = Buffer.alloc(16)
  const dim = size >= 256 ? 0 : size // 0 表示 256
  entry[0] = dim // width
  entry[1] = dim // height
  entry[2] = 0 // 调色板数
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(offset, 12)
  entries.push(entry)
  offset += png.length
}

mkdirSync('build', { recursive: true })
writeFileSync(
  TARGET,
  Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]),
)
console.log(
  `已生成 ${TARGET}（${pngs.map((p) => p.size).join('/')}，源图 ${width}×${height}）`,
)
